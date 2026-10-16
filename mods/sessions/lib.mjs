// InfiniteOC sessions: read-only access to any local session's data. Plain JS with node built-ins only, so
// the launcher, node tests and the built core plugin all use it as is. Written to
// packages/core/src/plugin/infiniteoc-sessions-lib.mjs by mods/sessions.
// Reads OpenCode's own databases opened read-only (never written, never locked exclusively): the InfiniteOC
// channel's database first, so it wins when stock OpenCode knows the same project.
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const LIST_DEFAULT = 50
export const LIST_MAX = 200
export const MESSAGE_CHARS = 2000
export const OUTPUT_CHARS = 20000

export function dataDir(env = process.env) {
  const base = env.XDG_DATA_HOME || path.join(homedir(), ".local", "share")
  return path.join(base, "opencode")
}

export function dbFiles(env = process.env) {
  const dir = dataDir(env)
  return ["opencode-infiniteoc.db", "opencode.db"].map((name) => path.join(dir, name)).filter((file) => existsSync(file))
}

/** Rows from a SQLite file, read-only: node:sqlite when available, else the sqlite3 CLI, else none. */
export async function queryDb(file, sql, params = []) {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(file, { readOnly: true })
    try { return db.prepare(sql).all(...params).map((row) => ({ ...row })) } finally { db.close() }
  } catch (error) {
    if (error?.code !== "ERR_UNKNOWN_BUILTIN_MODULE" && error?.code !== "ERR_INVALID_ARG_VALUE" && !/sqlite/.test(String(error?.message))) throw error
    const { spawnSync } = await import("node:child_process")
    let index = 0
    const text = sql.replace(/\?/g, () => {
      const value = params[index++]
      if (typeof value === "number") return String(value)
      return `'${String(value ?? "").replace(/'/g, "''")}'`
    })
    const result = spawnSync("sqlite3", ["-readonly", "-json", file, text], { encoding: "utf8", windowsHide: true })
    if (result.status !== 0) return []
    return result.stdout.trim() ? JSON.parse(result.stdout) : []
  }
}

const like = (value) => `%${String(value).replace(/[%_\\]/g, (c) => `\\${c}`)}%`

const PROJECTS = "select id, worktree, name from project"
const SESSIONS = "select id, project_id, title, directory, time_updated, cost from session_v2 where parent_id is null and time_archived is null order by time_updated desc"

/** Root sessions newest-first across both databases (deduplicated); optional project worktree filter and title search. */
export async function listSessions({ env = process.env, project, search, limit = LIST_DEFAULT } = {}) {
  const count = Math.max(1, Math.min(Number(limit) || LIST_DEFAULT, LIST_MAX))
  const seen = new Map()
  const out = []
  for (const file of dbFiles(env)) {
    const names = new Map((await queryDb(file, PROJECTS).catch(() => [])).map((row) => [row.id, row]))
    for (const row of await queryDb(file, SESSIONS).catch(() => [])) {
      if (seen.has(row.id)) continue
      const worktree = names.get(row.project_id)?.worktree
      if (project && worktree !== project) continue
      if (search && !`${row.title ?? ""} ${row.directory ?? ""}`.toLowerCase().includes(String(search).toLowerCase())) continue
      seen.set(row.id, true)
      out.push({ id: row.id, title: row.title || "Untitled session", directory: row.directory, project: worktree ?? undefined, updated: Number(row.time_updated) || 0, cost: Number(row.cost) || 0 })
      if (out.length >= count) return out
    }
  }
  return out
}

/** A session id: exact match, else its unique prefix (over the newest 200), else an error naming candidates. */
export async function resolveSession(id, env = process.env) {
  const want = String(id ?? "").trim()
  if (!want) throw new Error("Give a session id (session_data list shows them).")
  const all = await listSessions({ env, limit: LIST_MAX })
  const found = all.find((item) => item.id === want) ?? (() => {
    const prefix = all.filter((item) => item.id.startsWith(want))
    return prefix.length === 1 ? prefix[0] : undefined
  })()
  if (found) return found
  const close = all.filter((item) => item.id.startsWith(want)).slice(0, 5).map((item) => item.id)
  throw new Error(close.length ? `No session "${want}". Did you mean: ${close.join(", ")}?` : `No session "${want}" in this machine's OpenCode databases.`)
}

