// `infiniteoc graph`: an Obsidian-style graph of everything InfiniteOC knows about your work, served on
// loopback. Nodes: projects and their top-level sessions (OpenCode's own databases, opened read-only), the
// per-project memory and glossary the agent keeps (mods/ctx-context), each project's AGENTS.md/CLAUDE.md,
// and a notes vault of markdown files that link with [[wikilinks]] and #tags. Only notes are writable,
// and deleting one moves it to the vault's .trash. Sessions are never changed: tabs are not sessions.
import http from "node:http"
import { spawnSync } from "node:child_process"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { atomicWrite } from "../mods/infiniteoc/settings/settings-store.mjs"
import { opencodeDataDir } from "./platform.mjs"

const dataHome = (env) => env.XDG_DATA_HOME || path.join(homedir(), ".local", "share")
export const notesDir = (env = process.env) => env.INFINITEOC_NOTES_DIR || path.join(dataHome(env), "infiniteoc", "notes")
// Same layout as mods/ctx-context/store.ts projectDir: <basename>-<sha1(root) 8 hex>.
const ctxDir = (env, root) => path.join(dataHome(env), "infiniteoc", "ctx", "projects", `${path.basename(root)}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`)

const SESSIONS_PER_PROJECT = 25
const MAX_SESSIONS = 600
const MAX_NOTE_BYTES = 200 * 1024
const MAX_DOC_BYTES = 64 * 1024
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/

export const slugify = (title) =>
  title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "note"

// ---- reading OpenCode's databases ---------------------------------------------------------------

const PROJECTS = "select id, worktree, name, time_active from project"
const SESSIONS = "select id, project_id, title, directory, time_updated, cost from session_v2 where parent_id is null and time_archived is null order by time_updated desc"

/** Rows from a SQLite file, read-only: node:sqlite when this Node has it, else the sqlite3 CLI, else none. */
export async function queryDb(file, sql) {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(file, { readOnly: true })
    try { return db.prepare(sql).all().map((row) => ({ ...row })) } finally { db.close() }
  } catch (error) {
    if (error?.code !== "ERR_UNKNOWN_BUILTIN_MODULE" && error?.code !== "ERR_INVALID_ARG_VALUE" && !/sqlite/.test(String(error?.message))) throw error
    const result = spawnSync("sqlite3", ["-readonly", "-json", file, sql], { encoding: "utf8", windowsHide: true })
    if (result.status !== 0) return []
    return result.stdout.trim() ? JSON.parse(result.stdout) : []
  }
}

async function readDatabases(env) {
  const dir = opencodeDataDir(env)
  // The InfiniteOC channel's database first: it wins when stock OpenCode knows the same project.
  const files = ["opencode-infiniteoc.db", "opencode.db"].map((name) => path.join(dir, name)).filter((file) => existsSync(file))
  const projects = new Map()
  const sessions = []
  for (const file of files) {
    const ids = new Map()
    for (const row of await queryDb(file, PROJECTS).catch(() => [])) {
      if (typeof row.worktree !== "string" || !row.worktree) continue
      ids.set(row.id, row.worktree)
      const known = projects.get(row.worktree)
      projects.set(row.worktree, { worktree: row.worktree, name: known?.name ?? row.name ?? undefined, active: Math.max(known?.active ?? 0, Number(row.time_active) || 0) })
    }
    for (const row of await queryDb(file, SESSIONS).catch(() => [])) {
      const worktree = ids.get(row.project_id)
      if (worktree && !sessions.some((session) => session.id === row.id)) sessions.push({ ...row, worktree })
    }
  }
  return { projects, sessions }
}

// ---- notes ----------------------------------------------------------------------------------------

/** "---\nkey: value\n---\nbody" → { meta, body }; anything else is all body. */
export function parseNote(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta = Object.fromEntries(match[1].split(/\r?\n/).map((line) => /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2].trim()]))
  return { meta, body: text.slice(match[0].length) }
}

export function formatNote({ title, project, body }) {
  const clean = (value) => String(value).replace(/[\r\n]+/g, " ").trim()
  return `---\ntitle: ${clean(title)}\n${project ? `project: ${clean(project)}\n` : ""}---\n${body.endsWith("\n") || !body ? body : `${body}\n`}`
}

