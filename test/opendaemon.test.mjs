import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, utimes, symlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { startDaemon, ensureDaemon, modsDigest, daemonPaths, socketLimit, fileDigest, digestCache, digestTree } from "../src/opendaemon.mjs"
import { installDaemonTool } from "../src/opendaemon-tool.mjs"
import { safeError } from "../src/tui-features.mjs"
import { daemonRequest } from "../src/daemon-client.mjs"
// Personal mods (src/user-mods.mjs) must never touch the real ~/.config/infiniteoc/mods from a test.
process.env.INFINITEOC_MODS_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "ioc-personal-mods-"))
const personalModsDir = process.env.INFINITEOC_MODS_DIR, { rmSync: removeTree } = await import("node:fs")
process.on("exit", () => removeTree(personalModsDir, { recursive: true, force: true }))

async function makeBase(base) {
  base ??= await mkdtemp(path.join(tmpdir(), "iod-"))
  await mkdir(path.join(base, "mods/test"), { recursive: true })
  await writeFile(path.join(base, "infiniteoc.json"), JSON.stringify({ mods: ["mods/test/index.mjs"] }))
  await writeFile(path.join(base, "mods/test/index.mjs"), "first")
  return base
}
async function fixture(t, options = {}, before = async () => {}) {
  const base = await makeBase()
  await before(base)
  const daemon = await startDaemon(base, { interval: 25, compiler: async revision => ({ revision, commands: [] }), ...options })
  t.after(async () => { await daemon.close(); await rm(base, { recursive: true, force: true }) })
  return { base, daemon, call: (method, endpoint, body) => daemonRequest(daemon.paths.socket, method, endpoint, body) }
}
async function waitUntil(predicate) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error("Timed out")
}
test("same-user daemon publishes generations atomically and reports UI acknowledgements", async t => {
  const { daemon, call } = await fixture(t)
  await waitUntil(() => daemon.state.job.status === "published")
  assert.equal((await stat(daemon.paths.socket)).mode & 0o777, 0o600)
  assert.equal((await stat(daemon.paths.directory)).mode & 0o777, 0o700)
  const manifest = JSON.parse(await readFile(daemon.paths.manifest, "utf8"))
  assert.equal(manifest.revision, daemon.state.revision)
  await call("POST", "/poll", { client: "ui1", revision: manifest.revision })
  const status = await call("GET", "/status")
  assert.equal(status.clients.ui1.revision, manifest.revision)
  assert.ok(status.events.some(event => event.stage === "applied"))
  await assert.rejects(startDaemon(path.dirname(daemon.paths.directory)), /already running/)
})
test("local updates automatically reload and honestly flag compiled patches as restart required", async t => {
  const { base, daemon, call } = await fixture(t)
  await waitUntil(() => daemon.state.job.status === "published")
  const first = daemon.state.revision
  await writeFile(path.join(base, "mods/test/index.mjs"), "updated")
  await waitUntil(() => daemon.state.revision !== first)
  assert.equal(daemon.state.restartRequired, true)
  await call("POST", "/auto", { enabled: false })
  const second = daemon.state.revision
  await writeFile(path.join(base, "mods/test/index.mjs"), "again")
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(daemon.state.revision, second)
  await call("POST", "/reload", {})
  await waitUntil(() => daemon.state.revision !== second)
})
test("a rebuild newer than the flagged change clears restartRequired once no older UI is connected, and the same files never re-raise it", async t => {
  const { base, daemon, call } = await fixture(t, { autoReload: false })
  await waitUntil(() => daemon.state.job.status === "published")
  const marker = path.join(base, ".runtime/build.json")
  await mkdir(path.dirname(marker))
  await writeFile(marker, "{}")
  await utimes(marker, new Date(0), new Date(0))
  await writeFile(path.join(base, "mods/test/index.mjs"), "updated")
  let job = await call("POST", "/reload", {})
  await waitUntil(() => daemon.state.job.id === job.id && daemon.state.job.status === "published")
  assert.equal((await call("GET", "/status")).restartRequired, true, "an older build does not contain the change")
  await call("POST", "/poll", { client: "ui-old" })
  const later = new Date(Date.now() + 60000)
  await utimes(marker, later, later)
  assert.equal((await call("GET", "/status")).restartRequired, true, "a UI connected since before the rebuild runs the old binary")
  await call("POST", "/poll", { client: "ui-new" })
  daemon.state.clients["ui-new"].firstSeenAt = later.getTime() + 1 // launched after the rebuild
  daemon.state.clients["ui-old"].seenAt -= 16000 // closed
  const status = await call("GET", "/status")
  assert.equal(status.restartRequired, false)
  assert.equal(status.restartReason, null)
  await rm(marker) // nothing could clear a re-raised flag now
  job = await call("POST", "/reload", {})
  await waitUntil(() => daemon.state.job.id === job.id && daemon.state.job.status === "published")
  assert.equal((await call("GET", "/status")).restartRequired, false)
})
test("restartRequired survives a daemon restart until a newer build clears it for good", async t => {
  const base = await makeBase()
  const options = { interval: 25, autoReload: false, compiler: async revision => ({ revision, commands: [] }) }
  const status = () => daemonRequest(path.join(base, ".opendaemon/control.sock"), "GET", "/status")
  let daemon = await startDaemon(base, options)
  t.after(async () => { await daemon.close(); await rm(base, { recursive: true, force: true }) })
  const marker = path.join(base, ".runtime/build.json")
  await mkdir(path.dirname(marker))
  await writeFile(marker, "{}")
  await utimes(marker, new Date(0), new Date(0))
  await waitUntil(() => daemon.state.job.status === "published")
  await writeFile(path.join(base, "mods/test/index.mjs"), "patched")
  const job = daemon.reload()
  await waitUntil(() => job.status === "published")
  await daemon.close()
  daemon = await startDaemon(base, options)
  const restarted = await status()
  assert.equal(restarted.restartRequired, true, "opendaemon restart compiles nothing")
  assert.match(restarted.restartReason, /infiniteoc rebuild and a UI restart/)
  const later = new Date(Date.now() + 60000)
  await utimes(marker, later, later)
  assert.equal((await status()).restartRequired, false)
  await rm(marker) // a cleared flag must not come back with the next daemon
  await daemon.close()
  daemon = await startDaemon(base, options)
  assert.equal((await status()).restartRequired, false)
})
test("failed reload retains working generation, names only framework-tagged reasons and never exposes compiler source secrets", async t => {
  let failure
  const { daemon, call } = await fixture(t, { compiler: async revision => { if (failure) throw failure; return { revision, commands: [] } } })
  await waitUntil(() => daemon.state.job.status === "published")
  const before = await readFile(daemon.paths.manifest, "utf8")
  failure = new Error("API_KEY_PRIVATE_SOURCE")
  await call("POST", "/reload", {})
  await waitUntil(() => daemon.state.job.status === "failed")
  assert.equal(await readFile(daemon.paths.manifest, "utf8"), before)
  assert.doesNotMatch(JSON.stringify(await call("GET", "/status")), /API_KEY_PRIVATE_SOURCE/)
  assert.equal((await call("POST", "/poll", { client: "ui1" })).job.detail, undefined)
  failure = safeError("Duplicate TUI slash command: /x")
  const job = await call("POST", "/reload", {})
  await waitUntil(() => daemon.state.job.id === job.id && daemon.state.job.status === "failed")
  assert.equal((await call("POST", "/poll", { client: "ui1" })).job.detail, "Duplicate TUI slash command: /x")
  assert.equal((await call("GET", "/status")).events.findLast(event => event.stage === "failed").message, "Live reload failed: Duplicate TUI slash command: /x. Last working generation retained.")
})
test("the real live worker reports a framework-tagged reason, such as a handler importing solid-js", async t => {
  const base = await mkdtemp(path.join(tmpdir(), "iod-"))
  await mkdir(path.join(base, ".upstream"))
  await mkdir(path.join(base, "mods/bad"), { recursive: true })
  await writeFile(path.join(base, "infiniteoc.json"), JSON.stringify({ mods: ["mods/bad/index.mjs"] }))
  const source = "import { createSignal } from 'solid-js'\nexport function run(ctx) {}"
  await writeFile(path.join(base, "mods/bad/index.mjs"), `export default { id: "bad", setup(api) { api.tui.command({ id: "x", title: "X", slash: "xcmd", source: ${JSON.stringify(source)} }) } }`)
  const daemon = await startDaemon(base, { interval: 25 })
  t.after(async () => { await daemon.close(); await rm(base, { recursive: true, force: true }) })
  await waitUntil(() => daemon.state.job.status === "failed")
  const call = (method, endpoint, body) => daemonRequest(daemon.paths.socket, method, endpoint, body)
  assert.match((await call("POST", "/poll", { client: "ui1" })).job.detail, /cannot import framework modules/)
  assert.ok((await call("GET", "/status")).events.some(event => event.stage === "invalid"))
})
test("messages are bounded, acknowledged and have no arbitrary exec or file mutation endpoint", async t => {
  const { call } = await fixture(t)
  const message = await call("POST", "/message", { action: "notify", text: "sensitive-notification" })
  const poll = await call("POST", "/poll", { client: "ui1" })
  assert.equal(poll.messages[0].text, "sensitive-notification")
  await call("POST", "/ack", { client: "ui1", id: message.id, status: "applied" })
  assert.equal((await call("POST", "/poll", { client: "ui1" })).messages.length, 0)
  const status = await call("GET", "/status")
  assert.equal(status.messages[0].acknowledgements.ui1.status, "applied")
  assert.doesNotMatch(JSON.stringify(status), /sensitive-notification/)
  await assert.rejects(call("POST", "/exec", { command: "anything" }), /Unknown/)
  await assert.rejects(call("POST", "/message", { action: "notify", text: "\x1b[31m" }), /Expected notify/)
  await assert.rejects(call("POST", "/auto", { enabled: "yes" }), /boolean/)
})
test("reloads serialize and coalesce while the compiler is busy", async t => {
  let count = 0
  const { daemon, call } = await fixture(t, { compiler: async revision => { count++; await new Promise(resolve => setTimeout(resolve, 80)); return { revision, commands: [] } } })
  const first = await call("POST", "/reload", {})
  const second = await call("POST", "/reload", {})
  assert.equal(first.id, second.id)
  await waitUntil(() => count === 2 && daemon.state.job.status === "published")
  assert.equal(count, 2)
})
test("close waits for the in-flight reload, so nothing writes into .opendaemon afterwards", async t => {
  let settled = false
  const { daemon } = await fixture(t, { compiler: async revision => { await new Promise(resolve => setTimeout(resolve, 100)); settled = true; return { revision, commands: [] } } })
  await daemon.close()
  assert.equal(settled, true)
})
test("poll reports the current reload job to UIs", async t => {
  const { daemon, call } = await fixture(t)
  await waitUntil(() => daemon.state.job.status === "published")
  assert.deepEqual((await call("POST", "/poll", { client: "ui1" })).job, { id: daemon.state.job.id, status: "published", reason: "daemon startup" })
})
test("UI clients unseen for a minute are pruned, so new UIs are not locked out by the client cap", async t => {
  const { daemon, call } = await fixture(t)
  for (let i = 0; i < 100; i++) await call("POST", "/poll", { client: `old${i}` })
  await assert.rejects(call("POST", "/poll", { client: "new" }), /Too many UI clients/)
  for (const client of Object.values(daemon.state.clients)) client.seenAt -= 61000
  await waitUntil(() => Object.keys(daemon.state.clients).length === 0)
  assert.equal((await call("POST", "/poll", { client: "new" })).temporary.commands.length, 0)
})
test("day-old generations except the live one are removed after startup, without delaying it", async t => {
  const old = new Date(Date.now() - 25 * 3600 * 1000)
  const { daemon } = await fixture(t, {}, async base => {
    const generations = path.join(base, ".opendaemon/generations")
    for (const name of ["stale", "live", "fresh"]) await mkdir(path.join(generations, name), { recursive: true })
    await writeFile(path.join(base, ".opendaemon/live.json"), JSON.stringify({ revision: "live" }))
    for (const name of ["stale", "live"]) await utimes(path.join(generations, name), old, old)
  })
  // No I/O callback has run since startDaemon resolved, so an awaited cleanup would already be done.
  assert.ok(existsSync(path.join(daemon.paths.directory, "generations/stale")))
  await daemon.close() // waits for the cleanup
  assert.deepEqual((await readdir(path.join(daemon.paths.directory, "generations"))).sort(), ["fresh", "live"])
})
test("generation cleanup never follows a symlinked generations directory", async t => {
  const outside = await mkdtemp(path.join(tmpdir(), "iod-outside-"))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const old = new Date(Date.now() - 25 * 3600 * 1000)
  await mkdir(path.join(outside, "stale"))
  await utimes(path.join(outside, "stale"), old, old)
  const { daemon } = await fixture(t, {}, async base => {
    await mkdir(path.join(base, ".opendaemon"))
    await symlink(outside, path.join(base, ".opendaemon/generations"))
  })
  await daemon.close() // waits for the cleanup
  assert.ok(existsSync(path.join(outside, "stale")))
})
test("mods digest ignores OS/editor litter but tracks real edits", async t => {
  const base = await makeBase()
  t.after(() => rm(base, { recursive: true, force: true }))
  const before = await modsDigest(base)
  for (const name of [".DS_Store", ".x.swp", "x~", "#x#"]) await writeFile(path.join(base, "mods/test", name), "litter")
  assert.equal(await modsDigest(base), before)
  await writeFile(path.join(base, "mods/test/index.mjs"), "edited")
  assert.notEqual(await modsDigest(base), before)
})
test("file digests come from the stat cache when unchanged and still catch same-size edits", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-digest-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "a.txt"), later = Date.now() + 10_000
  await writeFile(file, "aaaa")
  const cache = new Map()
  const first = await fileDigest(file, cache, later)
  // A cached entry is used without reading: swap in a sentinel and get it back.
  cache.set(file, { ...cache.get(file), digest: "sentinel" })
  assert.equal(await fileDigest(file, cache, later), "sentinel")
  // Same size, new bytes: ctime moves, so the file is read again.
  await writeFile(file, "bbbb")
  const second = await fileDigest(file, cache, later)
  assert.notEqual(second, first)
  assert.notEqual(second, "sentinel")
  // Racy: a file changed just now is never cached.
  const fresh = new Map()
  await fileDigest(file, fresh, Date.now())
  assert.equal(fresh.size, 0)
})
test("a persisted digest cache keeps only files still present and reports changes", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-digest-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "a.txt"), "a")
  await writeFile(path.join(dir, "b.txt"), "b")
  const later = Date.now() + 10_000
  const warm = digestCache()
  for (const name of ["a.txt", "b.txt"]) await fileDigest(path.join(dir, name), warm, later)
  assert.equal(warm.changed, true)
  const saved = JSON.parse(JSON.stringify(warm))
  const again = digestCache(saved)
  for (const name of ["a.txt", "b.txt"]) await fileDigest(path.join(dir, name), again, later)
  assert.equal(again.changed, false)
  await rm(path.join(dir, "b.txt"))
  const pruned = digestCache(saved)
  await fileDigest(path.join(dir, "a.txt"), pruned, later)
  assert.equal(pruned.changed, true)
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(pruned))), [path.join(dir, "a.txt")])
  // The tree digest is the same whether file digests come from the cache or from disk.
  const h1 = createHash("sha256"), h2 = createHash("sha256")
  await digestTree(dir, h1, dir, new Map())
  await digestTree(dir, h2, dir, again)
  assert.equal(h1.digest("hex"), h2.digest("hex"))
})
test("ensureDaemon fails fast when the spawned daemon exits during startup", async t => {
  const base = await mkdtemp(path.join(tmpdir(), "iod-")) // no infiniteoc.json: serve exits at once
  t.after(() => rm(base, { recursive: true, force: true }))
  const started = Date.now()
  await assert.rejects(ensureDaemon(base), /exited during startup/)
  assert.ok(Date.now() - started < 5000)
})
test("the agent tool surfaces the daemon's static error instead of a generic failure", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "iod-tool-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, "packages/core/src/tool/plugin/opencode.ts")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, 'import { Effect, Schema } from "effect"\n        draft.add({\n          name: "session_rename",\n')
  await installDaemonTool(root)
  const installed = await readFile(file, "utf8")
  assert.ok(installed.includes('catch: (error) => new ToolFailure({ message: "opendaemon: " + (error as Error).message + ". The agent continues." })'))
  assert.ok(installed.includes("const client = input.client || process.env.INFINITEOC_UI_CLIENT"), "the agent's own UI is the default client")
  assert.ok(installed.includes('"/message", { action: input.action, text: input.text, client })'), "notify and close-all-tabs stay in that UI")
})
test("a socket path over the OS limit fails with an actionable error before anything is created; one at the limit works", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "iod-"))
  let daemon
  t.after(async () => { await daemon?.close(); await rm(root, { recursive: true, force: true }) })
  // daemonPaths(root).socket is root plus the socket suffix, so this base's socket is exactly `bytes` long.
  const sized = bytes => path.join(root, "x".repeat(bytes - Buffer.byteLength(daemonPaths(root).socket) - 1))
  if (Buffer.byteLength(daemonPaths(root).socket) + 2 > socketLimit) return t.skip("tmpdir is too long")
  const long = sized(socketLimit + 1)
  await mkdir(long)
  for (const start of [ensureDaemon, startDaemon]) await assert.rejects(start(long), { message: `opendaemon socket path is ${socketLimit + 1} bytes; this OS allows ${socketLimit}. Move InfiniteOC to a shorter directory` })
  assert.equal(existsSync(path.join(long, ".opendaemon")), false)
  daemon = await startDaemon(await makeBase(sized(socketLimit)), { interval: 25, compiler: async revision => ({ revision, commands: [] }) })
  assert.equal(Buffer.byteLength(daemon.paths.socket), socketLimit)
  assert.equal((await daemonRequest(daemon.paths.socket, "GET", "/status")).pid, process.pid)
})

