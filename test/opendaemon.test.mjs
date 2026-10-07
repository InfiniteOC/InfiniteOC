import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { startDaemon } from "../src/opendaemon.mjs"
import { daemonRequest } from "../src/daemon-client.mjs"

async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "iod-"))
  await mkdir(path.join(base, "mods/test"), { recursive: true })
  await writeFile(path.join(base, "infiniteoc.json"), JSON.stringify({ mods: ["mods/test/index.mjs"] }))
  await writeFile(path.join(base, "mods/test/index.mjs"), "first")
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
test("failed reload retains working generation and never exposes compiler source secrets", async t => {
  let fail = false
  const { daemon, call } = await fixture(t, { compiler: async revision => { if (fail) throw new Error("API_KEY_PRIVATE_SOURCE"); return { revision, commands: [] } } })
  await waitUntil(() => daemon.state.job.status === "published")
  const before = await readFile(daemon.paths.manifest, "utf8")
  fail = true
  await call("POST", "/reload", {})
  await waitUntil(() => daemon.state.job.status === "failed")
  assert.equal(await readFile(daemon.paths.manifest, "utf8"), before)
  assert.doesNotMatch(JSON.stringify(await call("GET", "/status")), /API_KEY_PRIVATE_SOURCE/)
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

test("temporary scripts target capable clients and overlays do not survive UI restart", async t => {
  const { base, call } = await fixture(t, { temporaryCompiler: async (_base, _output, revision, _progress, commands) => ({ revision, commands: commands.map(({ source, ...command }) => ({ ...command, module: "file:///trusted-test.mjs" })) }) })
  const source = "export function run(ctx) { ctx.toast.show({ message: 'private source' }) }"
  const command = { id: "demo", slash: "demo", title: "Demo", source }
  await call("POST", "/poll", { client: "old" })
  await assert.rejects(call("POST", "/temporary", { client: "old", command }), /predates/)
  await call("POST", "/poll", { client: "ui1", scripting: true })
  await assert.rejects(call("POST", "/temporary", { client: "ui1", command: {} }), /Invalid temporary/)
  const published = await call("POST", "/temporary", { client: "ui1", command })
  const overlay = await call("POST", "/poll", { client: "ui1", scripting: true, temporaryRevision: published.revision })
  assert.equal(overlay.temporary.commands[0].slash, "demo")
  assert.equal((await call("POST", "/poll", { client: "restarted", scripting: true })).temporary.commands.length, 0)
  const script = await call("POST", "/temporary", { client: "ui1", command, run: true })
  assert.equal(script.status, "queued")
  assert.equal((await call("POST", "/poll", { client: "restarted", scripting: true })).messages.length, 0)
  const poll = await call("POST", "/poll", { client: "ui1", scripting: true })
  assert.equal(poll.messages[0].action, "script")
  await call("POST", "/ack", { client: "ui1", id: script.id, status: "applied" })
  assert.equal((await call("POST", "/poll", { client: "ui1", scripting: true })).messages.length, 0)
  assert.doesNotMatch(JSON.stringify(await call("GET", "/status")), /private source/)
  await call("POST", "/temporary", { client: "ui1", clear: true })
  assert.equal((await call("POST", "/poll", { client: "ui1", scripting: true })).temporary.commands.length, 0)
  assert.equal(await readFile(path.join(base, "mods/test/index.mjs"), "utf8"), "first")
})