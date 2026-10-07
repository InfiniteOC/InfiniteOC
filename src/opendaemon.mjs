import http from "node:http"
import { spawn } from "node:child_process"
import { readFile, writeFile, mkdir, chmod, lstat, unlink, rename, readdir } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { daemonRequest } from "./daemon-client.mjs"
import { validateCommand } from "./tui-features.mjs"
import { buildLive } from "./live-build.mjs"

export const daemonPaths = base => ({ directory: path.join(base, ".opendaemon"), socket: path.join(base, ".opendaemon/control.sock"), manifest: path.join(base, ".opendaemon/live.json") })

async function digestTree(directory, hash) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (["node_modules", ".git", ".opendaemon", ".runtime"].includes(entry.name) || /\.(?:log|tmp)$/.test(entry.name)) continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await digestTree(file, hash)
    else if (entry.isFile()) hash.update(file).update(await readFile(file))
  }
}
export async function modsDigest(base) {
  const raw = await readFile(path.join(base, "infiniteoc.json"), "utf8")
  const config = JSON.parse(raw)
  const hash = createHash("sha256").update(raw)
  for (const directory of new Set(config.mods.map(entry => path.dirname(path.resolve(base, entry))))) await digestTree(directory, hash)
  return hash.digest("hex")
}

