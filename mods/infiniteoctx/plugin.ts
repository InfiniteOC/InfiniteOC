// InfiniteOCTX: pages old, bulky tool outputs out of each request and returns them word for word through
// the recall tool. Written to packages/core/src/plugin/infiniteoctx.ts by mods/infiniteoctx; the
// decisions are in infiniteoctx-lib.ts and the per-session store in infiniteoctx-store.ts (both pure).
import { Message, ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { POLICY } from "./infiniteoctx-config.js"
import * as L from "./infiniteoctx-lib.js"
import * as Store from "./infiniteoctx-store.js"

// Side requests that are not the agent loop: they never decide a batch, only replay the session's paging.
const SIDE = new Set(["title", "compaction", "summary"])

type Request = { sessionID: string; messages: Message[]; tools?: Record<string, unknown> }

export const Plugin = define({
  id: "infiniteoc.octx",
  effect: Effect.fn(function* (ctx) {
    // The session's paged set, reloaded when /octx (another process) changes the state file.
    const sessions = new Map<string, { version: number; state: Store.State; paged: Set<string> }>()
    const load = (sessionID: string) => {
      const version = Store.stateVersion(sessionID)
      const cached = sessions.get(sessionID)
      if (cached && cached.version === version) return cached
      const state = Store.readState(sessionID)
      const entry = { version, state, paged: new Set(state.off ? [] : state.paged) }
      sessions.set(sessionID, entry)
      return entry
    }
    try {
      Store.pruneOld()
    } catch {
      // A store that cannot be tidied only keeps old files longer.
    }

    const rebuild = (message: Message, content: unknown[]) => Message.make({ ...message, content: content as Message["content"] })

    // The agent loop decides batches; compaction and side generations only replay the session's paging,
    // so their prompt prefix matches the cache. recall is offered only once something is paged: until then
    // it would be a definition in every request for nothing, and adding it with the first batch costs no
    // extra cache miss.
    const page = (event: Request, decide: boolean) => {
      try {
        const entry = load(event.sessionID)
        if (decide && !entry.state.off) {
          const batch = L.nextBatch(L.candidates(event.messages, entry.paged, POLICY), POLICY)
          if (batch.length > 0) {
            // Outputs are stored before they are marked, so recall can always return what a stub names.
            Store.saveOutputs(event.sessionID, batch)
            const chars = batch.reduce((sum, item) => sum + item.text.length, 0)
            Store.writeState(event.sessionID, { paged: [...entry.state.paged, ...batch.map((item) => item.id)], chars: (entry.state.chars ?? 0) + chars })
          }
        }
        const { paged } = load(event.sessionID)
        L.applyPaging(event.messages, paged, rebuild)
        if (paged.size === 0 && event.tools) delete event.tools[L.RECALL]
        return Effect.void
      } catch (cause) {
        return Effect.logWarning("InfiniteOCTX paging failed; this request is sent in full", { cause })
      }
    }

    yield* ctx.session.hook("context", (event) => page(event, !SIDE.has(event.agent)))
    yield* ctx.session.hook("compaction", (event) => page(event, false))
    yield* ctx.session.hook("generate", (event) => page(event, false))

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: L.RECALL,
          options: { codemode: false },
          description:
            "Return the exact output of an earlier tool call that InfiniteOC paged out of the context to keep it small. The stub left in its place names the id. Use it instead of re-running a tool when you need that output again.",
          input: Schema.Struct({ id: Schema.String.annotate({ description: "The id from the paged-out stub" }) }),
          execute: (input, context) =>
            Effect.try({
              try: () => {
                const text = Store.readOutput(context.sessionID, input.id)
                if (text === undefined) throw new Error(`No paged output with id ${input.id} in this session.`)
                return { content: text }
              },
              catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error), error }),
            }),
        })
      })
      .pipe(Effect.orDie)
  }),
})
