import { readFile } from "node:fs/promises"

export default {
  id: "health",
  version: "1.0.0",
  async setup(api) {
    await api.write("packages/tui/src/infiniteoc-features/health-store.mjs", await readFile(new URL("./health-store.mjs", import.meta.url), "utf8"))
    api.tui.command({ id: "check", title: "Check free-model health", slash: "health", category: "Diagnostics", source: await readFile(new URL("./command.tsx", import.meta.url), "utf8") })
  },
}