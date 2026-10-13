import test from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, copyFile, chmod, realpath, stat } from "node:fs/promises"
import { once } from "node:events"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import http from "node:http"
import { parseServeArgs, isLoopback, serverPassword, serverUrls, choosePort, browserCommand, enableWebUi, exposureWarning, waitUntilUp, MIN_PASSWORD } from "../src/serve.mjs"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("serve/web flags: loopback by default, values in both forms, everything else refused", () => {
  assert.deepEqual(parseServeArgs("serve", []), { hostname: "127.0.0.1", port: undefined, cors: [], open: false })
  assert.deepEqual(parseServeArgs("web", []), { hostname: "127.0.0.1", port: undefined, cors: [], open: true })
  assert.deepEqual(parseServeArgs("web", ["--port=5000", "--hostname", "0.0.0.0", "--no-open", "--cors", "https://a.example", "--cors=http://b.example:8080"]),
    { hostname: "0.0.0.0", port: 5000, cors: ["https://a.example", "http://b.example:8080"], open: false })
  assert.equal(parseServeArgs("serve", ["--host", "[::1]"]).hostname, "::1")
  for (const [args, message] of [
    [["--port", "abc"], /Invalid port abc/], [["--port", "0"], /Invalid port 0/], [["--port", "70000"], /Invalid port/],
    [["--port"], /--port needs a value/], [["--port", "--hostname", "x"], /--port needs a value/], [["--hostname="], /--hostname needs a value/],
    [["--hostname", "a b"], /Invalid hostname/], [["--hostname", "evil/x"], /Invalid hostname/],
    [["--cors", "https://a.example/path"], /Invalid --cors origin/], [["--cors", "*"], /Invalid --cors origin/],
    [["--service"], /--service is refused: it registers OpenCode's background service/], [["--stdio"], /--stdio is not supported/],
    [["--no-open"], /Unknown serve option --no-open/], [["--password", "x"], /Unknown serve option --password/], [["extra"], /Unknown serve option extra\. Usage: infiniteoc serve/],
  ]) assert.throws(() => parseServeArgs("serve", args), message, args.join(" "))
})

test("only loopback counts as private to this machine", () => {
  for (const host of ["127.0.0.1", "127.8.0.1", "::1", "[::1]", "localhost", "LOCALHOST", "::ffff:127.0.0.1"]) assert.equal(isLoopback(host), true, host)
  for (const host of ["0.0.0.0", "::", "192.168.1.5", "10.0.0.1", "example.com", "fe80::1", "128.0.0.1", ""]) assert.equal(isLoopback(host), false, host)
})

test("password: a generated one by default; off loopback a short typed one is refused", () => {
  const generated = serverPassword({}, false)
  assert.equal(generated.generated, true)
  assert.equal(generated.password.length, 32)
  assert.notEqual(serverPassword({}, true).password, generated.password)
  assert.deepEqual(serverPassword({ OPENCODE_PASSWORD: "short" }, false), { password: "short", generated: false })
  assert.deepEqual(serverPassword({ OPENCODE_SERVER_PASSWORD: "legacy" }, false), { password: "legacy", generated: false })
  assert.throws(() => serverPassword({ OPENCODE_PASSWORD: "short" }, true), new RegExp(`5 characters; a server other machines can reach needs at least ${MIN_PASSWORD}`))
  assert.equal(serverPassword({ OPENCODE_PASSWORD: "x".repeat(MIN_PASSWORD) }, true).password, "x".repeat(MIN_PASSWORD))
  // An empty variable is unset, never an empty password.
  assert.equal(serverPassword({ OPENCODE_PASSWORD: "" }, true).generated, true)
})

test("URLs for this machine and for other devices", () => {
  const lan = () => "192.168.1.20"
  assert.deepEqual(serverUrls("127.0.0.1", 4096, lan), { local: "http://127.0.0.1:4096", network: undefined })
  assert.deepEqual(serverUrls("::1", 4096, lan), { local: "http://[::1]:4096", network: undefined })
  assert.deepEqual(serverUrls("0.0.0.0", 4096, lan), { local: "http://127.0.0.1:4096", network: "http://192.168.1.20:4096" })
  assert.deepEqual(serverUrls("::", 4096, lan), { local: "http://[::1]:4096", network: "http://192.168.1.20:4096" })
  assert.deepEqual(serverUrls("0.0.0.0", 4096, () => "127.0.0.1"), { local: "http://127.0.0.1:4096", network: undefined })
  assert.deepEqual(serverUrls("192.168.1.5", 80, lan), { local: "http://192.168.1.5:80", network: "http://192.168.1.5:80" })
  assert.match(exposureWarning("0.0.0.0", { network: "http://192.168.1.20:4096" }), /^WARNING: listening on 0\.0\.0\.0, which other machines can reach \(http:\/\/192\.168\.1\.20:4096\)\.\n.*runs shell commands as you.*\n.*plain HTTP/s)
})

test("a busy port is skipped, like upstream does", async (t) => {
  const busy = net.createServer().listen(0, "127.0.0.1")
  await once(busy, "listening")
  t.after(() => busy.close())
  const { port } = busy.address()
  const chosen = await choosePort("127.0.0.1", port)
  assert.ok(chosen > port && chosen < port + 100, String(chosen))
})

test("a browser is opened only where there is a desktop", () => {
  assert.equal(browserCommand("darwin", {}), "open")
  assert.equal(browserCommand("linux", { DISPLAY: ":0" }), "xdg-open")
  assert.equal(browserCommand("linux", { WAYLAND_DISPLAY: "wayland-0" }), "xdg-open")
  assert.equal(browserCommand("linux", {}), undefined) // SSH: print the link only
})

test("readiness: upstream's 503 while starting is waited out, a failed start (500) and a foreign password (401) are errors", async (t) => {
  const answers = [503, 503, 200]
  let status = () => answers.shift() ?? 200
  const server = http.createServer((req, res) => { res.writeHead(req.headers.authorization === `Basic ${Buffer.from("opencode:pw").toString("base64")}` ? status() : 401); res.end("{}") })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}`
  assert.equal(await waitUntilUp(url, "pw"), true)
  assert.deepEqual(answers, [])
  status = () => 500
  await assert.rejects(waitUntilUp(url, "pw"), /failed to start/)
  await assert.rejects(waitUntilUp(url, "other"), /does not accept the password it was started with/)
  status = () => 503
  const stopped = new AbortController()
  setTimeout(() => stopped.abort(), 300)
  assert.equal(await waitUntilUp(url, "pw", stopped.signal), false) // the server exited: launch reports its code
})

test("enableWebUi adds the option, keeps other options and a backup, and is a no-op the second time", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-config-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const original = JSON.stringify({ upstream: "v2.0.21", mods: ["./mods/a/index.mjs"], options: { reducedMotion: true } })
  await writeFile(path.join(dir, "infiniteoc.json"), original)
  assert.equal(await enableWebUi(dir), true)
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "infiniteoc.json"), "utf8")), { upstream: "v2.0.21", mods: ["./mods/a/index.mjs"], options: { reducedMotion: true, webUi: true } })
  assert.equal(await readFile(path.join(dir, "infiniteoc.json.bak"), "utf8"), original)
  assert.equal(await enableWebUi(dir), false)
})

// --- Through the real launcher, with a fake OpenCode binary that is a tiny HTTP server ---

async function script(file, body) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `#!/bin/sh\n${body}\n`)
  await chmod(file, 0o755)
}
// Records argv/env next to itself; enforces upstream's Basic auth unless FAKE_NOAUTH; serves a page only with FAKE_UI.
const fakeServer = `
const fs = require("fs"), http = require("http")
const [record, ...args] = process.argv.slice(2)
fs.writeFileSync(record, JSON.stringify({ args, env: process.env }))
let codes = 0
http.createServer((req, res) => {
  const authed = req.headers.authorization === "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64")
  if (req.url.startsWith("/api/")) {
    if (!authed && !process.env.FAKE_NOAUTH) { res.writeHead(401); return res.end() }
    res.setHeader("content-type", "application/json")
    if (req.url === "/api/pair" && req.method === "POST") return res.end(JSON.stringify({ code: "code-" + ++codes, expires_in: 300 }))
    return res.end("{}")
  }
  if (process.env.FAKE_UI) { res.setHeader("content-type", "text/html"); return res.end("<title>InfiniteOC</title>") }
  res.writeHead(500); res.end()
}).listen(Number(args[args.indexOf("--port") + 1]), args[args.indexOf("--hostname") + 1])
`
// A disposable InfiniteOC home with a fresh fake build; PATH holds only fake-bin, so nothing reaches npm, git or the network.
async function home(t, options = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ioc-")))
  t.after(() => rm(base, { recursive: true, force: true }))
  for (const dir of ["bin", "src"]) await cp(path.join(repo, dir), path.join(base, dir), { recursive: true })
  await mkdir(path.join(base, "mods/infiniteoc/settings"), { recursive: true })
  await copyFile(path.join(repo, "mods/infiniteoc/settings/settings-store.mjs"), path.join(base, "mods/infiniteoc/settings/settings-store.mjs"))
  await copyFile(path.join(repo, "package.json"), path.join(base, "package.json"))
  const settings = { upstream: "v2.0.21", mods: [], options }
  await writeFile(path.join(base, "infiniteoc.json"), JSON.stringify(settings))
  await mkdir(path.join(base, "fake-bin"))
  await script(path.join(base, ".tools/node_modules/.bin/bun"), "echo 1.4.2")
  await mkdir(path.join(base, ".upstream/.git"), { recursive: true })
  await writeFile(path.join(base, ".upstream/package.json"), JSON.stringify({ version: "2.0.21" }))
  await writeFile(path.join(base, ".opendaemon"), "") // no daemon can start
  const binary = path.join(base, `.runtime/opencode/packages/cli/dist/cli-${process.platform}-${process.arch}/bin/opencode`)
  await writeFile(path.join(base, "fake-server.cjs"), fakeServer)
  await script(binary, `exec "${process.execPath}" "${path.join(base, "fake-server.cjs")}" "$0.json" "$@"`)
  const { fingerprint } = await import(pathToFileURL(path.join(base, "src/launcher.mjs")).href)
  await writeFile(path.join(base, ".runtime/build.json"), JSON.stringify({ key: await fingerprint(settings, []), builtAt: "2026-01-01T00:00:00.000Z", webUi: options.webUi === true }))
  return { base, record: `${binary}.json` }
}
const environment = (base, env) => ({ PATH: path.join(base, "fake-bin"), HOME: base, INFINITEOC_SETTINGS_FILE: path.join(base, "settings.json"), ...env })
const cli = (base, args, env = {}) => spawnSync(process.execPath, [path.join(base, "bin/infiniteoc.mjs"), ...args], { cwd: base, encoding: "utf8", timeout: 20000, env: environment(base, env) })
// Starts a long-running serve/web, waits for `pattern` on stdout (or the exit), then Ctrl+C.
async function running(base, args, pattern, env = {}) {
  const child = spawn(process.execPath, [path.join(base, "bin/infiniteoc.mjs"), ...args], { cwd: base, env: environment(base, env) })
  let stdout = "", stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  const exit = once(child, "exit")
  const deadline = Date.now() + 20000
  while (child.exitCode === null && !pattern.test(stdout) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  const early = child.exitCode !== null
  if (!early) child.kill("SIGINT")
  const [code] = await exit
  return { stdout, stderr, code, early }
}

test("infiniteoc serve runs this build's serve on loopback with a generated password, checks auth, prints how to connect", async (t) => {
  const { base, record } = await home(t)
  const result = await running(base, ["serve"], /Ctrl\+C stops it/, { OPENCODE_SERVER_PASSWORD: "" })
  assert.equal(result.early, false, result.stderr)
  assert.equal(result.code, 130, result.stderr)
  const { args, env } = JSON.parse(await readFile(record, "utf8"))
  assert.deepEqual(args.slice(0, 4), ["serve", "--hostname", "127.0.0.1", "--port"])
  assert.ok(Number(args[4]) >= 4096, args[4])
  assert.equal(args.length, 5)
  assert.equal(env.OPENCODE_PASSWORD.length, 32)
  assert.equal(env.OPENCODE_SERVER_PASSWORD, undefined)
  assert.equal(env.INFINITEOC, "1") // the same environment as a TUI launch
  assert.match(result.stdout, new RegExp(`InfiniteOC server on http://127\\.0\\.0\\.1:${args[4]} \\(this machine only\\)`))
  assert.ok(result.stdout.includes(`Sign in as opencode with password ${env.OPENCODE_PASSWORD}`), result.stdout)
  assert.ok(result.stdout.includes(`OPENCODE_PASSWORD=${env.OPENCODE_PASSWORD} infiniteoc --server http://127.0.0.1:${args[4]}`))
  assert.match(result.stdout, /Web UI: not in this build \(infiniteoc web offers to add it\)/)
  assert.doesNotMatch(result.stderr, /WARNING/)
  await assert.rejects(stat(path.join(base, ".runtime/crashes")), { code: "ENOENT" }) // Ctrl+C is not a crash
})

test("a typed password is used and not printed; the legacy variable is folded into OPENCODE_PASSWORD; global flags stay in front", async (t) => {
  const { base, record } = await home(t)
  const result = await running(base, ["--print-logs", "serve", "--port", String(await freePort())], /Ctrl\+C stops it/, { OPENCODE_SERVER_PASSWORD: "legacy-password-1234" })
  assert.equal(result.early, false, result.stderr)
  const { args, env } = JSON.parse(await readFile(record, "utf8"))
  assert.deepEqual(args.slice(0, 2), ["--print-logs", "serve"])
  assert.equal(env.OPENCODE_PASSWORD, "legacy-password-1234")
  assert.equal(env.OPENCODE_SERVER_PASSWORD, undefined)
  assert.match(result.stdout, /with the password in OPENCODE_PASSWORD/)
  assert.doesNotMatch(result.stdout, /legacy-password-1234/)
})

test("off loopback: a warning, and a short typed password stops it before anything starts", async (t) => {
  const { base, record } = await home(t)
  const refused = cli(base, ["serve", "--hostname", "0.0.0.0"], { OPENCODE_PASSWORD: "hunter2" })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /OPENCODE_PASSWORD has 7 characters; a server other machines can reach needs at least 16/)
  await assert.rejects(stat(record), { code: "ENOENT" })
  // After -- too: the policy cannot be skipped by forwarding.
  const forwarded = cli(base, ["--", "serve", "--hostname=0.0.0.0"], { OPENCODE_PASSWORD: "hunter2" })
  assert.match(forwarded.stderr, /needs at least 16/)
  assert.match(cli(base, ["--", "serve", "--service"]).stderr, /--service is refused/)
  await assert.rejects(stat(record), { code: "ENOENT" })
  const result = await running(base, ["serve", "--hostname", "0.0.0.0", "--port", String(await freePort())], /Ctrl\+C stops it/)
  assert.equal(result.early, false, result.stderr)
  assert.match(result.stderr, /\[InfiniteOC\] WARNING: listening on 0\.0\.0\.0, which other machines can reach/)
  assert.match(result.stderr, /plain HTTP/)
  const { env } = JSON.parse(await readFile(record, "utf8"))
  assert.equal(env.OPENCODE_PASSWORD.length, 32)
  assert.match(result.stdout, /InfiniteOC server on http:\/\/127\.0\.0\.1:\d+\n/)
})

test("a server that answers without the password is stopped and the launch fails", async (t) => {
  const { base } = await home(t)
  const result = await running(base, ["serve"], /never/, { FAKE_NOAUTH: "1" })
  assert.equal(result.early, true)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Refusing to keep running: http:\/\/127\.0\.0\.1:\d+\/api\/info answered 200 to a request without a password\. This build does not enforce the server password; the server was stopped\./)
  assert.doesNotMatch(result.stdout, /Sign in/)
})

