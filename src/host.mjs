// `infiniteoc host`: InfiniteOC as a password-guarded web app whose projects live in the visitor's browser.
//
// The agent's tools need a real filesystem, so the host keeps a working copy only while someone works on it:
// everything (projects, OpenCode's database, sessions, settings) lives in one temporary directory that is
// deleted when the host stops, and a project a browser has saved is dropped from the host after it sits idle.
// The browser is the permanent store (IndexedDB): opening a project uploads it, changes stream back every few
// seconds, and the visitor can download it as a zip at any time. Nothing is written outside the temporary
// directory, so the host can run anywhere (see `infiniteoc host bundle` and the Dockerfile it writes).
//
// Front (public) → password gate (cookie) → our shell page and sync API under /_ioc/, everything else proxied
// (HTTP and WebSocket) to a private `opencode serve` on loopback with the web UI built in.
import http from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { archive } from "./project-export.mjs"
import { atomicWrite, readObject } from "../mods/infiniteoc/settings/settings-store.mjs"

const COOKIE = "ioc_host"
const SESSION_MS = 7 * 24 * 3600_000
// Not synced: reinstallable or rebuildable trees that would only fill the visitor's browser.
export const SKIP = new Set(["node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".next", ".turbo", ".cache", ".parcel-cache", "target", ".gradle"])
export const MAX_FILE = 8 * 1024 * 1024
const MAX_BATCH = 8 * 1024 * 1024
const MAX_BODY = 12 * 1024 * 1024
const NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/

const asset = (name) => readFile(new URL(name, import.meta.url))
const ASSETS = { "/_ioc/": ["host-page.html", "text/html; charset=utf-8"], "/_ioc/app.js": ["host-page.js", "text/javascript; charset=utf-8"], "/_ioc/app.css": ["host-page.css", "text/css; charset=utf-8"] }
const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" }
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"

/** A relative path inside a project, with forward slashes; undefined when it could escape or is not plain. */
export function safeRelative(value) {
  if (typeof value !== "string" || !value || value.length > 1000 || value.includes("\0") || value.includes("\\")) return undefined
  const parts = value.split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined
  return parts.join("/")
}

/** Every syncable file under `dir`: [{ path, size, mtime }], never following symlinks, skipping SKIP trees. */
export async function listFiles(dir) {
  const out = []
  const visit = async (current, prefix) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (SKIP.has(entry.name)) continue
      const full = path.join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(full, rel)
      else if (entry.isFile()) {
        const info = await lstat(full).catch(() => undefined)
        if (info && info.size <= MAX_FILE) out.push({ path: rel, size: info.size, mtime: info.mtimeMs })
      }
    }
  }
  await visit(dir, "")
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

/**
 * Files changed since `since` (ms), in path order after `after`, up to MAX_BATCH bytes of content.
 * Returns { cursor, files: [{ path, mtime, data (base64) }], paths (complete listing, only when not `more`), more }.
 * The cursor is the scan start minus a second, so a write racing the scan is sent again rather than missed.
 */
export async function changes(dir, { since = 0, after = "" } = {}) {
  const started = Date.now()
  const all = await listFiles(dir)
  const files = []
  let bytes = 0
  let more = false
  for (const item of all) {
    if (item.mtime < since - 1000 || (after && item.path <= after)) continue
    if (bytes + item.size > MAX_BATCH && files.length) { more = true; break }
    const data = await readFile(path.join(dir, item.path)).catch(() => undefined)
    if (!data) continue
    files.push({ path: item.path, mtime: item.mtime, data: data.toString("base64") })
    bytes += data.length
  }
  return { cursor: more ? since : started - 1000, files, more, ...(more ? {} : { paths: all.map((item) => item.path) }) }
}

/** Writes uploaded files into `dir` (replacing it first when `replace`); refuses any path that could escape. */
export async function receive(dir, { files = [], replace = false } = {}) {
  if (!Array.isArray(files)) throw Object.assign(new Error("files must be an array"), { status: 400 })
  if (replace) await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  let written = 0
  for (const file of files) {
    const rel = safeRelative(file?.path)
    if (!rel || typeof file.data !== "string") throw Object.assign(new Error(`Invalid file entry: ${String(file?.path).slice(0, 80)}`), { status: 400 })
    const target = path.join(dir, rel)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, Buffer.from(file.data, "base64"))
    written++
  }
  return { written }
}

