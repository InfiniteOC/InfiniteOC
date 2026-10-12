import { readFile } from "node:fs/promises"

export default {
  id: "clearall",
  version: "2.1.0",
  async setup(api) {
    api.tui.command({
      id: "close-all-tabs",
      title: "Close all session tabs (keep saved sessions)",
      category: "Session",
      slash: "clearall",
      source: await readFile(new URL("./command.tsx", import.meta.url), "utf8"),
    })
  },
}