test("infiniteoc web: needs the web UI option, then prints a one-time sign-in link and opens it on a desktop", { skip: process.platform !== "linux" && "xdg-open path" }, async (t) => {
  const plain = await home(t)
  const asked = cli(plain.base, ["web"])
  assert.equal(asked.status, 1)
  assert.match(asked.stderr, /The web UI is not part of InfiniteOC builds .* Add "webUi": true to "options" in .*infiniteoc\.json, or run infiniteoc serve/)
  await assert.rejects(stat(plain.record), { code: "ENOENT" })

  const { base, record } = await home(t, { webUi: true })
  await script(path.join(base, "fake-bin/xdg-open"), `echo "$@" > "$0.args"`)
  const result = await running(base, ["web"], /Ctrl\+C stops it/, { FAKE_UI: "1", DISPLAY: ":0" })
  assert.equal(result.early, false, result.stderr)
  const { args } = JSON.parse(await readFile(record, "utf8"))
  const link = `http://127.0.0.1:${args[4]}/auth/connect/code-1`
  assert.match(result.stdout, /InfiniteOC web UI on http:\/\/127\.0\.0\.1:\d+ \(this machine only\)/)
  assert.ok(result.stdout.includes(`Browser sign-in link (works once, expires in 5 min):\n    ${link}`), result.stdout)
  assert.match(result.stdout, /Opened it in your browser/)
  for (let i = 0; i < 40 && !await stat(path.join(base, "fake-bin/xdg-open.args")).catch(() => undefined); i++) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(await readFile(path.join(base, "fake-bin/xdg-open.args"), "utf8"), `${link}\n`)

  const quiet = await running(base, ["web", "--no-open"], /Ctrl\+C stops it/, { FAKE_UI: "1", DISPLAY: ":0" })
  assert.doesNotMatch(quiet.stdout, /Opened/)
})

test("infiniteoc web on a build without the web UI stops the server and says how to add it", async (t) => {
  const { base } = await home(t, { webUi: true })
  const result = await running(base, ["web", "--no-open"], /never/)
  assert.equal(result.early, true)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /This build has no web UI; the server was stopped\. It needs "options": \{"webUi": true\} in infiniteoc\.json and a build made with it/)
})

test("doctor reports web readiness", async (t) => {
  const off = await home(t)
  assert.match(JSON.parse(cli(off.base, ["doctor", "--json"]).stdout).web.detail, /web UI not in builds: infiniteoc serve \(API\) works/)
  const on = await home(t, { webUi: true })
  assert.deepEqual(JSON.parse(cli(on.base, ["doctor", "--json"]).stdout).web, { ok: true, detail: "web UI built in: infiniteoc web is ready" })
  await writeFile(path.join(on.base, ".runtime/build.json"), JSON.stringify({ key: "stale", builtAt: "2026-01-01T00:00:00.000Z" }))
  const stale = JSON.parse(cli(on.base, ["doctor", "--json"]).stdout).web
  assert.deepEqual([stale.ok, stale.warn, stale.fix], [true, true, "build"])
})

async function freePort() {
  const server = net.createServer().listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}
