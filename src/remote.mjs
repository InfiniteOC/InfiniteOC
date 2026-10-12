// Remote control: a phone-friendly page that lists sessions and pending permission prompts and lets you approve
// (once) or deny them. Opt-in: nothing listens until `infiniteoc remote` is run. It starts its own `opencode serve`
// backend on loopback with a random password, and puts a small authenticated front on a private-network address that
// forwards exactly three operations to it (list sessions, list pending prompts, reply once/reject).
// Plain HTTP: use it on a network you trust, or tunnel it (ssh -L, Tailscale).
import http from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { readFile, writeFile, rm, mkdir } from "node:fs/promises"
import { networkInterfaces } from "node:os"
import { join } from "node:path"

const asset = (name) => readFile(new URL(name, import.meta.url), "utf8")
const ID = /^[A-Za-z0-9_-]{1,100}$/

/** Loopback, RFC1918, link-local and unique-local addresses: the "local network". */
export function isPrivate(address = "") {
  const ip = address.replace(/^::ffff:/i, "")
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  return net.isIPv6(ip) && (ip === "::1" || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip))
}

/** The first private IPv4 address of this machine, else loopback. */
export function lanAddress(interfaces = networkInterfaces()) {
  for (const list of Object.values(interfaces)) for (const item of list ?? []) if (item.family === "IPv4" && !item.internal && isPrivate(item.address)) return item.address
  return "127.0.0.1"
}

const digest = (text) => createHash("sha256").update(text).digest()

/**
 * The authenticated front. `backend` = { url, password }. Returns an http.Server (not yet listening).
 * `allowed(address)` decides which clients may talk to it at all (default: private addresses only).
 */
export async function createFront({ backend, token, allowed = isPrivate }) {
  const [html, css, js] = await Promise.all([asset("remote-page.html"), asset("remote-page.css"), asset("remote-page.js")])
  const expected = digest(token)
  const failures = new Map()
  const auth = `Basic ${Buffer.from(`opencode:${backend.password}`).toString("base64")}`
  const call = async (path, init) => {
    const response = await fetch(`${backend.url}${path}`, { ...init, headers: { authorization: auth, "content-type": "application/json" }, signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw Object.assign(new Error(`backend ${response.status}`), { status: response.status })
    return response.status === 204 ? undefined : response.json()
  }
  const files = { "/": ["text/html; charset=utf-8", html], "/app.css": ["text/css; charset=utf-8", css], "/app.js": ["text/javascript; charset=utf-8", js] }

  return http.createServer(async (request, response) => {
    const send = (status, body, type = "application/json") => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" })
      response.end(typeof body === "string" ? body : JSON.stringify(body))
    }
    const client = request.socket.remoteAddress ?? ""
    if (!allowed(client)) return send(403, { error: "Local network only" })
    try {
      const url = new URL(request.url, "http://local")
      if (request.method === "GET" && files[url.pathname]) return send(200, files[url.pathname][1], files[url.pathname][0])
      if (!url.pathname.startsWith("/api/")) return send(404, { error: "Not found" })
      // Token check with a per-address failure limit: 8 wrong tries per minute.
      const recent = (failures.get(client) ?? []).filter((time) => Date.now() - time < 60_000)
      if (recent.length >= 8) return send(429, { error: "Too many wrong tries" })
      const given = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? ""
      if (!timingSafeEqual(digest(given), expected)) { failures.set(client, [...recent, Date.now()]); return send(401, { error: "Unauthorized" }) }
      if (request.method === "GET" && url.pathname === "/api/state") {
        const [sessions, requests] = await Promise.all([call("/api/session"), call("/api/permission/request")])
        const titles = new Map(sessions.data.map((session) => [session.id, session.title]))
        return send(200, {
          sessions: sessions.data.slice(0, 30).map((session) => ({ id: session.id, title: session.title, directory: session.location?.directory, outcome: session.outcome, updated: session.time?.updated })),
          permissions: requests.data.map((ask) => ({ id: ask.id, sessionID: ask.sessionID, sessionTitle: titles.get(ask.sessionID), action: ask.action, resources: (ask.resources ?? []).map(String).slice(0, 20), agent: ask.agent })),
        })
      }
      if (request.method === "POST" && url.pathname === "/api/reply") {
        let text = ""
        for await (const chunk of request) { text += chunk; if (text.length > 4096) return send(413, { error: "Request too large" }) }
        let body
        try { body = JSON.parse(text) } catch { return send(400, { error: "Invalid JSON" }) }
        // Only approve-once and deny exist here; "always" would write a permanent rule from a phone.
        const decision = { approve: "once", deny: "reject" }[body?.decision]
        if (!decision || !ID.test(body?.sessionID ?? "") || !ID.test(body?.requestID ?? "")) return send(400, { error: "Invalid reply" })
        await call(`/api/session/${body.sessionID}/permission/${body.requestID}/reply`, { method: "POST", body: JSON.stringify({ decision }) })
        return send(204, "")
      }
      send(404, { error: "Not found" })
    } catch (error) { send(error.status === 404 ? 404 : 502, { error: error.status === 404 ? "That request is no longer pending" : "The OpenCode backend did not answer" }) }
  })
}

const freePort = () => new Promise((resolve, reject) => { const probe = net.createServer(); probe.once("error", reject); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)) }) })
export const remoteFile = (home) => join(home, ".runtime", "remote.json")

/**
 * Starts the backend and the front. Returns { url, token, backendUrl, password, close }.
 * `host` must be a private address; anything else is refused.
 */
export async function startRemote({ home, binary, env, cwd = process.cwd(), host = lanAddress(), port = 0, token = randomBytes(18).toString("base64url") }) {
  if (!isPrivate(host)) throw new Error(`${host} is not a private network address; remote control is local network only`)
  const password = randomBytes(24).toString("base64url")
  const backendPort = await freePort()
  const backendUrl = `http://127.0.0.1:${backendPort}`
  // PWD as well as cwd: the backend resolves project paths from it.
  const backend = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(backendPort)], { cwd, env: { ...env, PWD: cwd, OPENCODE_PASSWORD: password }, stdio: ["ignore", "ignore", "pipe"] })
  let stderr = ""
  backend.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-1000)))
  let exited = false
  backend.on("exit", () => (exited = true))
  const stop = () => { if (!exited) backend.kill("SIGTERM") }
  try {
    for (let attempt = 0; ; attempt++) {
      if (exited) throw new Error(`The OpenCode backend exited during startup${stderr ? `: ${stderr.trim()}` : ""}`)
      if (attempt > 150) throw new Error("The OpenCode backend did not start within 30s")
      const up = await fetch(`${backendUrl}/api/session`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false)
      if (up) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const front = await createFront({ backend: { url: backendUrl, password }, token })
    await new Promise((resolve, reject) => { front.once("error", reject); front.listen(port, host, resolve) })
    const url = `http://${host.includes(":") ? `[${host}]` : host}:${front.address().port}`
    await mkdir(join(home, ".runtime"), { recursive: true })
    await writeFile(remoteFile(home), JSON.stringify({ pid: process.pid, url, backendUrl, password, startedAt: new Date().toISOString() }), { mode: 0o600 })
    return {
      url, token, backendUrl, password,
      close: async () => { front.closeAllConnections(); await new Promise((resolve) => front.close(resolve)); stop(); await rm(remoteFile(home), { force: true }) },
      exited: new Promise((resolve) => backend.on("exit", resolve)),
    }
  } catch (error) { stop(); throw error }
}
