// InfiniteOC session_data: read-only access to any local session. Written to
// packages/core/src/plugin/infiniteoc-sessions.ts by mods/sessions.
// Read-only by construction: list, read and search never write, delete or prompt. Every call is visible in
// the transcript, which is the audit trail.
import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import * as Sessions from "./infiniteoc-sessions-lib.mjs"

export const TOOL = "session_data"

const Input = Schema.Struct({
  action: Schema.Literals(["list", "read", "search"]).annotate({
    description: "list: sessions on this machine, newest first. read: messages of one session. search: full-text over messages.",
  }),
  session: Schema.optionalKey(Schema.String).annotate({ description: "read: a session id (or its unique prefix); list shows them." }),
  project: Schema.optionalKey(Schema.String).annotate({ description: "list: only sessions of this project worktree (absolute path)." }),
  query: Schema.optionalKey(Schema.String).annotate({ description: "list: filter by title/directory. search: the text to find (required there)." }),
  limit: Schema.optionalKey(Schema.Number).annotate({ description: "Max items (default 50, at most 200; search at most 100)." }),
  offset: Schema.optionalKey(Schema.Number).annotate({ description: "read: skip this many messages first." }),
  types: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "read: only these message types, e.g. [\"user\", \"assistant\"]." }),
})

export const Plugin = define({
  id: "infiniteoc.sessions",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: TOOL,
          options: { codemode: false },
          description: [
            "Read any session on this machine (read-only): list sessions, read their messages, search across them.",
            "Use it when the user refers to another conversation, or to resume work from an earlier session without asking the user to paste it.",
            "It never modifies, deletes or prompts any session; the call itself stays visible in this transcript.",
          ].join("\n"),
          input: Input,
          execute: (input: typeof Input.Type) =>
            Effect.gen(function* () {
              if (input.action === "list") return { content: Sessions.formatSessions(yield* Effect.promise(() => Sessions.listSessions({ project: input.project, search: input.query, limit: input.limit }))) }
              if (input.action === "search") {
                if (!input.query?.trim()) return yield* Effect.fail(new ToolFailure({ message: "search needs a query." }))
                return { content: Sessions.formatHits(yield* Effect.promise(() => Sessions.searchMessages(input.query!, { limit: input.limit }))) }
              }
              if (!input.session?.trim()) return yield* Effect.fail(new ToolFailure({ message: "read needs a session id (find it with action \"list\")." }))
              return { content: Sessions.formatMessages(yield* Effect.promise(() => Sessions.readMessages(input.session!, { limit: input.limit, offset: input.offset, types: input.types }))) }
            }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: `session_data: ${error instanceof Error ? error.message : String(error)}`, error })))),
        })
      })
      .pipe(Effect.orDie)
  }),
})
