// session-import: continue Claude Code and Antigravity CLI sessions in
// InfiniteOC. Foreign transcripts are converted to ordinary sessions through
// the backend's session-import API, so the agent continues with full history.
// This mod is a TUI browser plus a standalone CLI (import.mjs); it writes no
// upstream source and registers no hooks.
import { readFile } from "node:fs/promises"

export default {
  id: "session-import",
  version: "1.0.0",
  async setup(api) {
    await api.write("packages/tui/src/infiniteoc-features/session-import-lib.mjs", await readFile(new URL("./lib.mjs", import.meta.url), "utf8"))
    api.tui.command({
      id: "import",
      title: "Import a Claude Code or Antigravity session and continue it here",
      slash: "import",
      category: "Session",
      source: await readFile(new URL("./command.tsx", import.meta.url), "utf8"),
    })
  },
}
