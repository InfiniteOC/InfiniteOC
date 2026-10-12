import test from "node:test"
import assert from "node:assert/strict"
import module from "node:module"
import http from "node:http"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

// src/live-runtime.ts is compiled into the TUI. Run it under Node type stripping with
// solid-js and the upstream error helper stubbed, against a scripted fake opendaemon.
const supported = typeof module.registerHooks === "function" && Boolean(process.features.typescript)
const skip = !supported && "needs Node type stripping and module.registerHooks"
const imports = new Map()
const stub = source => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true })
if (supported) module.registerHooks({
  resolve(specifier, context, next) {
    imports.set(specifier, (imports.get(specifier) ?? 0) + 1)
    if (specifier === "solid-js") return stub("export const createSignal = value => [() => value, next => { value = next }]; export const onCleanup = fn => globalThis.liveCleanups.push(fn)")
    if (specifier === "../util/error") return stub("export const errorMessage = error => error.message")
    return next(specifier, context)
  },
})
const { createLiveCommands } = supported ? await import("../src/live-runtime.ts") : {}

async function waitUntil(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error("Timed out")
}
async function harness(t, { connected = true, notice = "", uiClient = "", ...state } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "iolive-"))
  const daemon = { revision: null, messages: [], temporary: { revision: null, commands: [] }, job: undefined, down: false, polls: [], acks: [], reloads: 0, ...state }
  const server = http.createServer(async (request, response) => {
    let text = ""
    for await (const chunk of request) text += chunk
    const body = text ? JSON.parse(text) : {}
    const send = (code, value) => { response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)) }
    if (request.url === "/poll") daemon.polls.push(body)
    if (daemon.down) send(503, { error: "opendaemon operation failed" })
    else if (request.url === "/poll") send(200, { revision: daemon.revision, messages: daemon.messages.filter(message => !daemon.acks.some(ack => ack.id === message.id)), temporary: daemon.temporary, ...(daemon.job === undefined ? {} : { job: daemon.job }) })
    else if (request.url === "/ack") { daemon.acks.push(body); send(200, { ok: true }) }
    else if (request.url === "/status") send(200, daemon.status)
    else if (request.url === "/reload") { daemon.reloads++; send(202, { status: "running" }) }
    else send(404, { error: "Unknown opendaemon operation" })
  })
  const socket = path.join(dir, "control.sock")
  await new Promise(resolve => server.listen(socket, resolve))
  const cleanups = globalThis.liveCleanups = []
  t.after(async () => {
    cleanups.forEach(fn => fn())
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })
  const manifest = path.join(dir, "live.json")
  Object.assign(process.env, { INFINITEOC_DAEMON_SOCKET: connected ? socket : "", INFINITEOC_LIVE_MANIFEST: manifest, INFINITEOC_NOTICE: notice, INFINITEOC_UI_CLIENT: uiClient })
  if (connected) t.mock.timers.enable({ apis: ["setInterval"] })
  const toasts = []
  const ctx = {
    closed: 0, choice: "reload",
    toast: { show: toast => toasts.push(toast) },
    dialog: { clear() {} },
    tabs: { tabs: () => ctx.open ?? [], current: () => ctx.active, async closeAll() { ctx.closed++; const n = (ctx.open ?? []).length; ctx.open = []; return n }, async restoreAll(...args) { ctx.restored = args; return args[0].length } },
    ui: { set() {}, async select(options) { ctx.selected = options; return ctx.choice }, async alert(options) { ctx.alerted = options } },
  }
  const commands = createLiveCommands(ctx, () => [])
  let count = 0
  const url = name => pathToFileURL(path.join(dir, name)).href
  const write = async source => { const name = `m${count++}.mjs`; await writeFile(path.join(dir, name), source); return url(name) }
  return {
    daemon, ctx, toasts, commands, url, write,
    run: slash => commands().find(command => command.slash.name === slash).run(),
    async publish(revision, entries) {
      const list = []
      for (const { slash, source, module } of entries) list.push({ id: `test.${slash}`, title: slash, category: "Mods", slash, aliases: [], module: module ?? await write(source) })
      await writeFile(manifest, JSON.stringify({ revision, commands: list }))
      daemon.revision = revision
    },
    // Polls are serialized, so a second served poll proves the first one, which
    // already saw the current fake state, has finished.
    async cycle() {
      const target = daemon.polls.length + 2
      for (let i = 0; daemon.polls.length < target; i++) {
        if (i > 200) throw new Error("Polling stalled")
        t.mock.timers.tick(750)
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    },
  }
}
const invalid = "Live generation invalid — last working commands kept"

