import { readFile } from "node:fs/promises"

const file = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")
const CORE = "packages/core/src/plugin"
const MARKER = "// infiniteoc:guidance-extensions"

export const guidance = `[Devices]
Your other machines run InfiniteOC too: device {action: "list"|"sessions"|"read"|"open"|"prompt"} works on paired servers and switches between them mid-session (prompt sends work, waits for the result and reports back, so this run keeps local context while alternating devices). Pairing is the user's job (infiniteoc device add); the tool only uses paired devices. open/prompt ask first.`

function replace(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`devices: expected one source anchor: ${label}`)
  if (source.includes(after)) throw new Error(`devices: already applied: ${label}`)
  return source.replace(before, () => after)
}

export default {
  id: "devices",
  version: "1.0.0",
  async setup(api) {
    await api.write(`${CORE}/infiniteoc-devices-lib.mjs`, await file("lib.mjs"))
    await api.write(`${CORE}/infiniteoc-devices.ts`, await file("plugin.ts"))
    await api.patch(`${CORE}/internal.ts`, (source) => {
      source = replace(source, 'import { PlanPlugin } from "./plan.js"', 'import { PlanPlugin } from "./plan.js"\nimport * as InfiniteocDevices from "./infiniteoc-devices.js"', "plan import")
      return replace(source, "  PlanPlugin.Plugin,\n", "  PlanPlugin.Plugin,\n  InfiniteocDevices.Plugin,\n", "plugin list")
    })
    // mods/infiniteoc writes the guidance file with this marker; this mod must be listed after it.
    await api.patch("packages/core/src/infiniteoc/guidance.ts", (source) =>
      replace(source, MARKER, `infiniteocGuidance.build.push(${JSON.stringify(guidance)})\n${MARKER}`, "guidance marker"),
    )
  },
}
