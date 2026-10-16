import { readFile } from "node:fs/promises"

const file = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")
const CORE = "packages/core/src/plugin"
const MARKER = "// infiniteoc:guidance-extensions"

export const guidance = `[Projects]
Something new the user wants built (an app, game, site, tool) that does not belong in the current directory: project {action: "create", name, template?} makes it in the InfiniteOC projects folder and moves this session there; continue the work in the next step. project {action: "list"} / {action: "open", name} finds and switches to an existing one. Stay in the current directory when the request is about it.`

function replace(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`projects: expected one source anchor: ${label}`)
  if (source.includes(after)) throw new Error(`projects: already applied: ${label}`)
  return source.replace(before, () => after)
}

export default {
  id: "projects",
  version: "1.0.0",
  async setup(api) {
    await api.write(`${CORE}/infiniteoc-projects-lib.mjs`, await file("lib.mjs"))
    await api.write(`${CORE}/infiniteoc-projects.ts`, await file("plugin.ts"))
    await api.patch(`${CORE}/internal.ts`, (source) => {
      source = replace(source, 'import { PlanPlugin } from "./plan.js"', 'import { PlanPlugin } from "./plan.js"\nimport * as InfiniteocProjects from "./infiniteoc-projects.js"', "plan import")
      return replace(source, "  PlanPlugin.Plugin,\n", "  PlanPlugin.Plugin,\n  InfiniteocProjects.Plugin,\n", "plugin list")
    })
    // mods/infiniteoc writes the guidance file with this marker; this mod must be listed after it.
    await api.patch("packages/core/src/infiniteoc/guidance.ts", (source) =>
      replace(source, MARKER, `infiniteocGuidance.build.push(${JSON.stringify(guidance)})\n${MARKER}`, "guidance marker"),
    )
  },
}
