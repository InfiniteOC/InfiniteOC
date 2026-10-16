import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, mkdir, writeFile, rm, readlink, realpath } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { startDaemon, daemonPaths, socketLimit } from "../src/opendaemon.mjs"
import { daemonRequest } from "../src/daemon-client.mjs"
// Personal mods (src/user-mods.mjs) must never touch the real ~/.config/infiniteoc/mods from a test.
process.env.INFINITEOC_MODS_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "ioc-personal-mods-"))

const cli = fileURLToPath(new URL("../bin/opendaemon.mjs", import.meta.url))
const stub = { interval: 25, compiler: async revision => ({ revision, commands: [] }) }
// A bogus inherited socket proves that --home takes precedence.
const env = base => ({ ...process.env, INFINITEOC_DAEMON_SOCKET: path.join(base, "inherited.sock") })
const run = (base, ...args) => promisify(execFile)(process.execPath, [cli, "--home", base, ...args], { env: env(base) })
const cwdOf = async pid => process.platform === "linux" ? readlink(`/proc/${pid}/cwd`) : /^n(.*)$/m.exec((await promisify(execFile)("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])).stdout)[1]
async function makeBase() {
  const base = await mkdtemp(path.join(tmpdir(), "iodc-"))
  await mkdir(path.join(base, "mods/test"), { recursive: true })
  await writeFile(path.join(base, "infiniteoc.json"), JSON.stringify({ mods: ["mods/test/index.mjs"] }))
  await writeFile(path.join(base, "mods/test/index.mjs"), "export default { id: 'test', setup() {} }")
  return base
}
async function waitUntil(predicate) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error("Timed out")
}

test("status prints a readable summary and --json keeps the raw /status shape", async t => {
  const base = await makeBase()
  const daemon = await startDaemon(base, stub) // in-process: never run `stop` against it
  t.after(async () => { await daemon.close(); await rm(base, { recursive: true, force: true }) })
  await waitUntil(() => daemon.state.job.status === "published")
  const revision = daemon.state.revision
  await daemonRequest(daemon.paths.socket, "POST", "/poll", { client: "ui-new", revision, scripting: true })
  await daemonRequest(daemon.paths.socket, "POST", "/poll", { client: "ui-old" })
  const { stdout } = await run(base, "status")
  assert.match(stdout, new RegExp(`^opendaemon pid ${process.pid}, up \\d+s, auto on$`, "m"))
  assert.match(stdout, new RegExp(`^revision: ${revision} \\(published \\d+s ago\\)$`, "m"))
  assert.match(stdout, /^last job: published \(daemon startup\)$/m)
  assert.match(stdout, /^restart required: no$/m)
  assert.match(stdout, new RegExp(`^  ui-new  scripting: true  revision: ${revision}$`, "m"))
  assert.match(stdout, /^  ui-old  scripting: false  revision: none$/m)
  assert.match(stdout, /^  \d\d:\d\d:\d\d  published  Generation published/m)
  const raw = JSON.parse((await run(base, "status", "--json")).stdout)
  assert.deepEqual(Object.keys(raw), Object.keys(await daemonRequest(daemon.paths.socket, "GET", "/status")))
  assert.equal(raw.clients["ui-new"].scripting, true)
  assert.deepEqual(Object.keys(JSON.parse((await run(base, "--json")).stdout)), Object.keys(raw), "--json alone is status --json")
})

test("inside an InfiniteOC UI, CLIENT defaults to that UI; with --home it stays required", async t => {
  const base = await makeBase()
  const daemon = await startDaemon(base, stub)
  t.after(async () => { await daemon.close(); await rm(base, { recursive: true, force: true }) })
  await daemonRequest(daemon.paths.socket, "POST", "/poll", { client: "ui-own", scripting: true })
  const { stdout } = await promisify(execFile)(process.execPath, [cli, "temporary-clear"], { env: { ...process.env, INFINITEOC_DAEMON_SOCKET: daemon.paths.socket, INFINITEOC_UI_CLIENT: "ui-own" } })
  assert.deepEqual(JSON.parse(stdout), { client: "ui-own", status: "cleared" })
  await assert.rejects(promisify(execFile)(process.execPath, [cli, "--home", base, "temporary-clear"], { env: { ...env(base), INFINITEOC_UI_CLIENT: "ui-own" } }), error => error.code === 1 && /CLIENT required outside an InfiniteOC UI/.test(error.stderr))
})

test("an over-long socket path is named by every command, not only start", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "iodc-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const base = path.join(root, "x".repeat(Math.max(1, socketLimit - Buffer.byteLength(daemonPaths(root).socket)))) // socket over the limit
  for (const command of ["status", "restart"]) await assert.rejects(run(base, command), error => error.code === 1 && /Move InfiniteOC to a shorter directory/.test(error.stderr), command)
})

test("stop refuses to signal a daemon that reports an invalid pid", async t => {
  const base = await makeBase()
  await mkdir(path.join(base, ".opendaemon"))
  // Only pids that make process.kill throw even if the guard regressed; never 0, -1 or 1.
  let pid
  const fake = http.createServer((request, response) => response.end(JSON.stringify({ pid })))
  await new Promise(resolve => fake.listen(path.join(base, ".opendaemon/control.sock"), resolve))
  t.after(async () => { await new Promise(resolve => fake.close(resolve)); await rm(base, { recursive: true, force: true }) })
  for (pid of [null, 1.5]) await assert.rejects(run(base, "stop"), error => error.code === 1 && /reported an invalid pid/.test(error.stderr))
})

test("a missing daemon is reported plainly and stop is idempotent", async t => {
  const base = await makeBase()
  t.after(() => rm(base, { recursive: true, force: true }))
  await assert.rejects(run(base, "status"), error => error.code === 1 && /not running; start it with: opendaemon start/.test(error.stderr))
  assert.equal((await run(base, "stop")).stdout.trim(), "opendaemon is not running")
})

test("stop terminates exactly the reported daemon and waits for its socket; restart starts a new one", async t => {
  const base = await makeBase()
  const socket = path.join(base, ".opendaemon/control.sock")
  const serve = spawn(process.execPath, [cli, "--home", base, "serve"], { stdio: "ignore" })
  const exited = new Promise(resolve => serve.once("exit", (code, signal) => resolve({ code, signal })))
  // Every daemon in this test is a separate process, so the cleanup stop never signals the test runner.
  t.after(async () => { serve.kill(); await run(base, "stop").catch(() => {}); await rm(base, { recursive: true, force: true }) })
  await waitUntil(() => daemonRequest(socket, "GET", "/status").then(() => true, () => false))
  assert.equal((await run(base, "stop")).stdout.trim(), `opendaemon stopped (pid ${serve.pid})`)
  assert.deepEqual(await exited, { code: 0, signal: null })
  await assert.rejects(daemonRequest(socket, "GET", "/status"), error => ["ENOENT", "ECONNREFUSED"].includes(error.code))
  const pid = Number(/^opendaemon pid (\d+),/m.exec((await run(base, "restart")).stdout)?.[1])
  assert.notEqual(pid, serve.pid)
  assert.equal(await cwdOf(pid), await realpath(base), "the detached daemon must not pin the caller's directory")
  assert.equal((await daemonRequest(socket, "GET", "/status")).pid, pid)
  assert.equal((await run(base, "stop")).stdout.trim(), `opendaemon stopped (pid ${pid})`)
})

test("watch waits for the daemon once per outage and follows a restarted daemon from its first event", async t => {
  const base = await makeBase()
  const watch = spawn(process.execPath, [cli, "--home", base, "watch"], { env: env(base) })
  let stdout = "", stderr = "", daemon
  watch.stdout.on("data", data => { stdout += data })
  watch.stderr.on("data", data => { stderr += data })
  t.after(async () => { watch.kill(); await daemon?.close(); await rm(base, { recursive: true, force: true }) })
  await waitUntil(() => stderr.includes("waiting for opendaemon…"))
  await new Promise(resolve => setTimeout(resolve, 1100)) // at least one more 1s retry
  assert.equal(stderr.match(/waiting for opendaemon…/g).length, 1)
  daemon = await startDaemon(base, stub)
  await waitUntil(() => /^\d\d:\d\d:\d\d  published  Generation published/m.test(stdout))
  await daemon.close()
  daemon = await startDaemon(base, stub)
  // The new daemon numbers events from 1 again; a stale cursor would hide them.
  await waitUntil(() => stdout.match(/^\d\d:\d\d:\d\d  queued  Reload requested$/gm)?.length === 2)
})
