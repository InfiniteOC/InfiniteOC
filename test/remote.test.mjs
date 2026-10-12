import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { createFront, isPrivate, lanAddress, startRemote } from "../src/remote.mjs"

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function fixture(t, options = {}) {
  const calls = []
  const pending = [{ id: "per_1", sessionID: "ses_1", action: "shell", resources: ["rm -rf build"], agent: "build" }]
  const backend = http.createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      calls.push(`${request.method} ${request.url} ${body}`)
      if (request.headers.authorization !== `Basic ${Buffer.from("opencode:backend-pw").toString("base64")}`) { response.writeHead(401); return response.end() }
      response.setHeader("content-type", "application/json")
      if (request.url === "/api/session") return response.end(JSON.stringify({ data: [{ id: "ses_1", title: "Fix build", outcome: "succeeded", time: { updated: 5 }, location: { directory: "/work" } }] }))
      if (request.url === "/api/permission/request") return response.end(JSON.stringify({ data: pending }))
      if (request.url === "/api/session/ses_1/permission/per_1/reply") { response.writeHead(204); return response.end() }
      response.writeHead(404); response.end("{}")
    })
  })
  const backendUrl = await listen(backend)
  const front = await createFront({ backend: { url: backendUrl, password: "backend-pw" }, token: "phone-token", ...options })
  const url = await listen(front)
  t.after(() => { front.closeAllConnections(); front.close(); backend.closeAllConnections(); backend.close() })
  const get = (path, token = "phone-token", init = {}) => fetch(`${url}${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } })
  return { calls, get }
}

test("address checks: only the local network qualifies", () => {
  for (const ok of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.20", "169.254.1.1", "::1", "fd12::1", "fe80::1", "::ffff:192.168.0.5"]) assert.equal(isPrivate(ok), true, ok)
  for (const bad of ["8.8.8.8", "172.32.0.1", "192.169.0.1", "2001:db8::1", "", "0.0.0.0", "not an ip"]) assert.equal(isPrivate(bad), false, bad)
  assert.equal(lanAddress({ en0: [{ family: "IPv4", internal: false, address: "203.0.113.9" }, { family: "IPv4", internal: false, address: "192.168.1.7" }] }), "192.168.1.7")
  assert.equal(lanAddress({ lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }] }), "127.0.0.1")
})

test("the page is served without a token, the data needs one", async (t) => {
  const { get, calls } = await fixture(t)
  const page = await get("/", null)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /InfiniteOC/)
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/)
  assert.equal((await get("/app.js", null)).status, 200)
  assert.equal((await get("/api/state", null)).status, 401)
  assert.equal((await get("/api/state", "wrong")).status, 401)
  assert.deepEqual(calls, [], "nothing reached the backend")
})

test("state combines sessions and pending prompts, and replies map approve/deny to once/reject", async (t) => {
  const { get, calls } = await fixture(t)
  const state = await (await get("/api/state")).json()
  assert.deepEqual(state.permissions, [{ id: "per_1", sessionID: "ses_1", sessionTitle: "Fix build", action: "shell", resources: ["rm -rf build"], agent: "build" }])
  assert.equal(state.sessions[0].title, "Fix build")
  const reply = (body) => get("/api/reply", "phone-token", { method: "POST", body: JSON.stringify(body) })
  assert.equal((await reply({ sessionID: "ses_1", requestID: "per_1", decision: "approve" })).status, 204)
  assert.equal((await reply({ sessionID: "ses_1", requestID: "per_1", decision: "deny" })).status, 204)
  assert.deepEqual(calls.filter((call) => call.includes("reply")).map((call) => call.split(" ").slice(2).join(" ")), ['{"decision":"once"}', '{"decision":"reject"}'])
  // No permanent grants, no path tricks, no other operations.
  assert.equal((await reply({ sessionID: "ses_1", requestID: "per_1", decision: "always" })).status, 400)
  assert.equal((await reply({ sessionID: "../x", requestID: "per_1", decision: "approve" })).status, 400)
  assert.equal((await get("/api/session")).status, 404)
  assert.equal((await get("/api/permission/saved")).status, 404)
  assert.equal((await reply({ sessionID: "ses_1", requestID: "per_9", decision: "approve" })).status, 404, "an answered prompt is reported as gone")
})

test("clients outside the local network are refused, and wrong tokens are rate limited", async (t) => {
  const outside = await fixture(t, { allowed: () => false })
  assert.equal((await outside.get("/")).status, 403)
  assert.equal((await outside.get("/api/state")).status, 403)
  const { get } = await fixture(t)
  for (let i = 0; i < 8; i++) assert.equal((await get("/api/state", `guess${i}`)).status, 401)
  assert.equal((await get("/api/state", "phone-token")).status, 429, "even the right token waits after repeated failures")
})

test("it will not bind outside the local network", async () => {
  await assert.rejects(startRemote({ home: "/nonexistent", binary: "x", env: {}, host: "0.0.0.0" }), /local network only/)
  await assert.rejects(startRemote({ home: "/nonexistent", binary: "x", env: {}, host: "8.8.8.8" }), /local network only/)
})
