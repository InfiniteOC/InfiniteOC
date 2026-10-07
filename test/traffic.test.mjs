import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import http from "node:http"
import { once } from "node:events"
import { applyTraffic, connectSocks, createSocksBridge } from "../src/traffic.mjs"

async function socks(t, reject = false) {
  const destinations = []
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    let stage = "greeting"
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === "greeting" && buffer.length >= 3) {
        const length = 2 + buffer[1]
        if (buffer.length < length) return
        buffer = buffer.subarray(length)
        socket.write(Buffer.from([5, 0]))
        stage = "request"
      }
      if (stage === "request" && buffer.length >= 5) {
        const size = buffer[4]
        if (buffer.length < size + 7) return
        const hostname = buffer.subarray(5, size + 5).toString()
        const port = buffer.readUInt16BE(size + 5)
        destinations.push({ hostname, port })
        socket.off("data", onData)
        if (reject) { socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); return }
        const target = net.connect({ host: "127.0.0.1", port })
        sockets.add(target)
        target.on("error", () => socket.destroy())
        target.on("close", () => { sockets.delete(target); socket.destroy() })
        socket.on("close", () => target.destroy())
        target.on("connect", () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          target.pipe(socket)
          socket.pipe(target)
        })
      }
    }
    socket.on("data", onData)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
  return { url: `socks5h://127.0.0.1:${server.address().port}`, destinations }
}

test("inherit leaves env untouched; direct strips all standard proxies", async () => {
  const inherited = { HTTPS_PROXY: "http://old", all_proxy: "socks5://old", WSS_PROXY: "http://old-ws", ws_proxy: "http://old-ws", NO_PROXY: "example", OTHER: "keep" }
  assert.deepEqual((await applyTraffic({ mode: "inherit" }, inherited)).env, inherited)
  assert.deepEqual((await applyTraffic({ mode: "direct" }, inherited)).env, { OTHER: "keep" })
  assert.equal(inherited.HTTPS_PROXY, "http://old")
})

test("HTTP proxies replace uppercase/lowercase env and retain localhost bypass", async () => {
  const result = await applyTraffic({ mode: "proxy", proxyURL: "http://127.0.0.1:8080", noProxy: "private.example" }, {})
  assert.equal(result.env.HTTPS_PROXY, "http://127.0.0.1:8080/")
  assert.equal(result.env.https_proxy, result.env.HTTPS_PROXY)
  assert.equal(result.env.WSS_PROXY, result.env.HTTPS_PROXY)
  assert.equal(result.env.NO_PROXY, "localhost,127.0.0.1,::1,private.example")
  await result.close()
})

test("unsupported proxy configuration fails before launching", async () => {
  await assert.rejects(applyTraffic({ mode: "bad" }), /Invalid traffic mode/)
  await assert.rejects(applyTraffic({ mode: "proxy", proxyURL: "ftp://localhost" }), /Use HTTP/)
  await assert.rejects(applyTraffic({ mode: "proxy", proxyURL: "http://localhost/path" }), /cannot contain/)
})

test("SOCKS rejects upstream failure without direct fallback", async t => {
  const mock = await socks(t, true)
  await assert.rejects(connectSocks(new URL(mock.url), "destination.invalid", 443), /rejected/)
  assert.deepEqual(mock.destinations, [{ hostname: "destination.invalid", port: 443 }])
})

test("CONNECT bridge sends DNS hostname to SOCKS and transports bytes", async t => {
  const echo = net.createServer(socket => socket.pipe(socket))
  echo.listen(0, "127.0.0.1")
  await once(echo, "listening")
  t.after(() => new Promise(resolve => echo.close(resolve)))
  const mock = await socks(t)
  const bridge = await createSocksBridge(mock.url)
  t.after(bridge.close)
  const url = new URL(bridge.url)
  const socket = net.connect(Number(url.port), url.hostname)
  await once(socket, "connect")
  const result = once(socket, "data")
  socket.write(`CONNECT destination.invalid:${echo.address().port} HTTP/1.1\r\nHost: destination.invalid\r\n\r\n`)
  assert.match((await result)[0].toString(), /200 Connection Established/)
  const echoResult = once(socket, "data")
  socket.write("hello-through-socks")
  assert.equal((await echoResult)[0].toString(), "hello-through-socks")
  socket.destroy()
  assert.equal(mock.destinations[0].hostname, "destination.invalid")
})

test("HTTP bridge uses SOCKS for unresolvable hostnames and removes proxy authorization", async t => {
  let leaked
  const target = http.createServer((request, response) => {
    leaked = request.headers["proxy-authorization"]
    response.end(`ok:${request.url}`)
  })
  target.listen(0, "127.0.0.1")
  await once(target, "listening")
  t.after(() => new Promise(resolve => target.close(resolve)))
  const mock = await socks(t)
  const bridge = await createSocksBridge(mock.url)
  t.after(bridge.close)
  const url = new URL(bridge.url)
  const response = await new Promise((resolve, reject) => {
    const request = http.get({ host: url.hostname, port: url.port, path: `http://destination.invalid:${target.address().port}/hello`, headers: { "proxy-authorization": "secret" } }, resolve)
    request.on("error", reject)
  })
  let body = ""
  for await (const chunk of response) body += chunk
  assert.equal(response.statusCode, 200)
  assert.equal(body, "ok:/hello")
  assert.equal(leaked, undefined)
  assert.equal(mock.destinations[0].hostname, "destination.invalid")
})

test("Tor mode creates HTTP bridge and closes it", async () => {
  const result = await applyTraffic({ mode: "tor", socksHost: "127.0.0.1", socksPort: 9050 }, {})
  assert.match(result.env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:/)
  await result.close()
})