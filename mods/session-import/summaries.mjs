// session-import summaries: richer Antigravity listing from
// conversation_summaries.db via node:sqlite. CLI-only (the TUI uses the
// filesystem fallback in lib.mjs). Read-only: the database is opened
// read-only and never written.
import path from "node:path"
import { antigravityDir } from "./lib.mjs"

let sqliteAvailable
async function sqlite() {
  if (sqliteAvailable === undefined) {
    try {
      sqliteAvailable = await import("node:sqlite")
    } catch {
      sqliteAvailable = null
    }
  }
  return sqliteAvailable
}

/** Titles/previews/step counts from the summaries DB; [] when unavailable. */
export async function readSummaries(home) {
  const mod = await sqlite()
  if (!mod) return []
  const file = path.join(antigravityDir(home), "conversation_summaries.db")
  let db
  try {
    db = new mod.DatabaseSync(file, { readOnly: true })
  } catch {
    return []
  }
  try {
    return db
      .prepare(
        "SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, source FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 200",
      )
      .all()
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {}
  }
}