export async function startDaemon(base, { interval = 1000, compiler, temporaryCompiler = buildLive, autoReload = true } = {}) {
  const paths = daemonPaths(base)
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  if (!(await lstat(paths.directory)).isDirectory() || (await lstat(paths.directory)).isSymbolicLink()) throw new Error("opendaemon directory must not be a symlink")
  await chmod(paths.directory, 0o700)
  try {
    await lstat(paths.socket)
    let alive = false
    try { await daemonRequest(paths.socket, "GET", "/status"); alive = true } catch (error) {
      if (!["ECONNREFUSED", "ENOENT"].includes(error.code)) throw new Error("Cannot verify existing opendaemon socket; refusing to remove it")
    }
    if (alive) throw new Error("opendaemon is already running")
    if (!(await lstat(paths.socket)).isSocket()) throw new Error("Refusing to remove a non-socket daemon path")
    await unlink(paths.socket)
  } catch (error) { if (error.code !== "ENOENT") throw error }
  const state = { pid: process.pid, startedAt: new Date().toISOString(), autoReload, revision: null, phase: "starting", restartRequired: false, restartReason: null, job: null, events: [], clients: {}, messages: [] }
  const temporary = new Map()
  let temporaryBusy = false
  let baseline = await modsDigest(base)
  let pending = false, closed = false, checking = false, sequence = 0, worker
  const event = (stage, message, extra = {}) => {
    const record = { sequence: ++sequence, at: new Date().toISOString(), stage, message, ...extra }
    state.events.push(record); state.events = state.events.slice(-200)
    state.phase = stage
    return record
  }
  const defaultCompiler = revision => new Promise((resolve, reject) => {
    const resultFile = path.join(paths.directory, `${revision}.result.json`)
    worker = spawn(process.execPath, [fileURLToPath(new URL("./live-build.mjs", import.meta.url)), base, paths.directory, revision, resultFile], { stdio: ["ignore", "pipe", "pipe"] })
    let buffer = "", error = ""
    worker.stdout.on("data", data => {
      buffer += data
      const lines = buffer.split("\n"); buffer = lines.pop()
      for (const line of lines) { try { const update = JSON.parse(line); event(update.stage, update.message) } catch {} }
    })
    worker.stderr.on("data", data => { error = (error + data).slice(-2000) })
    worker.on("error", reject)
    worker.on("exit", async code => {
      worker = undefined
      try {
        if (code !== 0) throw new Error(error.trim() || "Live compiler failed")
        resolve(JSON.parse(await readFile(resultFile, "utf8")))
      } catch (e) { reject(e) } finally { await unlink(resultFile).catch(() => {}) }
    })
  })
  function reload(reason = "manual") {
    if (state.job?.status === "running") { pending = true; return state.job }
    const revision = randomUUID()
    const job = state.job = { id: revision, reason, status: "running", startedAt: new Date().toISOString() }
    event("queued", "Reload requested", { job: revision })
    void (async () => {
      try {
        const manifest = await (compiler || defaultCompiler)(revision, event)
        if (closed) return
        const currentDigest = await modsDigest(base)
        // Full source patches are compiled into the executable; never pretend
        // that swapping handler bundles updates backend or permission logic.
        if (currentDigest !== baseline) {
          state.restartRequired = true
          state.restartReason = "Mod files changed. Only declared ctx-only TUI commands were reloaded; compiled source patches/backend changes need a rebuild and restart. No process was interrupted."
        }
        const tmp = `${paths.manifest}.${revision}.tmp`
        await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
        await rename(tmp, paths.manifest)
        state.revision = manifest.revision
        job.status = "published"; job.finishedAt = new Date().toISOString()
        event("published", "Generation published; waiting for connected UI acknowledgements", { revision: manifest.revision })
      } catch {
        job.status = "failed"; job.finishedAt = new Date().toISOString()
        // Error excerpts may contain source secrets; publish only a safe summary.
        event("failed", "Live reload failed. Last working generation retained; check mod syntax, unique commands and ctx-only imports.")
      } finally {
        if (pending && !closed) { pending = false; reload("coalesced file changes") }
      }
    })()
    return job
  }
  const server = http.createServer(async (request, response) => {
    const send = (code, value) => { response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)) }
    try {
      const url = new URL(request.url, "http://local")
      let body = {}
      if (request.method === "POST") {
        let text = ""
        for await (const chunk of request) { text += chunk; if (text.length > 65536) { send(413, { error: "Request too large" }); return } }
        try { body = text ? JSON.parse(text) : {} } catch { send(400, { error: "Invalid JSON" }); return }
        if (!body || typeof body !== "object" || Array.isArray(body)) { send(400, { error: "Expected object" }); return }
      }
      if (request.method === "GET" && url.pathname === "/status") {
        send(200, { ...state, messages: state.messages.map(({ text, ...metadata }) => metadata), clients: Object.fromEntries(Object.entries(state.clients).filter(([, client]) => Date.now() - client.seenAt < 15000)) }); return
      }
      if (request.method === "POST" && url.pathname === "/reload") { send(202, reload("manual")); return }
      if (request.method === "POST" && url.pathname === "/temporary") {
        const client = body.client
        if (typeof client !== "string" || !state.clients[client] || Date.now() - state.clients[client].seenAt > 15000) { send(400, { error: "Choose a connected client ID from status" }); return }
        if (!state.clients[client].scripting) { send(409, { error: "This UI predates temporary scripting support; restart into the updated loader first" }); return }
        if (temporaryBusy) { send(409, { error: "A temporary change is compiling; retry after completion" }); return }
        if (body.clear === true) {
          temporary.delete(client)
          event("temporary-cleared", "Temporary commands cleared", { client })
          send(200, { client, status: "cleared" }); return
        }
        let command
        try { command = validateCommand("temporary", body.command) } catch { send(400, { error: "Invalid temporary command descriptor" }); return }
        if (command.source.length > 32000 || /(?:from\s*|import\s*\()["'](?:solid-js|@opentui|@opencode)/.test(command.source)) { send(400, { error: "Temporary command must be a bounded ctx-only handler" }); return }
        const existing = temporary.get(client)?.commands || []
        if (existing.length >= 20 && !existing.some(item => item.slash === command.slash)) { send(400, { error: "At most 20 temporary commands per UI" }); return }
        temporaryBusy = true
        try {
          const revision = randomUUID()
          const generation = await temporaryCompiler(base, paths.directory, revision, (stage, message) => event(stage, message), [command])
          if (body.run === true) {
            state.messages = state.messages.filter(item => Date.now() - item.createdAt < 30000)
            if (state.messages.length >= 100) { send(429, { error: "Message queue full" }); return }
            const message = { id: randomUUID(), action: "script", module: generation.commands[0].module, client, createdAt: Date.now(), acknowledgements: {} }
            state.messages.push(message)
            event("script-queued", "Trusted test script queued for one UI", { client, id: message.id })
            send(202, { client, id: message.id, status: "queued", lifetime: "one invocation; side effects are not automatically undone" }); return
          }
          const commands = [...existing.filter(item => item.slash !== command.slash), ...generation.commands]
          temporary.set(client, { revision, commands })
          event("temporary-published", "Temporary command published for one UI; not persisted as a mod", { client, revision })
          send(200, { client, revision, status: "published", lifetime: "this UI process only" })
        } finally { temporaryBusy = false }
        return
      }
      if (request.method === "POST" && url.pathname === "/auto") {
        if (typeof body.enabled !== "boolean") { send(400, { error: "enabled must be boolean" }); return }
        state.autoReload = body.enabled; send(200, { autoReload: state.autoReload }); return
      }
      if (request.method === "POST" && url.pathname === "/message") {
        if (!["notify", "close-all-tabs"].includes(body.action) || (body.action === "notify" && (typeof body.text !== "string" || body.text.length > 2000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(body.text)))) { send(400, { error: "Expected notify text (max 2000, no controls) or close-all-tabs" }); return }
        if (body.client !== undefined && (typeof body.client !== "string" || !state.clients[body.client])) { send(400, { error: "Unknown UI client" }); return }
        if (state.messages.filter(item => Date.now() - item.createdAt < 30000).length >= 100) { send(429, { error: "Message queue full" }); return }
        const message = { id: randomUUID(), action: body.action, text: body.action === "notify" ? body.text : "", client: body.client, createdAt: Date.now(), acknowledgements: {} }
        state.messages = state.messages.filter(item => Date.now() - item.createdAt < 30000)
        state.messages.push(message)
        event("message-queued", "UI message queued", { id: message.id, action: message.action })
        send(202, { id: message.id, status: "queued", expiresInMs: 30000 }); return
      }
      if (request.method === "POST" && url.pathname === "/poll") {
        if (typeof body.client !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.client) || (body.revision !== undefined && body.revision !== null && typeof body.revision !== "string")) { send(400, { error: "Invalid client" }); return }
        if (!state.clients[body.client] && Object.keys(state.clients).length >= 100) { send(429, { error: "Too many UI clients" }); return }
        const previous = state.clients[body.client]
        state.clients[body.client] = { seenAt: Date.now(), revision: body.revision ?? null, temporaryRevision: body.temporaryRevision ?? null, scripting: body.scripting === true }
        if (body.revision === state.revision && state.revision && previous?.revision !== body.revision) event("applied", "UI acknowledged live generation", { client: body.client, revision: body.revision })
        const messages = state.messages.filter(item => Date.now() - item.createdAt < 30000 && (!item.client || item.client === body.client) && !item.acknowledgements[body.client])
        const overlay = temporary.get(body.client)
        if (overlay && body.temporaryRevision === overlay.revision && previous?.temporaryRevision !== overlay.revision) event("temporary-applied", "UI acknowledged temporary commands", { client: body.client, revision: overlay.revision })
        send(200, { revision: state.revision, messages, temporary: overlay || { revision: null, commands: [] } }); return
      }
      if (request.method === "POST" && url.pathname === "/ack") {
        const message = state.messages.find(item => item.id === body.id)
        if (!message || (message.client && message.client !== body.client) || !state.clients[body.client] || !["applied", "failed"].includes(body.status)) { send(400, { error: "Invalid acknowledgement" }); return }
        message.acknowledgements[body.client] = { status: body.status, at: Date.now() }
        event("message-acknowledged", "UI action acknowledged", { id: body.id, client: body.client, status: body.status })
        send(200, { ok: true }); return
      }
      send(404, { error: "Unknown opendaemon operation" })
    } catch { send(500, { error: "opendaemon operation failed" }) }
  })
  server.requestTimeout = 10000
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(paths.socket, resolve) })
  await chmod(paths.socket, 0o600)
  const poll = setInterval(async () => {
    for (const [client] of temporary) if (!state.clients[client] || Date.now() - state.clients[client].seenAt > 60000) temporary.delete(client)
    if (checking || closed || !state.autoReload) return
    checking = true
    try {
      const next = await modsDigest(base)
      if (next !== baseline) { baseline = next; state.restartRequired = true; state.restartReason = "Local mod changes detected; live commands reload automatically, compiled patches still require restart."; reload("local mod files changed") }
    } catch { event("watch-error", "Cannot inspect configured mods; last working generation retained") }
    finally { checking = false }
  }, interval)
  reload("daemon startup")
  return { paths, state, reload, async close() {
    closed = true; clearInterval(poll)
    if (worker) { worker.kill("SIGTERM"); await new Promise(resolve => worker.once("exit", resolve)) }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  } }
}

export async function ensureDaemon(base) {
  const paths = daemonPaths(base)
  try { await daemonRequest(paths.socket, "GET", "/status"); return paths } catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error }
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/opendaemon.mjs", import.meta.url)), "serve", "--home", base], { detached: true, stdio: "ignore" })
  let launchError
  child.on("error", error => { launchError = error })
  child.unref()
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError
    await new Promise(resolve => setTimeout(resolve, 100))
    try { await daemonRequest(paths.socket, "GET", "/status"); return paths } catch {}
  }
  throw new Error("opendaemon did not start; use opendaemon serve to inspect startup")
}