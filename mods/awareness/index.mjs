import { readFile } from "node:fs/promises"

export const guidance = `[Tool awareness]
Custom tools and how to call them (all codemode:false; batch independent calls in one block, dependent steps sequential). When unsure of a shape, call tool_guide {tool?} first.
- Servers: free_port {} before ANY dev server/listener; pass the port as PORT/--port and report the URL. One-off: background + stop when done. Long-lived: tell the user to use /serve.
- Checks: project_checks {} before claiming build/test/lint commands; run what it returns. Secrets: env_diff {} (names only) instead of reading .env; never print values.
- Orient: repo_map {path?,query?} before grepping; trace_lookup {trace} first on pasted errors; type_lookup {name} for installed APIs, never from memory.
- UI: ui_check {target} before + after; design_tokens/component_catalog before writing UI. Tests: mutation_check {file,test_command,line?}; coverage_delta/bench_guard after changes; /testfirst gates edits; prune_scan/license_check for cleanup/vendoring.
- Manage: infiniteoc {op,target?} for status/mods/check and dev recipes; state-changing ops return user-run commands, never self-executed.
These add no permissions and change no behavior besides the three read-only tools.`

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
  version: "1.1.0",
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
