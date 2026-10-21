import { readFile } from "node:fs/promises"

// Pure replace-once helper: fail closed when upstream or an earlier mod changed the anchor.
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`safe-guard: expected one source anchor: ${before}`)
  return source.replace(before, () => after)
}

export const guidance = `[Safety] Protected paths (env, lockfiles, migrations) ask first; secrets to tracked files refused; delete/force-push/reset/publish shells always ask. "Refused"/"Blocked" is a gate: change approach, do not retry the same call or route around it (e.g. via shell). Match \`git log -n 5 --format=%s\` style before commit. No push/PR unless asked. On a diff-budget note, stop widening unless the user asked for that much, and check with them.`

// mods/infiniteoc writes packages/core/src/infiniteoc/guidance.ts with this extension marker.
const marker = "// infiniteoc:guidance-extensions"

export default {
  id: "safe-guard",
  version: "1.0.0",
  async setup(api) {
    const file = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")
    await api.write("packages/core/src/plugin/infiniteoc-safety.ts", await file("safety.ts"))
    await api.write("packages/core/src/plugin/infiniteoc-gitflow.ts", await file("gitflow.ts"))
    await api.patch("packages/core/src/plugin/internal.ts", (source) => {
      source = replace(source, 'import { PlanPlugin } from "./plan.js"', 'import { PlanPlugin } from "./plan.js"\nimport * as InfiniteocSafety from "./infiniteoc-safety.js"\nimport * as InfiniteocGitflow from "./infiniteoc-gitflow.js"')
      return replace(source, "  PlanPlugin.Plugin,\n", "  PlanPlugin.Plugin,\n  InfiniteocSafety.Plugin,\n  InfiniteocGitflow.Plugin,\n")
    })
    await api.patch("packages/core/src/infiniteoc/guidance.ts", (source) => {
      if (source.includes("[Safety]")) throw new Error("safe-guard: already applied; refusing to duplicate")
      return replace(source, marker, `infiniteocGuidance.build.push(${JSON.stringify(guidance)})\n${marker}`)
    })
  },
}
