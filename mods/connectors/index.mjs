import { readFile } from "node:fs/promises"

const file = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")
const TUI = "packages/tui/src/component"

// connectors.mjs imports the settings store and catalog by their paths in this repository (the launcher's
// `infiniteoc connect` uses it as is); the TUI copy gets the names they have next to it in component/.
export function relink(source) {
  const out = source
    .replace('from "../infiniteoc/settings/settings-store.mjs"', 'from "./settings-store.mjs"')
    .replace('from "./catalog.mjs"', 'from "./connectors-catalog.mjs"')
  if (/from "\.\.\/|from "\.\/catalog\.mjs"/.test(out)) throw new Error("connectors: unmapped import in connectors.mjs")
  return out
}

const COMMAND_ANCHOR = '        slash: { name: "mcps" },\n        run: () => {\n          dialog.replace(() => <DialogMcp />)\n        },\n      },\n'
const COMMAND = `      {
        name: "infiniteoc.apps",
        title: "Apps: connect GitHub, Google, Cloudflare, Discord, ...",
        category: "Agent",
        slash: { name: "apps", aliases: ["connectors"] },
        run: () => {
          dialog.replace(() => <DialogApps />)
        },
      },
`

export default {
  id: "connectors",
  version: "1.0.0",
  async setup(api) {
    // mods/infiniteoc writes settings-store.mjs and dialog-infiniteoc.tsx (SecretPrompt) into component/ first.
    await api.write(`${TUI}/connectors-catalog.mjs`, await file("catalog.mjs"))
    await api.write(`${TUI}/connectors-lib.mjs`, relink(await file("connectors.mjs")))
    await api.write(`${TUI}/dialog-apps.tsx`, await file("dialog.tsx"))
    await api.patchExact("packages/tui/src/app.tsx", 'import { DialogMcp } from "./component/dialog-mcp"\n', 'import { DialogMcp } from "./component/dialog-mcp"\nimport { DialogApps } from "./component/dialog-apps"\n')
    await api.patchExact("packages/tui/src/app.tsx", COMMAND_ANCHOR, COMMAND_ANCHOR + COMMAND)
  },
}
