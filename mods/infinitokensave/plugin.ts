// InfiniTokenSave: lossless rewriting of each request's tool outputs (see infinitokensave-lib.ts).
// Written to packages/core/src/plugin/infinitokensave.ts by mods/infinitokensave. It runs on the agent
// loop, compaction and side generations alike, so all of them send the same prefix and share the cache.
import { Message } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { shrinkRequest } from "./infinitokensave-lib.js"

const rebuild = (message: Message, content: unknown[]) => Message.make({ ...message, content: content as Message["content"] })

const shrink = (event: { messages: Message[] }) => {
  try {
    shrinkRequest(event.messages, rebuild)
    return Effect.void
  } catch (cause) {
    return Effect.logWarning("InfiniTokenSave failed; this request is sent unchanged", { cause })
  }
}

export const Plugin = define({
  id: "infiniteoc.tokensave",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.session.hook("context", shrink)
    yield* ctx.session.hook("compaction", shrink)
    yield* ctx.session.hook("generate", shrink)
  }),
})
