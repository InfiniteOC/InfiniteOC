import { readFile } from "node:fs/promises"

// Pure replace-once helper: fail closed when upstream or an earlier mod changed the anchor.
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`safe-guard: expected one source anchor: ${before}`)
  return source.replace(before, () => after)
}

export const guidance = `[Safety] Edits to protected paths (env files, lockfiles, migrations) ask the user first; secrets written to tracked files are refused; shell commands that delete, force-push, reset or publish always ask. A tool result that starts with "Refused" or "Blocked" is a deliberate gate: change your approach, do not retry the same call or route around it (for example by writing the file through the shell). Before committing, read \`git log -n 5 --format=%s\` and match that style. Do not push or open pull requests unless the user asks. When a diff-budget note appears, stop widening the change and check in with the user.`

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
