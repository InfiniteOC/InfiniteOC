import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { changes, createGate, listFiles, receive, safeRelative, sandboxConfig, sandboxPermissions, startHost } from "../src/host.mjs"

const repo = path.resolve(import.meta.dirname, "..")

async function dir(t) {
  const value = await mkdtemp(path.join(tmpdir(), "ioc-host-"))
  t.after(() => rm(value, { recursive: true, force: true }))
  return value
}

test("paths from a browser can never leave the project", () => {
  for (const ok of ["a.txt", "src/app.js", ".git/HEAD", "deep/er/file"]) assert.equal(safeRelative(ok), ok)
  for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a//b", "./a", "a\\b", "a\0b", "x".repeat(1001), 3, null]) assert.equal(safeRelative(bad), undefined, String(bad))
})

test("receive writes and replaces; changes pages by size, skips caches, and lists every path", async (t) => {
  const root = await dir(t)
  const project = path.join(root, "p")
  await receive(project, { files: [{ path: "a.txt", data: Buffer.from("one").toString("base64") }, { path: "src/b.txt", data: Buffer.from("two").toString("base64") }] })
  await mkdir(path.join(project, "node_modules/x"), { recursive: true })
  await writeFile(path.join(project, "node_modules/x/i.js"), "dep")
  assert.deepEqual((await listFiles(project)).map((item) => item.path), ["a.txt", "src/b.txt"])
  const first = await changes(project)
  assert.deepEqual(first.files.map((file) => [file.path, Buffer.from(file.data, "base64").toString()]), [["a.txt", "one"], ["src/b.txt", "two"]])
  assert.deepEqual(first.paths, ["a.txt", "src/b.txt"])
  assert.equal(first.more, false)
  // Nothing new since the cursor (older files are not resent); a touched file is.
  const old = new Date(Date.now() - 60_000)
  await utimes(path.join(project, "a.txt"), old, old)
  await utimes(path.join(project, "src/b.txt"), old, old)
  assert.deepEqual((await changes(project, { since: Date.now() - 5000 })).files, [])
  await writeFile(path.join(project, "a.txt"), "changed")
  assert.deepEqual((await changes(project, { since: Date.now() - 5000 })).files.map((file) => file.path), ["a.txt"])
  await assert.rejects(receive(project, { files: [{ path: "../escape", data: "" }] }), /Invalid file entry/)
  assert.equal(existsSync(path.join(root, "escape")), false)
  await receive(project, { replace: true, files: [{ path: "only.txt", data: "" }] })
  assert.deepEqual((await listFiles(project)).map((item) => item.path), ["only.txt"])
})

test("the gate: right password gets a session, wrong ones back off, sessions expire", () => {
  let clock = 1_000_000
  const gate = createGate("correct horse battery", { now: () => clock })
  for (let i = 0; i < 4; i++) assert.deepEqual(gate.login("1.2.3.4", "nope"), { ok: false, wait: 0 })
  const locked = gate.login("1.2.3.4", "nope")
  assert.equal(locked.ok, false)
  assert.equal(locked.wait, 30)
  // Even the right password waits out the backoff; another address is not affected.
  assert.equal(gate.login("1.2.3.4", "correct horse battery").ok, false)
  assert.equal(gate.login("5.6.7.8", "correct horse battery").ok, true)
  clock += 31_000
  const ok = gate.login("1.2.3.4", "correct horse battery")
  assert.equal(ok.ok, true)
  assert.equal(gate.check(`a=b; ioc_host=${ok.token}`), true)
  assert.equal(gate.check("ioc_host=forged"), false)
  clock += 8 * 24 * 3600_000
  assert.equal(gate.check(`ioc_host=${ok.token}`), false)
})

// A stand-in for `opencode serve`: checks the Basic password, answers /api/session, echoes other paths, and
// upgrades /ws to a tiny echo socket.
const FAKE = `#!/usr/bin/env node
const http = require("node:http")
const port = Number(process.argv[process.argv.indexOf("--port") + 1])
const auth = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64")
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== auth) { res.writeHead(401); return res.end("no") }
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    if (req.url === "/api/session" && req.method === "POST") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: { id: "ses_test", got: JSON.parse(body) } })) }
    if (req.url === "/api/session") { res.writeHead(200, { "content-type": "application/json" }); return res.end("[]") }
    res.writeHead(200, { "content-type": "application/json", "x-frame-options": "DENY", "set-cookie": "x=1" })
    res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie ?? null, xdg: process.env.XDG_DATA_HOME, projects: process.env.INFINITEOC_PROJECTS_DIR }))
  })
})
server.on("upgrade", (req, socket) => {
  if (req.headers.authorization !== auth) return socket.end("HTTP/1.1 401 Unauthorized\\r\\n\\r\\n")
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: test\\r\\nConnection: Upgrade\\r\\n\\r\\n")
  socket.on("data", (d) => socket.write("echo:" + d))
})
server.listen(port, "127.0.0.1")
`

