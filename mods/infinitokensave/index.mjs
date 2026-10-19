import { readFile } from "node:fs/promises"

// Tool outputs are most of a long session's context, re-read on every step: the cheapest token is the
// one a tool never printed. Constant text, so it costs nothing in prompt-cache terms.
export const guidance = `[InfiniTokenSave]
Every tool output stays in the context and is re-read on every later step, so ask tools for what you need, not everything:
- Search first, then read the ranges that matter; do not re-read a file you already read and have not changed.
- Bound command output: quiet flags for installs and builds, | tail -n 40 or a grep for failures on test and build logs, git diff --stat before a full diff, head or -m on searches.
- Do not print what you will not use: no cat of lockfiles, generated or minified files; no verbose flags unless you are debugging with them.
Never trade correctness for brevity: when a decision depends on the full output, get it.`

const MARKER = "// infiniteoc:guidance-extensions"

// Anchor checks fail closed on incompatible upstream revisions.
function replace(source, before, after, label) {
  if (source.includes(after)) throw new Error(`infinitokensave: already applied (${label})`)
  if (source.split(before).length !== 2) throw new Error(`infinitokensave: expected one source anchor: ${label}`)
  return source.replace(before, () => after)
}

const file = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")

// Right after upstream's write tool: before mods/infiniteoctx (paging sees duplicate references, not the
// duplicates) and mods/ctx-context's request snapshot, whichever order the mods are listed in.
export function internalSource(source) {
  source = replace(source, 'import { WarmingPlugin } from "./warming.js"', 'import * as InfiniteocTokensave from "./infinitokensave.js"\nimport { WarmingPlugin } from "./warming.js"', "warming import")
  return replace(source, "  WriteTool.Plugin,\n", "  WriteTool.Plugin,\n  InfiniteocTokensave.Plugin,\n", "plugin list")
}

export function guidanceSource(source) {
  if (source.includes("[InfiniTokenSave]")) throw new Error("infinitokensave: already applied (guidance)")
  // The agents that run tools on their own: the primary agent and the general worker.
  return replace(source, MARKER, `for (const agent of ["build", "general"]) infiniteocGuidance[agent]?.push(${JSON.stringify(guidance)})\n${MARKER}`, "guidance marker")
}

export default {
  id: "infinitokensave",
  version: "1.0.0",
  async setup(api) {
    await api.write("packages/core/src/plugin/infinitokensave-lib.ts", await file("lib.ts"))
    await api.write("packages/core/src/plugin/infinitokensave.ts", await file("plugin.ts"))
    await api.patch("packages/core/src/plugin/internal.ts", internalSource)
    await api.patch("packages/core/src/infiniteoc/guidance.ts", guidanceSource)
  },
}
