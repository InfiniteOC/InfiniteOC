import type { FeatureContext } from "./api"
import { existsSync, statSync } from "node:fs"
import {
  importedAs,
  listAntigravitySessions,
  listClaudeSessions,
  readAntigravitySession,
  readClaudeSession,
  recordImport,
  toImportPayload,
} from "./session-import-lib.mjs"

// /import: pick a Claude Code or Antigravity session found on this machine; it is converted and
// imported into this backend through the UI's own connection, then opened, ready to continue.
// Importing the same session again opens the copy made the first time.
export async function run(ctx: FeatureContext) {
  type Found = { harness: "claude" | "antigravity"; id: string; file: string; title?: string; userTurns: number; assistantTurns: number; cwd?: string; time: number }
  const all: Found[] = [
    ...listClaudeSessions().map((s): Found => ({ harness: "claude", id: s.id, file: s.file, title: s.title, userTurns: s.userTurns, assistantTurns: s.assistantTurns, cwd: s.cwd, time: s.lastTime ?? s.mtimeMs })),
    ...listAntigravitySessions().map((s): Found => ({ harness: "antigravity", id: s.id, file: s.file, title: s.title, userTurns: s.userTurns, assistantTurns: s.assistantTurns, time: s.mtimeMs })),
  ].sort((a, b) => b.time - a.time)
  if (!all.length) {
    await ctx.ui.alert({
      title: "Nothing to import",
      message: "No Claude Code sessions (~/.claude/projects) or Antigravity transcripts (~/.gemini/antigravity-cli/brain) on this machine.",
    })
    return
  }
  const picked = await ctx.ui.select({
    title: `Import a session and continue it here (${all.length} found)`,
    options: all.slice(0, 50).map((s, index) => ({
      title: `${s.harness === "claude" ? "Claude" : "Antigravity"}: ${(s.title ?? s.id).slice(0, 60)}`,
      value: String(index),
      description: `${s.userTurns} you / ${s.assistantTurns} replies${s.cwd ? ` · ${s.cwd}` : ""}`,
    })),
  })
  if (picked === undefined) return
  const session = all[Number(picked)]

  const open = (sessionID: string) => {
    if (ctx.tabs.enabled()) {
      ctx.tabs.open(sessionID)
      ctx.tabs.select(sessionID)
    } else ctx.route.navigate({ type: "session", sessionID })
  }
  // Imported before (and still there): open that copy instead of making another.
  const earlier = importedAs(session.harness, session.id)
  const existing = earlier ? await ctx.client.api.session.get({ sessionID: earlier }).catch(() => undefined) : undefined
  if (earlier && existing) {
    open(earlier)
    ctx.toast.show({ variant: "info", title: "Already imported", message: "Opened the session imported from it earlier." })
    return
  }

  try {
    const { turns } = session.harness === "claude" ? readClaudeSession(session.file) : readAntigravitySession(session.file)
    const cwd = session.cwd
    // The session's own project folder when it still exists, so the agent continues where it worked.
    const directory = cwd && existsSync(cwd) && statSync(cwd).isDirectory() ? cwd : process.cwd()
    const title = `${session.harness === "claude" ? "Claude" : "Antigravity"}: ${(session.title ?? session.id).slice(0, 80)}`
    const payload = toImportPayload(turns, { harness: session.harness, sourceId: session.id, title, directory })
    ctx.toast.show({ variant: "info", title: "Importing", message: `${payload.messages.length} messages from ${session.harness}…` })
    await ctx.client.api.session.import({ info: payload.info, messages: payload.messages, location: { directory } })
    recordImport(session.harness, session.id, payload.info.id)
    open(payload.info.id)
    ctx.toast.show({ variant: "success", title: "Imported", message: `Continue the ${session.harness} session here. Its replies are marked with where they came from.` })
  } catch (error) {
    await ctx.ui.alert({ title: "Import failed", message: error instanceof Error ? error.message : String(error) })
  }
}
