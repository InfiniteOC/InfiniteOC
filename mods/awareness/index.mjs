import { readFile } from "node:fs/promises"

export const guidance = `[Tool awareness]
Custom tools (all codemode:false; batch independent calls in one block, dependent steps sequential). Unsure of shape: tool_guide {tool?} first.
- Specialist tools (agent_display, ui_check, repo_map, trace_lookup, type_lookup, quality checks, ...) load on demand: load_tools {names:[...]}, then call them next step. Their own sections say when to use them.
- Checks: project_checks {} for build/test/lint; run it.
- Manage: infiniteoc {op,target?} for status/mods/check/recipes; state-changing ops return user-run commands.
These add no permissions and change no behavior besides these read-only tools.`

const MARKER = "// infiniteoc:guidance-extensions"

// Anchor checks fail closed on incompatible upstream or sibling-mod revisions.
function replace(source, before, after, label) {
  if (source.includes(after)) throw new Error(`awareness: already applied (${label})`)
  if (source.split(before).length !== 2) throw new Error(`awareness: expected one source anchor: ${label}`)
  return source.replace(before, after)
}

const file = (name) => readFile(new URL(name, import.meta.url), "utf8")

export default {
  id: "awareness",
  version: "1.2.0",
  async setup(api) {
    await api.write("packages/core/src/plugin/infiniteoc-awareness-lib.ts", await file("./lib.ts"))
    await api.write("packages/core/src/plugin/infiniteoc-awareness.ts", await file("./plugin.ts"))
    await api.patch("packages/core/src/plugin/internal.ts", (source) => {
      source = replace(source, 'import { PlanPlugin } from "./plan.js"', 'import { PlanPlugin } from "./plan.js"\nimport * as InfiniteocAwareness from "./infiniteoc-awareness.js"', "plan import")
      return replace(source, "  PlanPlugin.Plugin,\n", "  InfiniteocAwareness.Plugin,\n  PlanPlugin.Plugin,\n", "plugin list")
    })
    // Guidance for the primary agent: explicit tool-call recipes. This patches
    // the file mods/infiniteoc wrote, so it must stay listed after that mod.
    await api.patch("packages/core/src/infiniteoc/guidance.ts", (source) =>
      replace(source, MARKER, `infiniteocGuidance.build.push(${JSON.stringify(guidance)})\n${MARKER}`, "guidance marker"),
    )
  },
}