test("the host: gated pages and API, backend proxied with its own password, temporary root deleted on close", async (t) => {
  const tools = await dir(t)
  const binary = path.join(tools, "fake-opencode")
  await writeFile(binary, FAKE)
  await chmod(binary, 0o755)
  const config = path.join(tools, "opencode.json")
  await writeFile(config, '{"model":"x/y"}')
  await assert.rejects(startHost({ home: repo, binary, password: "short" }), /at least 12/)
  const host = await startHost({ home: repo, binary, password: "correct horse battery", config })
  let closed = false
  t.after(() => (closed ? undefined : host.close()))
  assert.deepEqual(JSON.parse(await readFile(path.join(host.root, "config/opencode/opencode.json"), "utf8")).model, "x/y")
  const written = JSON.parse(await readFile(path.join(host.root, "config/opencode/opencode.json"), "utf8"))
  assert.ok(Array.isArray(written.permissions) && written.permissions.at(-1).effect === "deny", "backend config carries the sandbox lockdown")
  const get = (url, init) => fetch(`${host.url}${url}`, { redirect: "manual", ...init })
  assert.match(await (await get("/")).text(), /InfiniteOC · Sign in/)
  assert.equal((await get("/api/anything")).status, 401)
  assert.equal((await get("/_ioc/api/projects")).status, 401)
  assert.equal((await get("/_ioc/login", { method: "POST", body: new URLSearchParams({ password: "wrong" }) })).status, 401)
  const login = await get("/_ioc/login", { method: "POST", body: new URLSearchParams({ password: "correct horse battery" }) })
  assert.equal(login.status, 303)
  const cookie = login.headers.get("set-cookie").split(";")[0]
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/)
  const authed = (url, init = {}) => get(url, { ...init, headers: { cookie, ...init.headers } })
  assert.match(await (await authed("/_ioc/")).text(), /Your projects/)
  // Proxied: the visitor's cookie is not forwarded, the backend's credentials are added, framing is allowed.
  const proxied = await authed("/some/path?x=1")
  assert.equal(proxied.headers.get("x-frame-options"), null)
  const echoed = await proxied.json()
  assert.equal(echoed.path, "/some/path?x=1")
  assert.equal(echoed.cookie, null)
  assert.ok(echoed.xdg.startsWith(host.root) && echoed.projects.startsWith(host.root))
  // Writes need the custom header (a cross-site form cannot send it).
  const body = JSON.stringify({ git: false, files: [{ path: "a.txt", data: Buffer.from("hi").toString("base64") }] })
  assert.equal((await authed("/_ioc/api/projects/demo/files", { method: "PUT", body })).status, 403)
  const put = await authed("/_ioc/api/projects/demo/files", { method: "PUT", body, headers: { "x-ioc": "1", "content-type": "application/json" } })
  assert.deepEqual(await put.json(), { written: 1 })
  assert.equal((await authed("/_ioc/api/projects/..%2Fetc/files", { method: "PUT", body, headers: { "x-ioc": "1" } })).status, 400)
  assert.deepEqual((await (await authed("/_ioc/api/projects")).json()).projects.map((item) => item.name), ["demo"])
  const pulled = await (await authed("/_ioc/api/projects/demo/changes?since=0")).json()
  assert.deepEqual(pulled.paths, ["a.txt"])
  const session = await (await authed("/_ioc/api/projects/demo/session", { method: "POST", headers: { "x-ioc": "1" } })).json()
  assert.equal(session.sessionID, "ses_test")
  assert.equal(session.directory, path.join(host.root, "projects", "demo"))
  // WebSocket upgrades are tunneled only with a session.
  const upgrade = (withCookie) =>
    new Promise((resolve) => {
      const socket = net.connect(Number(new URL(host.url).port), "127.0.0.1", () =>
        socket.write(`GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: test\r\n${withCookie ? `Cookie: ${cookie}\r\n` : ""}\r\n`))
      let data = ""
      socket.on("data", (chunk) => {
        data += chunk
        if (data.includes("101") && !data.includes("echo:")) socket.write("ping")
        if (data.includes("echo:ping") || data.includes("401")) { socket.destroy(); resolve(data) }
      })
      socket.on("close", () => resolve(data))
    })
  assert.match(await upgrade(false), /401/)
  assert.match(await upgrade(true), /101 Switching Protocols[\s\S]*echo:ping/)
  assert.equal((await authed("/_ioc/api/projects/demo", { method: "DELETE", headers: { "x-ioc": "1" } })).status, 200)
  assert.deepEqual((await (await authed("/_ioc/api/projects")).json()).projects, [])
  const root = host.root
  await host.close()
  closed = true
  assert.equal(existsSync(root), false)
})

