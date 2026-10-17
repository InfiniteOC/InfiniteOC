// Low effort should not be told to deliberate. Before a request leaves, this hook swaps the
// depth-oriented guidance for the lean contract and drops the blocks that cause overthinking.
// Written to packages/core/src/plugin/infiniteoc-effort.ts by mods/effort.
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { effortTier, rewriteLowEffort } from "../infiniteoc/effort-lib.js"
import { infiniteocGuidance } from "../infiniteoc/guidance.js"

export const Plugin = define({
  id: "infiniteoc.effort",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.session.hook("context", (event) => {
      if (effortTier(event.model.variant) !== "low") return Effect.void
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