/** [[Target]] and [[Target|label]] targets, and #tags outside code. */
export function noteLinks(body) {
  const prose = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")
  const links = [...prose.matchAll(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)].map((m) => m[1].trim()).filter(Boolean)
  const tags = [...prose.matchAll(/(?:^|[\s(])#([A-Za-z][\w/-]{0,40})/g)].map((m) => m[1].toLowerCase())
  return { links: [...new Set(links)], tags: [...new Set(tags)] }
}

export async function readNotes(dir) {
  const names = await readdir(dir).catch(() => [])
  const notes = []
  for (const name of names.filter((item) => item.endsWith(".md")).sort()) {
    const slug = name.slice(0, -3)
    if (!SLUG.test(slug)) continue
    const file = path.join(dir, name)
    const info = await stat(file).catch(() => undefined)
    if (!info?.isFile() || info.size > MAX_NOTE_BYTES) continue
    const { meta, body } = parseNote(await readFile(file, "utf8"))
    notes.push({ slug, title: meta.title || slug, project: meta.project || undefined, body, updated: info.mtimeMs })
  }
  return notes
}

const listFile = (file) => readFile(file, "utf8").then((text) => text.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim()).filter(Boolean), () => [])

// ---- the graph ------------------------------------------------------------------------------------

/**
 * { nodes, links, stats }. Node ids: p:<worktree>, s:<session>, m:/g:<worktree>:<n> (memory, glossary),
 * d:<worktree>:<file> (AGENTS.md/CLAUDE.md), n:<slug> (notes), t:<tag>, x:<name> (a [[link]] to nothing yet).
 */
export async function collectGraph({ env = process.env, notes = notesDir(env) } = {}) {
  const nodes = new Map()
  const links = []
  const add = (node) => { if (!nodes.has(node.id)) nodes.set(node.id, node); return nodes.get(node.id) }
  const linked = new Set()
  const link = (source, target, kind) => {
    const key = source < target ? `${source}\n${target}` : `${target}\n${source}`
    if (source === target || linked.has(key) || !nodes.has(source) || !nodes.has(target)) return
    linked.add(key)
    links.push({ source, target, kind })
  }

  const { projects, sessions } = await readDatabases(env)
  const vault = await readNotes(notes)
  // A note may name a project the databases do not know yet: it still gets its project node.
  for (const note of vault) if (note.project && !projects.has(note.project)) projects.set(note.project, { worktree: note.project, active: 0 })

  const perProject = new Map()
  for (const session of sessions) perProject.set(session.worktree, (perProject.get(session.worktree) ?? 0) + 1)
  for (const project of projects.values()) {
    const label = project.worktree === "/" ? "global" : project.name || path.basename(project.worktree) || project.worktree
    // Benchmark and scratch directories pile up; the page hides these unless asked.
    const temp = project.worktree !== "/" && (project.worktree.startsWith(tmpdir() + path.sep) || !existsSync(project.worktree))
    add({ id: `p:${project.worktree}`, type: "project", label, path: project.worktree, active: project.active, sessions: perProject.get(project.worktree) ?? 0, temp })
  }

  const shown = new Map()
  let total = 0
  for (const session of sessions) {
    const count = shown.get(session.worktree) ?? 0
    if (count >= SESSIONS_PER_PROJECT || total >= MAX_SESSIONS) continue
    shown.set(session.worktree, count + 1)
    total++
    add({ id: `s:${session.id}`, type: "session", label: session.title || "Untitled session", session: session.id, path: session.directory, updated: Number(session.time_updated) || 0, cost: Number(session.cost) || 0 })
    link(`s:${session.id}`, `p:${session.worktree}`, "session")
  }

  for (const project of projects.values()) {
    if (project.worktree === "/") continue
    const dir = ctxDir(env, project.worktree)
    for (const [kind, prefix, file] of [["memory", "m", "memory.md"], ["glossary", "g", "glossary.md"]]) {
      const items = await listFile(path.join(dir, file))
      items.forEach((text, index) => {
        const id = `${prefix}:${project.worktree}:${index}`
        add({ id, type: kind, label: kind === "glossary" ? text.split(/\s[-–:—]\s|:\s/)[0].slice(0, 60) : text.slice(0, 60), body: text, path: project.worktree })
        link(id, `p:${project.worktree}`, kind)
      })
    }
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const file = path.join(project.worktree, name)
      const info = await stat(file).catch(() => undefined)
      if (!info?.isFile()) continue
      add({ id: `d:${project.worktree}:${name}`, type: "doc", label: `${path.basename(project.worktree)}/${name}`, path: file, size: info.size })
      link(`d:${project.worktree}:${name}`, `p:${project.worktree}`, "doc")
    }
  }

  // Notes resolve [[links]] by note title or slug first, then project label or folder name.
  const byName = new Map()
  for (const node of nodes.values()) if (node.type === "project") { byName.set(node.label.toLowerCase(), node.id); byName.set(path.basename(node.path).toLowerCase(), node.id) }
  for (const note of vault) { byName.set(note.title.toLowerCase(), `n:${note.slug}`); byName.set(note.slug, `n:${note.slug}`) }
  for (const note of vault) add({ id: `n:${note.slug}`, type: "note", label: note.title, slug: note.slug, body: note.body, project: note.project, updated: note.updated })
  for (const note of vault) {
    const id = `n:${note.slug}`
    if (note.project) link(id, `p:${note.project}`, "note")
    const found = noteLinks(note.body)
    for (const target of found.links) {
      const resolved = byName.get(target.toLowerCase()) ?? byName.get(slugify(target))
      if (resolved) link(id, resolved, "wikilink")
      else { add({ id: `x:${target.toLowerCase()}`, type: "ghost", label: target }); link(id, `x:${target.toLowerCase()}`, "wikilink") }
    }
    for (const tag of found.tags) { add({ id: `t:${tag}`, type: "tag", label: `#${tag}` }); link(id, `t:${tag}`, "tag") }
  }

  const list = [...nodes.values()]
  const count = (type) => list.filter((node) => node.type === type).length
  return {
    nodes: list,
    links,
    stats: { projects: count("project"), temporary: list.filter((node) => node.temp).length, sessions: count("session"), sessionsTotal: sessions.length, notes: count("note"), memory: count("memory"), glossary: count("glossary"), docs: count("doc") },
    notesDir: notes,
  }
}

// ---- writing notes --------------------------------------------------------------------------------

const noteFile = (dir, slug) => {
  if (!SLUG.test(slug)) throw Object.assign(new Error("Invalid note id"), { status: 400 })
  return path.join(dir, `${slug}.md`)
}

function validNote(input) {
  if (!input || typeof input !== "object") throw Object.assign(new Error("Expected a JSON object"), { status: 400 })
  const title = typeof input.title === "string" ? input.title.trim() : ""
  const body = typeof input.body === "string" ? input.body : ""
  const project = typeof input.project === "string" && input.project.trim() ? input.project.trim() : undefined
  if (!title || title.length > 200) throw Object.assign(new Error("A title of 1-200 characters is required"), { status: 400 })
  if (Buffer.byteLength(body) > MAX_NOTE_BYTES) throw Object.assign(new Error("The note is larger than 200 KB"), { status: 413 })
  if (project && !path.isAbsolute(project)) throw Object.assign(new Error("project must be an absolute path"), { status: 400 })
  return { title, body, project }
}

/** Creates a note with a fresh slug from its title (-2, -3 ... when taken). */
export async function createNote(dir, input) {
  const note = validNote(input)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const base = slugify(note.title)
  for (let n = 1; n < 1000; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 75)}-${n}`
    if (existsSync(noteFile(dir, slug))) continue
    await atomicWrite(noteFile(dir, slug), formatNote(note))
    return { slug }
  }
  throw new Error("Too many notes with this title")
}

export async function updateNote(dir, slug, input) {
  const file = noteFile(dir, slug)
  if (!existsSync(file)) throw Object.assign(new Error("No such note"), { status: 404 })
  await atomicWrite(file, formatNote(validNote(input)))
  return { slug }
}

/** Moves the note to <vault>/.trash (never unlinks); a same-named earlier trash entry is kept too. */
export async function trashNote(dir, slug) {
  const file = noteFile(dir, slug)
  if (!existsSync(file)) throw Object.assign(new Error("No such note"), { status: 404 })
  const trash = path.join(dir, ".trash")
  await mkdir(trash, { recursive: true, mode: 0o700 })
  await rename(file, path.join(trash, `${slug}.${Date.now()}.md`))
  return { slug }
}

/** AGENTS.md / CLAUDE.md of a known project, read on demand. */
async function readDoc(graph, id) {
  const node = graph.nodes.find((item) => item.id === id && item.type === "doc")
  if (!node) throw Object.assign(new Error("No such document"), { status: 404 })
  const text = await readFile(node.path, "utf8")
  return { path: node.path, body: text.length > MAX_DOC_BYTES ? `${text.slice(0, MAX_DOC_BYTES)}\n\n… (truncated)` : text }
}

// ---- the server -----------------------------------------------------------------------------------

const asset = (name) => readFile(new URL(name, import.meta.url))
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" }
const ASSETS = { "/": "graph-page.html", "/graph.css": "graph-page.css", "/graph.js": "graph-page.js" }
const SECURITY = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
}

const readBody = (request) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  request.on("data", (chunk) => {
    size += chunk.length
    if (size > MAX_NOTE_BYTES + 4096) { reject(Object.assign(new Error("Request too large"), { status: 413 })); request.destroy() } else chunks.push(chunk)
  })
  request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")) } catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })) } })
  request.on("error", reject)
})

/**
 * Starts the graph server on 127.0.0.1. Returns { url, link, token, server, close }. The page is public
 * (static files); every /api call needs the random token, which the link carries in its #fragment so it
 * never reaches a server log or a Referer. The Host check stops DNS-rebinding pages from reading the API.
 */
export async function startGraph({ port = 0, env = process.env, notes = notesDir(env), token = randomBytes(24).toString("base64url") } = {}) {
  const expected = Buffer.from(`Bearer ${token}`)
  const authorized = (request) => {
    const given = Buffer.from(request.headers.authorization ?? "")
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
  let cached
  const graph = async (fresh = false) => (cached && !fresh ? cached : (cached = await collectGraph({ env, notes })))

  const server = http.createServer(async (request, response) => {
    const send = (status, body, type = "application/json; charset=utf-8") => {
      response.writeHead(status, { ...SECURITY, "Content-Type": type })
      response.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    }
    try {
      const { port: bound } = server.address()
      if (![`127.0.0.1:${bound}`, `localhost:${bound}`].includes(request.headers.host ?? "")) return send(421, { error: "Wrong host" })
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${bound}`)
      if (request.method === "GET" && ASSETS[url.pathname]) return send(200, await asset(ASSETS[url.pathname]), TYPES[path.extname(ASSETS[url.pathname])])
      if (!url.pathname.startsWith("/api/")) return send(404, { error: "Not found" })
      if (!authorized(request)) return send(401, { error: "Open the link printed by infiniteoc graph" })
      if ((request.method === "POST" || request.method === "PUT") && !/^application\/json\b/.test(request.headers["content-type"] ?? "")) return send(415, { error: "JSON only" })
      if (request.method === "GET" && url.pathname === "/api/graph") return send(200, await graph(url.searchParams.has("fresh")))
      if (request.method === "GET" && url.pathname === "/api/doc") return send(200, await readDoc(await graph(), url.searchParams.get("id") ?? ""))
      const slug = /^\/api\/notes\/([^/]+)$/.exec(url.pathname)?.[1]
      let result
      if (request.method === "POST" && url.pathname === "/api/notes") result = await createNote(notes, await readBody(request))
      else if (request.method === "PUT" && slug) result = await updateNote(notes, slug, await readBody(request))
      else if (request.method === "DELETE" && slug) result = await trashNote(notes, slug)
      else return send(404, { error: "Not found" })
      cached = undefined
      return send(200, result)
    } catch (error) {
      send(error.status ?? 500, { error: error.status ? error.message : "Internal error" })
    }
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve) })
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, link: `${url}/#${token}`, token, server, close: () => new Promise((resolve) => server.close(() => resolve())) }
}