test("host backend config is sandboxed to the temporary root", () => {
  const root = `/tmp/infiniteoc-host-test`
  const out = sandboxConfig({ model: "x/y", mcp: { servers: {} }, permissions: [{ action: "read", resource: "*.env", effect: "ask" }] }, { root, home: "/home/u/infiniteoc" })
  assert.equal(out.model, "x/y")
  assert.deepEqual(out.mcp, { servers: {} })
  // The user's own rules survive and come first; the lockdown wins by coming last.
  assert.deepEqual(out.permissions[0], { action: "read", resource: "*.env", effect: "ask" })
  const external = out.permissions.filter((rule) => rule.action === "external_directory")
  assert.deepEqual(external[0], { action: "external_directory", resource: "*", effect: "deny" })
  assert.ok(external.some((rule) => rule.resource === `${root}/*` && rule.effect === "allow"), "temporary root allowed")
  assert.ok(external.some((rule) => rule.resource === "/home/u/infiniteoc/skills/*" && rule.effect === "allow"), "bundled skills allowed")
  assert.ok(!external.some((rule) => rule.resource === "/tmp/*"), "no shared-temp carve-out")
  for (const action of ["read", "edit", "write"]) {
    assert.ok(out.permissions.some((rule) => rule.action === action && rule.resource === "/*" && rule.effect === "deny"), `${action} absolute backstop`)
    assert.ok(out.permissions.some((rule) => rule.action === action && rule.resource === "C:/*" && rule.effect === "deny"), `${action} windows backstop`)
  }
  // Exact copy of upstream Wildcard.match (packages/core/src/util/wildcard.ts): last match wins.
  const match = (input, pattern) => {
    const escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
    return new RegExp(`^${escaped}$`, "s").test(input.replaceAll("\\", "/"))
  }
  const decide = (action, resource) => sandboxPermissions({ root, skills: "/home/u/infiniteoc/skills" }).findLast((rule) => rule.action === action && match(resource, rule.resource))?.effect
  assert.equal(decide("external_directory", "/etc/passwd"), "deny")
  assert.equal(decide("external_directory", `${root}/projects/demo/a.txt`), "allow")
  assert.equal(decide("external_directory", "/home/u/infiniteoc/skills/x/SKILL.md"), "allow")
  assert.equal(decide("read", "/etc/passwd"), "deny")
  assert.equal(decide("read", "src/app.ts"), undefined, "internal relative paths are untouched")
  assert.equal(decide("edit", "C:/Windows/x"), "deny")
  assert.equal(decide("edit", "D:/work/y"), "deny")
  assert.deepEqual(sandboxConfig(null, { root, home: "/home/u" }).permissions.at(-1), { action: "write", resource: "Z:/*", effect: "deny" })
})

test("host bundle: a clean copy that only runs the web host", async (t) => {
  const { bundleHost } = await import("../src/host-bundle.mjs")
  const { spawnSync } = await import("node:child_process")
  const tools = await dir(t)
  const binary = path.join(tools, "opencode")
  await writeFile(binary, "#!/bin/sh\n")
  const target = path.join(tools, "bundle")
  await assert.rejects(bundleHost({ home: repo, binary, target: path.join(repo, "inside") }), /outside this checkout/)
  const result = await bundleHost({ home: repo, binary, target })
  assert.ok(result.files > 100)
  for (const file of ["host.mjs", "HOST_ONLY", "Dockerfile", "HOSTING.md", "runtime/opencode", "src/host.mjs", "src/host-page.js", "bin/infiniteoc.mjs"]) assert.ok(existsSync(path.join(target, file)), file)
  // Ignored and private things never come along.
  for (const file of [".upstream", ".runtime", ".tools", ".opendaemon", "opencode.json", "infiniteoc.json.bak", "packs", ".git"]) assert.equal(existsSync(path.join(target, file)), false, file)
  assert.equal(JSON.parse(await readFile(path.join(target, "package.json"), "utf8")).scripts.start, "node host.mjs")
  const refused = spawnSync(process.execPath, [path.join(target, "bin/infiniteoc.mjs")], { encoding: "utf8", env: { ...process.env, HOME: tools } })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /only runs the web host: node .*host\.mjs/)
  const weak = spawnSync(process.execPath, [path.join(target, "host.mjs")], { encoding: "utf8", env: { ...process.env, INFINITEOC_HOST_PASSWORD: "short" } })
  assert.equal(weak.status, 1)
  assert.match(weak.stderr, /12 or more characters/)
  await assert.rejects(bundleHost({ home: repo, binary, target }), /not empty/)
})
