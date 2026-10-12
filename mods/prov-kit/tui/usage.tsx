import type { FeatureContext } from "./api"
import { Database } from "bun:sqlite"
import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { Global } from "@opencode/util/global"
import { aggregateUsage, formatUsage, type UsageRow } from "./prov-lib"

// Same file the server uses: OPENCODE_DB, else opencode-<channel>.db; otherwise the newest opencode*.db.
function databaseFile() {
  const data = Global.Path.data
  const named = process.env.OPENCODE_DB ?? `opencode-${(process.env.OPENCODE_TUI_CHANNEL ?? "").replace(/[^a-zA-Z0-9._-]/g, "-")}.db`
  const direct = path.resolve(data, named)
  if (existsSync(direct)) return direct
  const found = existsSync(data) ? readdirSync(data).filter((name) => /^opencode.*\.db$/.test(name)).map((name) => path.join(data, name)) : []
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

// Cost is read per assistant and compaction message, so a session that switched models or spanned
// days is split correctly. Subagent sessions are included; the days are local time.
const QUERY = `select date(m.time_created / 1000, 'unixepoch', 'localtime') as day, s.directory as project,
  coalesce(json_extract(m.data, '$.model.providerID'), 'unknown') as provider, json_extract(m.data, '$.cost') as cost
  from session_message m join session_v2 s on s.id = m.session_id
  where m.type in ('assistant', 'compaction') and json_extract(m.data, '$.cost') > 0`

export async function run(ctx: FeatureContext) {
  const file = databaseFile()
  if (!file) return ctx.toast.show({ variant: "warning", title: "Usage", message: "No stored sessions found." })
  const db = new Database(file, { readonly: true })
  let rows: UsageRow[]
  try {
    rows = db.query(QUERY).all() as UsageRow[]
  } finally {
    db.close()
  }
  ctx.ui.set({ size: "large" })
  await ctx.ui.alert({ title: "Spend from stored sessions", message: formatUsage(aggregateUsage(rows)) })
}
