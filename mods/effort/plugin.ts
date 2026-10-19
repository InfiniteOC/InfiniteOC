// Low effort should not be told to deliberate. Before a request leaves, this hook swaps the
// depth-oriented guidance for the lean contract and drops the blocks that cause overthinking.
// A low effort that "auto" picked for one turn gets the contract as a trailing note instead, so a
// tier change between turns does not change the cached system prompt.
// Written to packages/core/src/plugin/infiniteoc-effort.ts by mods/effort.
import { Message } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { lastAuto } from "../infiniteoc/auto-effort.js"
import { effortTier, lowEffortTurnNote, rewriteLowEffort } from "../infiniteoc/effort-lib.js"
import { infiniteocGuidance } from "../infiniteoc/guidance.js"

export const Plugin = define({
  id: "infiniteoc.effort",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.session.hook("context", (event) => {
      if (effortTier(event.model.variant) !== "low") return Effect.void
      const auto = lastAuto.get(event.sessionID)
      if (auto && auto.variant === event.model.variant) {
        const note = Message.system(lowEffortTurnNote(auto.reasons))
        return Effect.sync(() => {
          event.messages.push(note)
        })
      }
      const entries = infiniteocGuidance[event.agent] ?? []
      if (entries.length === 0) return Effect.void
      return Effect.sync(() => {
        event.system = event.system.map((part) => {
          if (!part.text.includes("[InfiniteOC unified workflow") && !part.text.includes("[Deep deliberation]"))
            return part
          return { ...part, text: rewriteLowEffort(part.text, entries) }
        })
      })
    })
  }),
})