const readJson = (request) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(Object.assign(new Error("Request too large; send fewer files at once"), { status: 413 })); request.destroy() } else chunks.push(chunk)
    })
    request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")) } catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })) } })
    request.on("error", reject)
  })

const cookies = (header = "") => Object.fromEntries(header.split(";").map((part) => part.trim().split("=")).filter(([key]) => key).map(([key, ...rest]) => [key, decodeURIComponent(rest.join("="))]))
const digest = (text) => createHash("sha256").update(text).digest()

/** The gate: password check with a per-address backoff, and random session cookies. */
export function createGate(password, { now = () => Date.now() } = {}) {
  const expected = digest(password)
  const sessions = new Map()
  const failures = new Map()
  return {
    sessions,
    login(address, attempt) {
      const record = failures.get(address) ?? { count: 0, until: 0 }
      if (record.until > now()) return { ok: false, wait: Math.ceil((record.until - now()) / 1000) }
      if (typeof attempt === "string" && timingSafeEqual(digest(attempt), expected)) {
        failures.delete(address)
        const token = randomBytes(32).toString("base64url")
        sessions.set(token, now() + SESSION_MS)
        return { ok: true, token }
      }
      record.count++
      // 5 free tries, then 30 s, 60 s, 120 s ... up to 15 minutes between attempts.
      if (record.count >= 5) record.until = now() + Math.min(15 * 60_000, 30_000 * 2 ** (record.count - 5))
      failures.set(address, record)
      return { ok: false, wait: record.until > now() ? Math.ceil((record.until - now()) / 1000) : 0 }
    },
    check(header) {
      const token = cookies(header)[COOKIE]
      const expires = token && sessions.get(token)
      if (!expires) return false
      if (expires < now()) { sessions.delete(token); return false }
      return true
    },
    logout(header) { sessions.delete(cookies(header)[COOKIE]) },
  }
}

