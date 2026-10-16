import { readFile } from "node:fs/promises"

const file = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")
const CORE = "packages/core/src/plugin"
const MARKER = "// infiniteoc:guidance-extensions"

export const guidance = `[Sessions]
Something the user discussed or built before lives in another conversation: session_data {action: "list"|"read"|"search"} reads any session on this machine (read-only: it never modifies, deletes or prompts). Use it instead of asking the user to paste the earlier conversation.`

function replace(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`sessions: expected one source anchor: ${label}`)
  if (source.includes(after)) throw new Error(`sessions: already applied: ${label}`)
  return source.replace(before, () => after)
}

export default {
  id: "sessions",
  version: "1.0.0",
  async setup(api) {
    await api.write(`${CORE}/infiniteoc-sessions-lib.mjs`, await file("lib.mjs"))
    await api.write(`${CORE}/infiniteoc-sessions.ts`, await file("plugin.ts"))
    await api.patch(`${CORE}/internal.ts`, (source) => {
      source = replace(source, 'import { PlanPlugin } from "./plan.js"', 'import { PlanPlugin } from "./plan.js"\nimport * as InfiniteocSessions from "./infiniteoc-sessions.js"', "plan import")
      return replace(source, "  PlanPlugin.Plugin,\n", "  PlanPlugin.Plugin,\n  InfiniteocSessions.Plugin,\n", "plugin list")
    })
    // mods/infiniteoc writes the guidance file with this marker; this mod must be listed after it.
    await api.patch("packages/core/src/infiniteoc/guidance.ts", (source) =>
      replace(source, MARKER, `infiniteocGuidance.build.push(${JSON.stringify(guidance)})\n${MARKER}`, "guidance marker"),
    )
  },
}