test("messages are handled despite invalid generations, which are not re-imported every poll", { skip }, async t => {
  const { daemon, ctx, toasts, commands, url, publish, cycle } = await harness(t)
  const missing = url("missing.mjs"), missingTemporary = url("missing-temporary.mjs")
  await publish("r1", [{ slash: "broken", module: missing }])
  daemon.temporary = { revision: "t1", commands: [{ id: "temporary.demo", title: "Demo", category: "Mods", slash: "demo", aliases: [], module: missingTemporary }] }
  daemon.messages = [{ id: "n1", action: "notify", text: "first" }, { id: "n2", action: "notify", text: "second" }, { id: "c1", action: "close-all-tabs", text: "" }]
  await cycle(); await cycle()
  assert.equal(imports.get(missing), 1)
  assert.equal(imports.get(missingTemporary), 1)
  assert.equal(toasts.filter(toast => toast.message === invalid).length, 2)
  assert.deepEqual(toasts.filter(toast => toast.variant === "info").map(toast => toast.message), ["first\nsecond"])
  assert.equal(ctx.closed, 1)
  await waitUntil(() => daemon.acks.length === 3)
  assert.ok(daemon.acks.every(ack => ack.status === "applied"))
  // Seen ids are forgotten once the daemon stops sending them (it never re-sends those).
  await cycle()
  daemon.acks = daemon.acks.filter(ack => ack.id !== "n1")
  await cycle()
  assert.deepEqual(toasts.filter(toast => toast.variant === "info").map(toast => toast.message), ["first\nsecond", "first"])
  await publish("r2", [{ slash: "fixed", source: "export function run() {}" }])
  await cycle()
  assert.ok(toasts.some(toast => toast.message === "Live commands updated"))
  assert.ok(commands().some(command => command.slash.name === "fixed"))
})

test("long scripts do not stall polling and are acknowledged when they settle", { skip }, async t => {
  const { daemon, ctx, write, cycle } = await harness(t)
  let release
  globalThis.liveGate = new Promise(resolve => { release = resolve })
  const slow = await write("export async function run(ctx) { ctx.started = true; await globalThis.liveGate }")
  const broken = await write("export const run = 1")
  daemon.messages = [{ id: "s1", action: "script", text: "", module: slow }, { id: "s2", action: "script", text: "", module: broken }]
  await cycle(); await cycle()
  assert.equal(ctx.started, true)
  await waitUntil(() => daemon.acks.length === 1)
  assert.deepEqual(daemon.acks.map(ack => [ack.id, ack.status]), [["s2", "failed"]])
  release()
  await waitUntil(() => daemon.acks.length === 2)
  assert.deepEqual(daemon.acks[1], { client: daemon.polls[0].client, id: "s1", status: "applied" })
})

test("outages and failed daemon jobs warn once each; reconnection is confirmed", { skip }, async t => {
  // A job that failed before this UI connected stays silent.
  const { daemon, toasts, cycle } = await harness(t, { job: { id: "j0", status: "failed", reason: "daemon startup" } })
  await cycle()
  daemon.down = true
  await cycle(); await cycle()
  daemon.down = false
  await cycle()
  daemon.job = { id: "j1", status: "running", reason: "manual" }
  await cycle()
  daemon.job = { ...daemon.job, status: "failed" }
  await cycle(); await cycle()
  daemon.job = { id: "j2", status: "failed", reason: "manual", detail: "Duplicate TUI slash command: /x" }
  await cycle()
  assert.deepEqual(toasts, [
    { variant: "warning", message: "opendaemon unreachable — live reload paused; current commands keep working" },
    { variant: "info", message: "opendaemon reconnected", duration: 2000 },
    { variant: "warning", title: "Live reload failed", message: "Last working commands kept · run opendaemon status", duration: 5000 },
    { variant: "warning", title: "Live reload failed", message: "Duplicate TUI slash command: /x. Last working commands kept · run opendaemon status", duration: 5000 },
  ])
})