const LOGIN = (message = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>InfiniteOC · Sign in</title><link rel="stylesheet" href="/_ioc/login.css"></head>
<body><main><form method="post" action="/_ioc/login"><h1><span>∞</span> InfiniteOC</h1><p>This InfiniteOC is private. Your projects are kept in your browser.</p>
<label>Password <input type="password" name="password" autocomplete="current-password" autofocus required></label>${message ? `<p class="error" role="alert">${message}</p>` : ""}<button>Sign in</button></form></main></body></html>`
const LOGIN_CSS = `:root{color-scheme:dark light;font:15px/1.5 system-ui,sans-serif;--bg:#0d0a12;--panel:#16111e;--line:#2d2439;--text:#ede7f6;--muted:#a397b8;--accent:#c084fc}@media(prefers-color-scheme:light){:root{--bg:#faf8fd;--panel:#fff;--line:#e2d9ef;--text:#1d1428;--muted:#6a5d7e;--accent:#9333ea}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text)}form{width:min(360px,90vw);padding:28px;background:var(--panel);border:1px solid var(--line);border-radius:14px;display:grid;gap:14px}
h1{margin:0;font-size:22px}h1 span{color:var(--accent)}p{margin:0;color:var(--muted)}label{display:grid;gap:6px;color:var(--muted);font-size:13px}input{padding:10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--text);font:inherit}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}button{padding:10px;border:0;border-radius:8px;background:var(--accent);color:#12051f;font:inherit;font-weight:600;cursor:pointer}.error{color:#fb7185}`

/** Starts `binary serve` on loopback in the temporary root; resolves once it answers. */
async function startBackend({ binary, env, cwd, password }) {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
    probe.on("error", reject)
  })
  const url = `http://127.0.0.1:${port}`
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd, env: { ...env, PWD: cwd, OPENCODE_PASSWORD: password }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
  let stderr = ""
  child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)))
  let exited = false
  child.on("exit", () => (exited = true))
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  for (let attempt = 0; ; attempt++) {
    if (exited) throw new Error(`The OpenCode backend exited during startup${stderr ? `: ${stderr.trim()}` : ""}`)
    if (attempt > 300) { child.kill("SIGTERM"); throw new Error("The OpenCode backend did not start within 60s") }
    if (await fetch(`${url}/api/session`, { headers: { authorization: auth }, signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false)) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return { url, port, auth, child, stop: () => { if (!exited) child.kill("SIGTERM") }, exited: new Promise((resolve) => child.on("exit", resolve)) }
}

/**
 * Permission lockdown for the temporary host backend. File tools and shell working directories outside the
 * session's own project directory are authorized through the `external_directory` action (upstream evaluates
 * rules last-match-wins), so a blanket deny plus a narrow allow-list for the temporary root confines the agent
 * to the host's temporary directory. Session directories always live under it, so normal project work is unaffected.
 *
 * Honest limits: shell commands are gated by static analysis of their working directory and visible paths.
 * An obfuscated command that hides an outside path from the scanner can still reach it, so the host password
 * still guards full shell access — this turns silent wandering into refusals, it is not an OS sandbox.
 */
export function sandboxPermissions({ root, skills }) {
  const under = (dir) => `${String(dir).replace(/\\/g, "/")}/*`
  // Upstream evaluates rules last-match-wins (and escapes brackets, so no character classes): the blanket
  // deny comes first and the narrow allows after it. Drive letters are enumerated literally for Windows.
  const drives = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:/*`)
  return [
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "external_directory", resource: under(root), effect: "allow" },
    ...(skills ? [{ action: "external_directory", resource: under(skills), effect: "allow" }] : []),
    // Backstop for reads/writes that skip the directory check (e.g. recovered filenames): internal paths are
    // relative, so absolute patterns only match escapes.
    ...["read", "edit", "write"].flatMap((action) => [
      { action, resource: "/*", effect: "deny" },
      ...drives.map((resource) => ({ action, resource, effect: "deny" })),
    ]),
  ]
}

/** The backend opencode.json: the user's providers/model plus the lockdown (which wins by coming last). */
export function sandboxConfig(input, { root, home }) {
  const base = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {}
  const permissions = [
    ...(Array.isArray(base.permissions) ? base.permissions : []),
    ...sandboxPermissions({ root, skills: path.join(home, "skills") }),
  ]
  return { ...base, permissions }
}

/**
 * Starts the host. `binary` is an InfiniteOC build with the web UI. `config` is an opencode.json whose
 * providers/model are reused; the backend always gets the sandboxed copy (see sandboxConfig), never the
 * original. Returns { url, root, close, exited }.
 */
export async function startHost({ home, binary, password, host = "127.0.0.1", port = 0, env = process.env, config, idleMinutes = 30, secureCookies = false, log = () => {} }) {
  if (typeof password !== "string" || password.length < 12) throw new Error("The host password must be at least 12 characters")
  const root = await mkdtemp(path.join(tmpdir(), "infiniteoc-host-"))
  const dirs = { config: path.join(root, "config"), data: path.join(root, "data"), state: path.join(root, "state"), cache: path.join(root, "cache"), projects: path.join(root, "projects"), tmp: path.join(root, "tmp") }
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true, mode: 0o700 })
  await mkdir(path.join(dirs.config, "opencode"), { recursive: true })
  // Never the user's own file: the backend runs visitors' agent work, so it gets providers/model merged with
  // the sandbox lockdown. A missing or unreadable config is an empty base, still locked down; the temp root
  // here is always cleaned by the caller's close() (and the startBackend catch below removes it on failure).
  let base = {}
  if (config && existsSync(config)) {
    try { base = (await readObject(config)).value ?? {} } catch { base = {} }
  }
  await atomicWrite(path.join(dirs.config, "opencode", "opencode.json"), JSON.stringify(sandboxConfig(base, { root, home }), null, 2) + "\n")
  const backendEnv = {
    ...env,
    XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache,
    // Scratch space stays inside the temporary root, so the shared system temp needs no permission carve-out.
    TMPDIR: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"),
    INFINITEOC_SETTINGS_FILE: path.join(dirs.config, "infiniteoc", "settings.json"),
    // The project tool creates projects here, so the agent's new projects show up in the browser too.
    INFINITEOC_PROJECTS_DIR: dirs.projects, INFINITEOC_MODS_DIR: path.join(dirs.config, "infiniteoc", "mods"),
    INFINITEOC_HOME: home, INFINITEOC: "1", OPENCODE_CLIENT: "InfiniteOC", OPENCODE_TUI_CHANNEL: "infiniteoc", INFINITEOC_SKILLS: path.join(home, "skills"),
  }
  const backendPassword = randomBytes(24).toString("base64url")
  let backend
  try {
    backend = await startBackend({ binary, env: backendEnv, cwd: dirs.projects, password: backendPassword })
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }

  const gate = createGate(password)
  // Per project: when a browser last asked for changes, and whether that browser holds everything.
  const touched = new Map()
  const projectDir = (name) => {
    if (!NAME.test(name ?? "")) throw Object.assign(new Error("Invalid project name"), { status: 400 })
    return path.join(dirs.projects, name)
  }
  const send = (response, status, body, headers = {}) => {
    const json = typeof body !== "string" && !Buffer.isBuffer(body)
    response.writeHead(status, { ...SECURITY, "Content-Type": json ? "application/json; charset=utf-8" : headers["Content-Type"] ?? "text/plain; charset=utf-8", ...headers })
    response.end(json ? JSON.stringify(body) : body)
  }
  const cookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`

  async function api(request, response, url) {
    // A custom header: cross-site pages cannot send it without a CORS preflight, which this server never grants.
    if (request.method !== "GET" && request.headers["x-ioc"] !== "1") return send(response, 403, { error: "Missing x-ioc header" })
    const parts = url.pathname.split("/").slice(3).map(decodeURIComponent)
    if (parts[0] === "projects" && parts.length === 1 && request.method === "GET") {
      const names = (await readdir(dirs.projects, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && NAME.test(entry.name)).map((entry) => entry.name)
      return send(response, 200, { root: dirs.projects, projects: await Promise.all(names.map(async (name) => ({ name, updated: (await stat(path.join(dirs.projects, name))).mtimeMs }))) })
    }
    if (parts[0] !== "projects" || !parts[1]) return send(response, 404, { error: "Not found" })
    const dir = projectDir(parts[1])
    const action = parts[2]
    if (action === "files" && request.method === "PUT") {
      const body = await readJson(request)
      const result = await receive(dir, body)
      if (body.git && !existsSync(path.join(dir, ".git"))) spawn("git", ["init", "-q"], { cwd: dir, stdio: "ignore", windowsHide: true })
      return send(response, 200, result)
    }
    if (!existsSync(dir)) return send(response, 404, { error: "This project is not on the host (open it to upload it)" })
    if (action === "changes" && request.method === "GET") {
      const result = await changes(dir, { since: Number(url.searchParams.get("since") ?? 0), after: url.searchParams.get("after") ?? "" })
      touched.set(parts[1], { at: Date.now(), complete: !result.more })
      return send(response, 200, result)
    }
    if (action === "session" && request.method === "POST") {
      const created = await fetch(`${backend.url}/api/session`, { method: "POST", headers: { authorization: backend.auth, "content-type": "application/json" }, body: JSON.stringify({ title: parts[1], location: { directory: dir } }) })
      if (!created.ok) return send(response, 502, { error: `Could not start a session (${created.status})` })
      return send(response, 200, { sessionID: (await created.json()).data.id, directory: dir })
    }
    if (action === "archive" && request.method === "GET") {
      const built = await archive(dir, "zip").catch(() => archive(dir, "tar.gz"))
      try {
        const data = await readFile(built.file)
        return send(response, 200, data, { "Content-Type": built.format === "zip" ? "application/zip" : "application/gzip", "Content-Disposition": `attachment; filename="${parts[1]}.${built.format === "zip" ? "zip" : "tar.gz"}"` })
      } finally { await rm(path.dirname(built.file), { recursive: true, force: true }) }
    }
    if (!action && request.method === "DELETE") {
      await rm(dir, { recursive: true, force: true })
      touched.delete(parts[1])
      return send(response, 200, { removed: parts[1] })
    }
    return send(response, 404, { error: "Not found" })
  }

  function proxy(request, response) {
    const headers = { ...request.headers, authorization: backend.auth, host: `127.0.0.1:${backend.port}` }
    delete headers.cookie
    const upstream = http.request({ host: "127.0.0.1", port: backend.port, method: request.method, path: request.url, headers }, (reply) => {
      const out = { ...reply.headers }
      // The web UI runs inside the host page's frame, which is the same origin.
      delete out["x-frame-options"]
      if (out["content-security-policy"]) out["content-security-policy"] = String(out["content-security-policy"]).replace(/frame-ancestors[^;]*/i, "frame-ancestors 'self'")
      response.writeHead(reply.statusCode ?? 502, out)
      reply.pipe(response)
    })
    upstream.on("error", () => { if (!response.headersSent) send(response, 502, "InfiniteOC backend unavailable"); else response.destroy() })
    request.pipe(upstream)
  }

  const front = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://host")
      if (url.pathname === "/_ioc/login.css") return send(response, 200, LOGIN_CSS, { "Content-Type": "text/css; charset=utf-8" })
      if (url.pathname === "/_ioc/login" && request.method === "POST") {
        const form = new URLSearchParams(await new Promise((resolve) => { let raw = ""; request.on("data", (c) => (raw += c).length > 4096 && request.destroy()); request.on("end", () => resolve(raw)) }))
        const result = gate.login(request.socket.remoteAddress ?? "?", form.get("password") ?? "")
        if (!result.ok) return send(response, 401, LOGIN(result.wait ? `Too many attempts. Try again in ${result.wait} s.` : "Wrong password."), { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP })
        return send(response, 303, "", { Location: "/_ioc/", "Set-Cookie": cookie(result.token, SESSION_MS / 1000) })
      }
      if (!gate.check(request.headers.cookie)) {
        if (url.pathname.startsWith("/_ioc/api/") || (request.headers.accept ?? "").includes("application/json")) return send(response, 401, { error: "Sign in first" })
        return send(response, url.pathname === "/" || url.pathname.startsWith("/_ioc") ? 200 : 401, LOGIN(), { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP })
      }
      if (url.pathname === "/_ioc/logout") { gate.logout(request.headers.cookie); return send(response, 303, "", { Location: "/_ioc/", "Set-Cookie": cookie("", 0) }) }
      if (url.pathname === "/") return send(response, 303, "", { Location: "/_ioc/" })
      if (ASSETS[url.pathname] && request.method === "GET") {
        const [file, type] = ASSETS[url.pathname]
        return send(response, 200, await asset(file), { "Content-Type": type, "Content-Security-Policy": PAGE_CSP })
      }
      if (url.pathname.startsWith("/_ioc/api/")) return await api(request, response, url)
      if (url.pathname.startsWith("/_ioc")) return send(response, 404, "Not found")
      proxy(request, response)
    } catch (error) {
      if (!response.headersSent) send(response, error.status ?? 500, { error: error.status ? error.message : "Internal error" })
      if (!error.status) log(`[host] ${error.stack ?? error}`)
    }
  })
  // WebSockets (the web UI's live updates): same gate, then a raw tunnel with the backend's credentials.
  // Tunnels are not HTTP connections any more, so close() destroys them itself instead of waiting forever.
  const tunnels = new Set()
  front.on("upgrade", (request, socket, head) => {
    if (!gate.check(request.headers.cookie)) { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroySoon?.(); return }
    const upstream = net.connect(backend.port, "127.0.0.1", () => {
      const headers = { ...request.headers, authorization: backend.auth, host: `127.0.0.1:${backend.port}` }
      delete headers.cookie
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`)
      if (head?.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    const close = () => { socket.destroy(); upstream.destroy(); tunnels.delete(close) }
    tunnels.add(close)
    for (const side of [socket, upstream]) { side.on("error", close); side.on("close", close) }
  })

  // Idle projects that a browser holds completely leave the host; ones no browser has saved stay until exit.
  const sweep = setInterval(async () => {
    for (const [name, state] of touched) {
      if (!state.complete || Date.now() - state.at < idleMinutes * 60_000) continue
      await rm(path.join(dirs.projects, name), { recursive: true, force: true }).catch(() => {})
      touched.delete(name)
      log(`[host] ${name}: idle for ${idleMinutes} min and saved in a browser; removed from the host`)
    }
  }, 60_000)
  sweep.unref()

  try {
    await new Promise((resolve, reject) => { front.once("error", reject); front.listen(port, host, resolve) })
  } catch (error) {
    backend.stop()
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const bound = front.address().port
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${bound}`,
    root,
    gate,
    close: async () => {
      clearInterval(sweep)
      for (const close of [...tunnels]) close()
      front.closeAllConnections()
      await new Promise((resolve) => front.close(resolve))
      backend.stop()
      await Promise.race([backend.exited, new Promise((resolve) => setTimeout(resolve, 3000))])
      await rm(root, { recursive: true, force: true })
    },
    exited: backend.exited,
  }
}
