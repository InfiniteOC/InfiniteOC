import { readFile } from "node:fs/promises"
import { guidance } from "./guidance.mjs"

// Anchor checks fail closed on incompatible upstream or sibling-mod revisions.
function replace(source, before, after) {
  if (source.includes(after)) return source
  if (source.split(before).length !== 2) throw new Error(`InfiniteOC auto-loop: expected one source anchor: ${before}`)
  return source.replace(before, after)
}

const GUIDANCE_MARKER = "// infiniteoc:guidance-extensions"
const file = (name) => readFile(new URL(name, import.meta.url), "utf8")

export default {
  id: "auto-loop",
  version: "1.0.0",
  async setup(api) {
    await api.write("packages/core/src/plugin/infiniteoc-auto-logic.ts", await file("./logic.ts"))
    await api.write("packages/core/src/plugin/infiniteoc-auto-project.ts", await file("./project.ts"))
    await api.write("packages/core/src/plugin/infiniteoc-auto.ts", await file("./auto.ts"))
    await api.patch("packages/core/src/plugin/internal.ts", (source) => {
      source = replace(source, 'import { PlanPlugin } from "./plan.js"', 'import { PlanPlugin } from "./plan.js"\nimport * as InfiniteocAuto from "./infiniteoc-auto.js"')
      return replace(source, "  PlanPlugin.Plugin,\n", "  PlanPlugin.Plugin,\n  InfiniteocAuto.Plugin,\n")
    })
    // /goal tests|types|lint: expanded into a goal with the project's detected command. This patches
    // the file mods/infiniteoc wrote, so it must stay listed after that mod.
    await api.patch("packages/core/src/plugin/infiniteoc-goal.ts", (source) => {
      source = replace(source, 'import { Bus } from "../bus.js"', 'import { Bus } from "../bus.js"\nimport { expandGoal } from "./infiniteoc-auto-project.js"')
      return replace(
        source,
        "          return ctx.session\n            .prompt({ ...input.prompt, sessionID: input.sessionID, text: startText(goal), delivery: input.delivery })\n            .pipe(Effect.asVoid)",
        "          return ctx.session.get({ sessionID: input.sessionID }).pipe(\n            Effect.flatMap((session) =>\n              ctx.session.prompt({ ...input.prompt, sessionID: input.sessionID, text: startText(expandGoal(goal, `${session.location.directory}/${session.subpath ?? \"\"}`)), delivery: input.delivery }),\n            ),\n            Effect.asVoid,\n          )",
      )
    })
    // Guidance for the primary agent: the question tool, confidence flags, self-critique, stuck notes.
    await api.patch("packages/core/src/infiniteoc/guidance.ts", (source) =>
      replace(source, GUIDANCE_MARKER, `infiniteocGuidance.build.push(${JSON.stringify(guidance)})\n${GUIDANCE_MARKER}`),
    )
  },
}