test("temporary scripts target capable clients and overlays do not survive UI restart", async t => {
  const { base, call } = await fixture(t, { temporaryCompiler: async (_base, _output, revision, _progress, commands) => {
    if (commands[0].slash === "broken") throw new Error("compiler output with API_KEY_PRIVATE_SOURCE")
    if (commands[0].slash === "dup") throw safeError("Duplicate TUI slash command: /dup")
    return { revision, commands: commands.map(({ source, ...command }) => ({ ...command, module: "file:///trusted-test.mjs" })) }
  } })
  const source = "export function run(ctx) { ctx.toast.show({ message: 'private source' }) }"
  const command = { id: "demo", slash: "demo", title: "Demo", source }
  await call("POST", "/poll", { client: "old" })
  await assert.rejects(call("POST", "/temporary", { client: "old", command }), /predates/)
  await call("POST", "/poll", { client: "ui1", scripting: true })
  await assert.rejects(call("POST", "/temporary", { client: "ui1", command: {} }), /needs id and title/)
  const published = await call("POST", "/temporary", { client: "ui1", command })
  const overlay = await call("POST", "/poll", { client: "ui1", scripting: true, temporaryRevision: published.revision })
  assert.equal(overlay.temporary.commands[0].slash, "demo")
  await assert.rejects(call("POST", "/temporary", { client: "ui1", command: { ...command, id: "broken", slash: "broken" } }), error => /failed to build; check syntax, a slash not taken by a built-in command, and ctx-only imports/.test(error.message) && !/API_KEY|broken/.test(error.message))
  await assert.rejects(call("POST", "/temporary", { client: "ui1", command: { ...command, id: "dup", slash: "dup" } }), { message: "Duplicate TUI slash command: /dup. The previous overlay is retained" })
  assert.equal((await call("POST", "/poll", { client: "ui1", scripting: true })).temporary.revision, published.revision)
  assert.equal((await call("POST", "/poll", { client: "restarted", scripting: true })).temporary.commands.length, 0)
  const script = await call("POST", "/temporary", { client: "ui1", command, run: true })
  assert.equal(script.status, "queued")
  assert.equal((await call("POST", "/poll", { client: "restarted", scripting: true })).messages.length, 0)
  const poll = await call("POST", "/poll", { client: "ui1", scripting: true })
  assert.equal(poll.messages[0].action, "script")
  await call("POST", "/ack", { client: "ui1", id: script.id, status: "applied" })
  assert.equal((await call("POST", "/poll", { client: "ui1", scripting: true })).messages.length, 0)
  assert.doesNotMatch(JSON.stringify(await call("GET", "/status")), /private source|API_KEY/)
  await call("POST", "/temporary", { client: "ui1", clear: true })
  assert.equal((await call("POST", "/poll", { client: "ui1", scripting: true })).temporary.commands.length, 0)
  assert.equal(await readFile(path.join(base, "mods/test/index.mjs"), "utf8"), "first")
})
test("dev mode shows compiler diagnostics, reports reload time, polls faster, and also watches installed packs", async t => {
  let failure
  const { base, daemon, call } = await fixture(t, { interval: 5000, compiler: async revision => { if (failure) throw failure; return { revision, commands: [] } } })
  await waitUntil(() => daemon.state.job.status === "published")
  failure = new Error("syntax error at command.tsx:3")
  await call("POST", "/reload", {})
  await waitUntil(() => daemon.state.job.status === "failed")
  assert.equal(daemon.state.job.detail, undefined, "off by default")
  assert.deepEqual(await call("POST", "/dev", { enabled: true }), { dev: true, autoReload: true })
  await call("POST", "/reload", {})
  await waitUntil(() => daemon.state.job.status === "failed" && daemon.state.job.detail)
  assert.match(daemon.state.job.detail, /command\.tsx:3/)
  // A 5s interval would miss this within the test; dev mode checks every 250ms.
  failure = undefined
  await mkdir(path.join(base, "packs/demo"), { recursive: true })
  await writeFile(path.join(base, "packs/demo/index.mjs"), "pack v1")
  await writeFile(path.join(base, "infiniteoc.packs.json"), JSON.stringify({ demo: { url: "x", commit: "c", sha256: (await import("../src/packs.mjs").then(m => m.treeDigest(path.join(base, "packs/demo")))) } }))
  await waitUntil(() => daemon.state.job.status === "published" && daemon.state.job.reason === "local mod files changed")
  assert.equal(typeof (await call("GET", "/status")).events.findLast(event => event.stage === "published").ms, "number")
  assert.deepEqual(await call("POST", "/dev", { enabled: false }), { dev: false, autoReload: true })
  await assert.rejects(call("POST", "/dev", { enabled: "yes" }), /enabled must be boolean/)
})
