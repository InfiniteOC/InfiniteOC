import http from "node:http"
import { spawn } from "node:child_process"
import { readFile, writeFile, mkdir, chmod, lstat, stat, unlink, rename, readdir, rm } from "node:fs/promises"
import { writeFileSync, rmSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { daemonRequest } from "./daemon-client.mjs"
import { validateCommand, safeError } from "./tui-features.mjs"
import { buildLive } from "./live-build.mjs"
import { packEntries } from "./packs.mjs"
import { userModEntries } from "./user-mods.mjs"
import { checkSocket, daemonPaths, isWindows, socketLimit } from "./platform.mjs"

export { checkSocket, daemonPaths, socketLimit }

// chmod is a no-op for the Windows permission model; never let it fail a start there.
const safeChmod = async (file, mode) => { if (!isWindows) await chmod(file, mode) }

// The one ignore rule, shared with the launcher fingerprint: dependencies,
// dotfiles (.git, .DS_Store, .opendaemon, .runtime, vim swaps) and editor/log litter.
// Paths feed the hash relative to the tree root, so identical checkouts in
// different directories share a fingerprint (portable installs, prebuilt
// binaries). Note: this changes every fingerprint once; the next launch
// rebuilds, then later launches reuse the build again.
export async function digestTree(directory, hash, base = directory, cache = fileDigests) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (/^(?:node_modules$|\.)|~$|^#.*#$|\.(?:log|tmp)$/.test(entry.name)) continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await digestTree(file, hash, base, cache)
    else if (entry.isFile()) hash.update(path.relative(base, file)).update("\0").update(await fileDigest(file, cache)).update("\n")
  }
}
// Per-file content digests reused while size, mtime, ctime and inode are unchanged, so a check stats the
// tree instead of reading every byte (the daemon checks every second). Files changed in the last two
// seconds are always re-read: coarse filesystem clocks could hide a same-size edit inside one tick.
const fileDigests = new Map()
const RACY_MS = 2000
export async function fileDigest(file, cache = fileDigests, now = Date.now()) {
  const info = await stat(file)
  const key = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`
  const hit = cache.get(file)
  if (hit?.key === key) { cache.set(file, hit); return hit.digest }
  const digest = createHash("sha256").update(await readFile(file)).digest("hex")
  if (now - Math.max(info.mtimeMs, info.ctimeMs) > RACY_MS) cache.set(file, { key, digest })
  return digest
}
/** A digest cache that keeps only the files used since it was created, for persisting between launches. */
export function digestCache(entries = {}) {
  const previous = new Map(Object.entries(entries)), used = new Map()
  let changed = false
  return {
    get: file => used.get(file) ?? previous.get(file),
    set(file, value) { if (previous.get(file)?.key !== value.key) changed = true; used.set(file, value) },
    get changed() { return changed || used.size !== previous.size },
    toJSON: () => Object.fromEntries(used),
  }
}
export async function modsDigest(base) {
  const raw = await readFile(path.join(base, "infiniteoc.json"), "utf8")
  const config = JSON.parse(raw)
  const hash = createHash("sha256").update(raw)
  // Installed packs are watched like mods; one that no longer matches its pin drops out of the list, which also changes the digest.
  // ponytail: pack files are hashed twice per check (pin verification, then here); a pack of a few files makes that negligible.
  const mods = [...config.mods, ...(await packEntries(base)).entries, ...(await userModEntries()).entries]
  for (const directory of new Set(mods.map(entry => path.dirname(path.resolve(base, entry))))) await digestTree(directory, hash)
  return hash.digest("hex")
}

export async function startDaemon(base, { interval = 1000, compiler, temporaryCompiler = buildLive, autoReload = true } = {}) {
  const paths = daemonPaths(base)
  checkSocket(paths.socket)
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  if (!(await lstat(paths.directory)).isDirectory() || (await lstat(paths.directory)).isSymbolicLink()) throw new Error("opendaemon directory must not be a symlink")
  await safeChmod(paths.directory, 0o700)
  if (!paths.pipe) {
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
  } else {
    // Named pipes vanish with their server: only refuse when one answers.
    try { await daemonRequest(paths.socket, "GET", "/status"); throw new Error("opendaemon is already running") } catch (error) {
      if (error.message === "opendaemon is already running") throw error
    }
  }
  // Read before the startup reload republishes it; old generations are collected after listen.
  const generations = path.join(paths.directory, "generations")
  const live = await readFile(paths.manifest, "utf8").then(text => JSON.parse(text).revision).catch(() => null)
  // A raised flag outlives the daemon: `opendaemon restart` compiles nothing, only a rebuild does.
  const restartFile = path.join(paths.directory, "restart.json")
  const saved = await readFile(restartFile, "utf8").then(JSON.parse).catch(() => null)
  const state = { pid: process.pid, startedAt: new Date().toISOString(), autoReload, dev: false, revision: null, phase: "starting", restartRequired: Boolean(saved), restartReason: saved?.reason ?? null, job: null, events: [], clients: {}, messages: [] }
  const temporary = new Map()
  let temporaryBusy = false
  // `flagged` is the mod digest restartRequired last accounted for, so a rebuild-cleared flag is not re-raised for the same files.
  let baseline = await modsDigest(base), flagged = baseline, restartRequiredAt = Number(saved?.at) || 0
  let pending = false, closed = false, checking = false, sequence = 0, worker, running
  const flag = (digest, reason) => {
    if (digest === flagged) return
    flagged = digest; restartRequiredAt = Date.now()
    state.restartRequired = true; state.restartReason = reason
    // Sync, so the record never lands out of order or after close().
    try { writeFileSync(restartFile, JSON.stringify({ at: restartRequiredAt, reason }), { mode: 0o600 }) } catch {}
  }
  const event = (stage, message, extra = {}) => {
    const record = { sequence: ++sequence, at: new Date().toISOString(), stage, message, ...extra }
    state.events.push(record); state.events = state.events.slice(-200)
    state.phase = stage
    return record
  }
  const defaultCompiler = revision => new Promise((resolve, reject) => {
    const resultFile = path.join(paths.directory, `${revision}.result.json`)
    worker = spawn(process.execPath, [fileURLToPath(new URL("./live-build.mjs", import.meta.url)), base, paths.directory, revision, resultFile], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, INFINITEOC_LIVE_DEV: state.dev ? "1" : "0" } })
    let buffer = "", error = "", invalid
    worker.stdout.on("data", data => {
      buffer += data
      const lines = buffer.split("\n"); buffer = lines.pop()
      for (const line of lines) { try { const update = JSON.parse(line); event(update.stage, update.message); if (update.stage === "invalid") invalid = update.message } catch {} }
    })
    worker.stderr.on("data", data => { error = (error + data).slice(-2000) })
    worker.on("error", reject)
    worker.on("exit", async code => {
      worker = undefined
      try {
        if (code !== 0) throw invalid ? safeError(invalid) : new Error(error.trim() || "Live compiler failed")
        resolve(JSON.parse(await readFile(resultFile, "utf8")))
      } catch (e) { reject(e) } finally { await unlink(resultFile).catch(() => {}) }
    })
  })
  function reload(reason = "manual") {
    if (state.job?.status === "running") { pending = true; return state.job }
    const revision = randomUUID()
    const job = state.job = { id: revision, reason, status: "running", startedAt: new Date().toISOString() }
    event("queued", "Reload requested", { job: revision })
    running = (async () => {
      try {
        const manifest = await (compiler || defaultCompiler)(revision, event)
        if (closed) return
        // Full source patches are compiled into the executable; never pretend
        // that swapping handler bundles updates backend or permission logic.
        flag(await modsDigest(base), "Mod files changed. Only declared ctx-only TUI commands were reloaded; compiled source patches/backend changes need infiniteoc rebuild and a UI restart. No process was interrupted.")
        const tmp = `${paths.manifest}.${revision}.tmp`
        await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
        await rename(tmp, paths.manifest)
        state.revision = manifest.revision
        job.status = "published"; job.finishedAt = new Date().toISOString()
        event("published", "Generation published; waiting for connected UI acknowledgements", { revision: manifest.revision, ms: Date.parse(job.finishedAt) - Date.parse(job.startedAt) })
      } catch (error) {
        job.status = "failed"; job.finishedAt = new Date().toISOString()
        // Error excerpts may contain source secrets; publish only a safe summary or a framework-tagged reason.
        // Dev mode (opendaemon dev) is an explicit opt-in on this same-user socket: the compiler's own diagnostics are shown.
        if (error?.safe) job.detail = error.message
        else if (state.dev && error?.message) job.detail = error.message.slice(0, 1500)
        event("failed", job.detail ? `Live reload failed: ${job.detail}. Last working generation retained.` : "Live reload failed. Last working generation retained; check mod syntax, unique commands and ctx-only imports.")
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
        const clients = Object.fromEntries(Object.entries(state.clients).filter(([, client]) => Date.now() - client.seenAt < 15000))
        // A rebuild that finished after the flag was raised compiled those changes, but UIs connected since before it run the old binary.
        // ponytail: build.json mtime and first-seen are proxies: an edit made mid-rebuild clears early, and a daemon restart forgets
        // which UIs predate the rebuild; compare a mods digest/build start in build.json and a UI start time in /poll if those appear.
        const built = state.restartRequired && await stat(path.join(base, ".runtime/build.json")).catch(() => null)
        if (built && built.mtimeMs > restartRequiredAt && Object.values(clients).every(client => client.firstSeenAt > built.mtimeMs)) {
          state.restartRequired = false; state.restartReason = null
          try { rmSync(restartFile, { force: true }) } catch {}
        }
        send(200, { ...state, messages: state.messages.map(({ text, ...metadata }) => metadata), clients }); return
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
        // validateCommand messages are static and never echo the submitted input.
        try { command = validateCommand("temporary", body.command) } catch (error) { send(400, { error: error.message }); return }
        if (command.source.length > 32000 || /(?:from\s*|import\s*\()["'](?:solid-js|@opentui|@opencode)/.test(command.source)) { send(400, { error: "Temporary command must be a bounded ctx-only handler" }); return }
        const existing = temporary.get(client)?.commands || []
        if (existing.length >= 20 && !existing.some(item => item.slash === command.slash)) { send(400, { error: "At most 20 temporary commands per UI" }); return }
        temporaryBusy = true
        try {
          const revision = randomUUID()
          let failure
          const generation = await temporaryCompiler(base, paths.directory, revision, (stage, message) => event(stage, message), [command]).catch(error => { if (error?.safe) failure = error.message; return null })
          // Compiler errors can echo source literals; report a static summary or a framework-tagged reason only.
          if (!generation) { event("temporary-failed", "Temporary command failed to build; previous overlay retained", { client }); send(400, { error: `${failure ?? "Temporary command failed to build; check syntax, a slash not taken by a built-in command, and ctx-only imports"}. The previous overlay is retained` }); return }
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
      if (request.method === "POST" && url.pathname === "/dev") {
        if (typeof body.enabled !== "boolean") { send(400, { error: "enabled must be boolean" }); return }
        state.dev = body.enabled
        // Dev mode implies watching local files; leaving it keeps whatever the user had.
        if (body.enabled) state.autoReload = true
        schedule()
        event("dev", state.dev ? "Dev mode on: files are checked every 250ms and compile errors show their diagnostics" : "Dev mode off")
        send(200, { dev: state.dev, autoReload: state.autoReload }); return
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
        state.clients[body.client] = { seenAt: Date.now(), firstSeenAt: previous?.firstSeenAt ?? Date.now(), revision: body.revision ?? null, temporaryRevision: body.temporaryRevision ?? null, scripting: body.scripting === true }
        if (body.revision === state.revision && state.revision && previous?.revision !== body.revision) event("applied", "UI acknowledged live generation", { client: body.client, revision: body.revision })
        const messages = state.messages.filter(item => Date.now() - item.createdAt < 30000 && (!item.client || item.client === body.client) && !item.acknowledgements[body.client])
        const overlay = temporary.get(body.client)
        if (overlay && body.temporaryRevision === overlay.revision && previous?.temporaryRevision !== overlay.revision) event("temporary-applied", "UI acknowledged temporary commands", { client: body.client, revision: overlay.revision })
        send(200, { revision: state.revision, messages, temporary: overlay || { revision: null, commands: [] }, job: state.job ? { id: state.job.id, status: state.job.status, reason: state.job.reason, detail: state.job.detail } : null }); return
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
  await safeChmod(paths.socket, 0o600).catch(() => {})
  // ponytail: generations are collected only at startup, so a long-lived daemon still grows until restarted.
  // Not awaited, so a large backlog never delays startup; never through a symlinked generations directory.
  const collect = (async () => {
    if (!(await lstat(generations).catch(() => null))?.isDirectory()) return
    for (const name of await readdir(generations).catch(() => [])) {
      const generation = path.join(generations, name)
      try { if (name !== live && Date.now() - (await lstat(generation)).mtimeMs > 86400000) await rm(generation, { recursive: true, force: true }) } catch {}
    }
  })()
  let poll
  const tick = async () => {
    // Pruning frees the 100-client cap for new UIs; it runs even with auto reload off.
    for (const [client, { seenAt }] of Object.entries(state.clients)) if (Date.now() - seenAt > 60000) delete state.clients[client]
    for (const [client] of temporary) if (!state.clients[client]) temporary.delete(client)
    if (checking || closed || !state.autoReload) return
    checking = true
    try {
      const next = await modsDigest(base)
      // Re-check after the await: auto may have been disabled (or the daemon closed) meanwhile.
      if (next !== baseline && state.autoReload && !closed) { baseline = next; flag(next, "Local mod changes detected; live commands reload automatically, compiled patches still need infiniteoc rebuild and a UI restart."); reload("local mod files changed") }
    } catch { event("watch-error", "Cannot inspect configured mods; last working generation retained") }
    finally { checking = false }
  }
  const schedule = () => { clearTimeout(poll); if (closed) return; poll = setTimeout(async () => { await tick(); if (!closed) schedule() }, state.dev ? Math.min(interval, 250) : interval) }
  schedule()
  reload("daemon startup")
  return { paths, state, reload, async close() {
    closed = true; clearTimeout(poll)
    if (worker) { worker.kill("SIGTERM"); await new Promise(resolve => worker.once("exit", resolve)) }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    // Resolve only once nothing writes into .opendaemon anymore (in-flight publish, generation cleanup).
    await Promise.all([running, collect])
  } }
}

export async function ensureDaemon(base) {
  const paths = daemonPaths(base)
  checkSocket(paths.socket)
  try { await daemonRequest(paths.socket, "GET", "/status"); return paths } catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error }
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  // cwd: base, so the detached daemon never pins the user's project directory.
  // windowsHide: no console popup on Windows; still user-local, no service registration.
  const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/opendaemon.mjs", import.meta.url)), "serve", "--home", base], { cwd: base, detached: true, stdio: "ignore", windowsHide: true })
  let failure
  child.on("error", error => { failure = error })
  child.on("exit", () => { failure ??= new Error("opendaemon exited during startup; run opendaemon serve to see why") })
  child.unref()
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    const exited = failure
    try { await daemonRequest(paths.socket, "GET", "/status"); return paths } catch {}
    // That probe ran after the child exited: a racing daemon may have won; otherwise fail now, not after 10s.
    if (exited) throw exited
  }
  throw new Error("opendaemon did not start; use opendaemon serve to inspect startup")
}