/** Pull printable text out of a session_message data blob without knowing its schema version. */
export function messageText(data) {
  if (typeof data === "string") return data
  const texts = []
  const visit = (value) => {
    if (typeof value === "string") return
    if (Array.isArray(value)) return value.forEach(visit)
    if (value && typeof value === "object") {
      if (typeof value.text === "string" && value.text) texts.push(value.text)
      for (const [key, item] of Object.entries(value)) if (key !== "text") visit(item)
    }
  }
  visit(data)
  return texts.join("\n\n")
}

/** One rendered message: { seq, type, time, text } with text capped. */
export function renderMessage(row) {
  let text = ""
  try { text = messageText(JSON.parse(row.data.length > 16000 ? row.data.slice(0, 16000) : row.data)) } catch { text = String(row.data).slice(0, MESSAGE_CHARS) }
  if (text.length > MESSAGE_CHARS) text = `${text.slice(0, MESSAGE_CHARS)}\n… (truncated)`
  return { seq: row.seq, type: row.type, time: Number(row.time_created) || 0, text }
}

/** Messages of one session in seq order; types filters in SQL so pages stay full. */
export async function readMessages(id, { env = process.env, limit = LIST_DEFAULT, offset = 0, types } = {}) {
  const session = await resolveSession(id, env)
  const count = Math.max(1, Math.min(Number(limit) || LIST_DEFAULT, LIST_MAX))
  const skip = Math.max(0, Number(offset) || 0)
  const want = Array.isArray(types) && types.length ? types.map(String) : undefined
  const typeFilter = want ? ` and type in (${want.map(() => "?").join(",")})` : ""
  const out = []
  for (const file of dbFiles(env)) {
    const rows = await queryDb(file, `select seq, type, time_created, data from session_message where session_id = ?${typeFilter} order by seq limit ? offset ?`, [session.id, ...(want ?? []), count, skip]).catch(() => [])
    for (const row of rows) out.push(renderMessage(row))
    if (out.length) break
  }
  return { session, messages: out.slice(0, count) }
}

/** Full-text search over message blobs and session titles; returns { session, seq, type, snippet } hits. */
export async function searchMessages(query, { env = process.env, limit = 30 } = {}) {
  const text = String(query ?? "").trim()
  if (!text) throw new Error("Give a query to search for.")
  const count = Math.max(1, Math.min(Number(limit) || 30, 100))
  const sessions = new Map((await listSessions({ env, limit: LIST_MAX })).map((item) => [item.id, item]))
  const out = []
  for (const file of dbFiles(env)) {
    const rows = await queryDb(file, "select session_id, seq, type, substr(data, 1, 1200) as data from session_message where data like ? escape '\\' order by time_created desc limit ?", [like(text), count * 2]).catch(() => [])
    for (const row of rows) {
      if (out.length >= count) return out
      const at = row.data.toLowerCase().indexOf(text.toLowerCase())
      out.push({ session: sessions.get(row.session_id) ?? { id: row.session_id }, seq: row.seq, type: row.type, snippet: row.data.slice(Math.max(0, at - 160), at + 240) })
    }
  }
  return out
}

const cap = (text) => (text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n… (output truncated)` : text)

export function formatSessions(sessions) {
  if (!sessions.length) return "No sessions on this machine yet."
  return cap(sessions.map((item) => `- ${item.id} · ${item.title} · ${item.project ?? item.directory ?? "?"} · $${item.cost.toFixed(2)}`).join("\n"))
}

export function formatMessages({ session, messages }) {
  const head = `Session ${session.id} · ${session.title}${session.project ? ` · ${session.project}` : ""} (${messages.length} message${messages.length === 1 ? "" : "s"})`
  if (!messages.length) return `${head}\nNo messages.`
  return cap([head, "", ...messages.map((item) => `[${item.seq} ${item.type}]${item.text ? `\n${item.text}` : " (no text)"}`)].join("\n"))
}

export function formatHits(hits) {
  if (!hits.length) return "No matches."
  return cap(hits.map((hit) => `- ${hit.session.id ?? hit.session} #${hit.seq} [${hit.type}]: ${hit.snippet.replace(/\s+/g, " ").slice(0, 280)}`).join("\n"))
}