test("launch notice shows once, the startup generation is silent, later ones confirm and failures name the command", { skip }, async t => {
  const notice = "Traffic bridge unavailable; using a direct connection"
  const { toasts, publish, cycle, run } = await harness(t, { notice })
  assert.deepEqual(toasts, [{ variant: "warning", message: notice, duration: 8000 }])
  await publish("r1", [{ slash: "boom", source: "export function run() { throw new Error('kaput') }" }])
  await cycle()
  assert.equal(toasts.length, 1)
  await run("boom")
  assert.deepEqual(toasts.at(-1), { variant: "error", title: "/boom failed", message: "kaput" })
  await publish("r2", [{ slash: "boom", source: "export async function run() { throw new Error('async kaput') }" }])
  await cycle()
  assert.deepEqual(toasts.at(-1), { variant: "success", message: "Live commands updated", duration: 2000 })
  await run("boom")
  assert.deepEqual(toasts.at(-1), { variant: "error", title: "/boom failed", message: "async kaput" })
})

test("/live shows this UI's live status and can request a reload", { skip }, async t => {
  const status = { pid: 42, phase: "published", autoReload: false, revision: "abcdef1234567890", restartRequired: true, restartReason: "Mod files changed.", clients: { a: {}, b: {} }, events: [{ stage: "failed", message: "Live reload failed.", at: new Date().toISOString() }] }
  const { daemon, ctx, toasts, cycle, run } = await harness(t, { status })
  await cycle()
  await run("live")
  const rows = Object.fromEntries(ctx.selected.options.map(option => [option.title, option.footer]))
  assert.equal(rows["This UI"], daemon.polls[0].client)
  assert.equal(rows.Daemon, "pid 42 · published · auto off")
  assert.equal(rows["Live commands"], "loaded none · published abcdef12")
  assert.equal(rows.Restart, "required")
  assert.equal(rows["Connected UIs"], "2")
  assert.ok("Last failure" in rows)
  assert.equal(ctx.selected.options.at(-1).title, "Reload live commands now")
  assert.equal(daemon.reloads, 1)
  assert.deepEqual(toasts.at(-1), { variant: "success", message: "Live reload requested", duration: 2000 })
  ctx.choice = "client"
  await run("live")
  assert.equal(daemon.reloads, 1)
  const id = daemon.polls[0].client
  assert.deepEqual(ctx.alerted, { title: "This UI client ID", message: `${id}\nUse it with: opendaemon script ${id} FILE  (inside this UI's terminal or agent, CLIENT can be omitted)` })
  daemon.down = true
  await run("live")
  assert.deepEqual(toasts.at(-1), { variant: "warning", message: "opendaemon operation failed" })
  const detached = await harness(t, { connected: false })
  await detached.run("live")
  assert.deepEqual(detached.toasts, [{ variant: "info", message: "opendaemon is not connected; live reload is off in this UI. Start InfiniteOC through its launcher." }])
})

test("an opendaemon close-all-tabs request says so, keeps same-poll notifications visible and offers a one-write Undo", { skip }, async t => {
  const { daemon, ctx, toasts, cycle } = await harness(t)
  Object.assign(ctx, { open: [{ sessionID: "a" }, { sessionID: "b" }], active: "b" })
  daemon.messages = [{ id: "n1", action: "notify", text: "Freeing memory" }, { id: "c1", action: "close-all-tabs", text: "" }]
  await cycle()
  // Upstream show() replaces the visible toast at once, so one toast must carry both.
  assert.deepEqual(toasts.map(toast => toast.title), ["Closed 2 tabs (opendaemon request)"])
  const [toast] = toasts
  assert.match(toast.message, /^Freeing memory\nSaved sessions are unchanged/)
  await waitUntil(() => daemon.acks.length === 2)
  assert.ok(daemon.acks.every(ack => ack.status === "applied"))
  toast.action.run()
  await waitUntil(() => ctx.restored)
  assert.deepEqual(ctx.restored, [["a", "b"], "b"])
})

test("the launcher's UI client id is used when present", { skip }, async t => {
  const { daemon, cycle } = await harness(t, { uiClient: "ui-env" })
  await cycle()
  assert.equal(daemon.polls[0].client, "ui-env")
})
