import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { addDevice, callDevice, deviceMessages, deviceOpen, devicePrompt, deviceSessions, formatDeviceMessages, keysDir, listDevices, normalizeUrl, registryFile, removeDevice, renderRemoteText, resolveDevice } from "./lib.mjs"

const SECRET = "device-server-password-1" // infiniteoc:allow-secret (test fixture only, never a real credential)
const BASIC = `Basic ${Buffer.from(`opencode:${SECRET}`).toString("base64")}`

async function settings(t) {
  const home = await mkdtemp(path.join(tmpdir(), "ioc-devices-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  return { file: path.join(home, "settings.json"), home }
}

const envFor = (file) => ({ ...process.env, INFINITEOC_SETTINGS_FILE: file })

test("pair, list, resolve and unpair keep secrets out of every output", async (t) => {
  const { file } = await settings(t)
  const env = envFor(file)
  assert.deepEqual(await listDevices(env), [])
  const added = await addDevice({ name: "Desk", url: "http://192.168.1.5:4096/", password: SECRET, env })
  assert.deepEqual(added, { name: "desk", url: "http://192.168.1.5:4096" })
  assert.ok(!JSON.stringify(added).includes(SECRET))
  const listed = await listDevices(env)
  assert.deepEqual(listed.map((item) => item.name), ["desk"])
  assert.ok(!JSON.stringify(listed).includes(SECRET))
  const stored = JSON.parse(await readFile(registryFile(env), "utf8"))
  assert.ok(!JSON.stringify(stored).includes(SECRET), "registry never holds the password")
  const resolved = await resolveDevice("desk", env)
  assert.equal(resolved.password, SECRET)
  assert.equal((await resolveDevice("des", env)).name, "desk")
  await assert.rejects(addDevice({ name: "Bad Name!", url: "http://x:1", password: "p", env }), /Invalid device name/)
  await assert.rejects(addDevice({ name: "x", url: "ftp://x", password: "p", env }), /http\(s\) only/)
  await assert.rejects(addDevice({ name: "x", url: "http://x:1", password: "", env }), /needs .* password/)
  await assert.rejects(resolveDevice("nope", env), /Paired: desk/)
  const removed = await removeDevice("desk", env)
  assert.deepEqual(removed, { name: "desk" })
  assert.deepEqual(await listDevices(env), [])
  await assert.rejects(resolveDevice("desk", env), /pair one/)
  await assert.rejects(removeDevice("desk", env), /not paired/)
  assert.equal(normalizeUrl("https://h:1/a//"), "https://h:1/a")
})

/** A stub paired server: checks the Basic password, answers session endpoints, counts hits. */
async function stub(t, { password = SECRET } = {}) {
  const hits = []
  let prompted = false
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const server = http.createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      hits.push({ method: request.method, url: request.url, auth: request.headers.authorization === expected, body })
      const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)) }
      if (request.headers.authorization !== expected) return send(401, { error: "no" })
      const url = new URL(request.url, "http://local")
      if (url.pathname === "/api/session" && request.method === "GET") return send(200, { data: [{ id: "ses_r1", title: "Remote work", location: { directory: "/r/proj" } }] })
      if (url.pathname === "/api/session" && request.method === "POST") {
        const parsed = JSON.parse(body || "{}")
        if (!parsed?.location?.directory) return send(400, { error: "location.directory is required" })
        return send(200, { data: { id: "ses_new", location: { directory: parsed.location.directory } } })
      }
      // Serve-API message shape: { info: { id, type, time: { created }, ... } } (no seq numbers).
      if (url.pathname === "/api/session/ses_r1/message") {
        const data = [
          { info: { id: "m1", type: "user", time: { created: 1000 }, parts: { text: "do it" } } },
          { info: { id: "m2", type: "assistant", time: { created: 2000 }, parts: { text: "old answer" } } },
        ]
        if (prompted) data.unshift({ info: { id: "m3", type: "assistant", time: { created: Date.now() }, parts: { text: "hello from device" } } })
        return send(200, { data })
      }
      if (url.pathname === "/api/session/ses_r1/prompt") {
        const parsed = JSON.parse(body || "{}")
        if (!parsed?.text) return send(400, { error: "text is required" })
        prompted = true
        return send(200, { data: { id: "msg_new", type: "user", time: { created: Date.now() } } })
      }
      return send(404, { error: "not found" })
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  return { hits, url: `http://127.0.0.1:${server.address().port}` }
}

test("client: auth, sessions, read, open and prompt against a stub device", async (t) => {
  const { file } = await settings(t)
  const env = envFor(file)
  const { hits, url } = await stub(t)
  await addDevice({ name: "lab", url, password: SECRET, env })
  const device = await resolveDevice("lab", env)
  const sessions = await deviceSessions(device, {})
  assert.deepEqual(sessions.map((item) => item.id), ["ses_r1"])
  assert.ok(hits.every((hit) => hit.auth), "every call carries the Basic password")
  assert.ok(hits[0].url.includes("order=desc"), "newest first")
  const messages = await deviceMessages(device, "ses_r1", {})
  assert.equal(messages.length, 2)
  assert.match(formatDeviceMessages(device, "ses_r1", messages), /old answer/)
  const opened = await deviceOpen(device, { directory: "/r/proj", title: "T" })
  assert.equal(opened.id, "ses_new")
  await assert.rejects(deviceOpen(device, { directory: "relative" }), /absolute directory/)
  const result = await devicePrompt(device, { sessionID: "ses_r1", text: "go", pollMs: 5 })
  assert.equal(result.sessionID, "ses_r1")
  assert.match(result.text, /hello from device/)
  assert.equal(renderRemoteText({ parts: { text: "x" } }), "x")
})

test("client failures name the device, never the password", async (t) => {
  const { file } = await settings(t)
  const env = envFor(file)
  const { url } = await stub(t)
  await addDevice({ name: "lab", url, password: "wrong-password", env })
  const device = await resolveDevice("lab", env)
  await assert.rejects(deviceSessions(device, {}), /refused the stored password/)
  try { await deviceSessions(device, {}); assert.fail("should throw") } catch (error) { assert.ok(!error.message.includes("wrong-password") && error.message.includes('"lab"')) }
  await addDevice({ name: "gone", url: "http://127.0.0.1:1", password: "p", env })
  await assert.rejects(deviceSessions(await resolveDevice("gone", env), {}), /did not answer/)
  assert.ok(keysDir(env).endsWith("keys"))
})
