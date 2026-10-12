import net from "node:net"
import http from "node:http"
import { once } from "node:events"

const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "WS_PROXY", "WSS_PROXY", "http_proxy", "https_proxy", "all_proxy", "ws_proxy", "wss_proxy", "NO_PROXY", "no_proxy"]
const localBypass = "localhost,127.0.0.1,::1"

function reader(socket) {
  let buffer = Buffer.alloc(0)
  let pending
  let failure
  const settle = () => {
    if (!pending) return
    if (failure) { const { reject } = pending; pending = undefined; reject(failure); return }
    if (buffer.length < pending.size) return
    const { size, resolve } = pending
    pending = undefined
    const result = buffer.subarray(0, size)
    buffer = buffer.subarray(size)
    resolve(result)
  }
  const data = chunk => { buffer = Buffer.concat([buffer, chunk]); settle() }
  const error = cause => { failure = cause; settle() }
  const end = () => error(new Error("SOCKS proxy closed during handshake"))
  socket.on("data", data).on("error", error).on("end", end)
  return {
    read(size) {
      if (pending) throw new Error("Concurrent SOCKS reads")
      return new Promise((resolve, reject) => { pending = { size, resolve, reject }; settle() })
    },
    release() {
      socket.pause()
      socket.off("data", data).off("error", error).off("end", end)
      if (buffer.length) socket.unshift(buffer)
    },
  }
}

export async function connectSocks(proxy, hostname, port, timeout = 15000) {
  const socket = net.connect({ host: proxy.hostname.replace(/^\[|\]$/g, ""), port: Number(proxy.port || 1080) })
  const timer = setTimeout(() => socket.destroy(new Error("SOCKS connection timed out")), timeout)
  timer.unref()
  const input = reader(socket)
  try {
    await once(socket, "connect")
    const authenticated = Boolean(proxy.username || proxy.password)
    socket.write(Buffer.from(authenticated ? [5, 1, 2] : [5, 1, 0]))
    const greeting = await input.read(2)
    if (greeting[0] !== 5 || greeting[1] !== (authenticated ? 2 : 0)) throw new Error("SOCKS authentication method rejected")
    if (authenticated) {
      const user = Buffer.from(decodeURIComponent(proxy.username))
      const pass = Buffer.from(decodeURIComponent(proxy.password))
      if (!user.length || user.length > 255 || pass.length > 255) throw new Error("Invalid SOCKS credentials length")
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
      const reply = await input.read(2)
      if (reply[0] !== 1 || reply[1] !== 0) throw new Error("SOCKS authentication failed")
    }
    // Domain form delegates destination DNS to the SOCKS server, including Tor.
    const host = Buffer.from(hostname.replace(/^\[|\]$/g, ""))
    if (!host.length || host.length > 255 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SOCKS destination")
    const destPort = Buffer.alloc(2)
    destPort.writeUInt16BE(port)
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, destPort]))
    const reply = await input.read(4)
    if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`SOCKS connection rejected (code ${reply[1]})`)
    if (reply[3] === 1) await input.read(6)
    else if (reply[3] === 4) await input.read(18)
    else if (reply[3] === 3) { const length = await input.read(1); await input.read(length[0] + 2) }
    else throw new Error("Invalid SOCKS reply address")
    input.release()
    clearTimeout(timer)
    return socket
  } catch (error) {
    clearTimeout(timer)
    input.release()
    socket.destroy()
    throw error
  }
}

// Launch preflight: can a SOCKS server be reached at all? Connect only; false instead of throwing.
export function probeSocks(host, port, timeout = 1500) {
  return new Promise(resolve => {
    try {
      const socket = net.connect({ host: host.replace(/^\[|\]$/g, ""), port, timeout }, () => { socket.destroy(); resolve(true) })
      socket.on("timeout", () => { socket.destroy(); resolve(false) }).on("error", () => resolve(false))
    } catch { resolve(false) }
  })
}

export async function createSocksBridge(proxyURL) {
  const proxy = new URL(proxyURL)
  if (!["socks5:", "socks5h:"].includes(proxy.protocol)) throw new Error("SOCKS5 proxy URL required")
  const connections = new Set()
  const track = socket => {
    connections.add(socket)
    socket.on("error", () => {})
    socket.once("close", () => connections.delete(socket))
    return socket
  }
  const server = http.createServer(async (request, response) => {
    let outgoing
    try {
      const destination = new URL(request.url)
      if (destination.protocol !== "http:" || destination.username || destination.password) throw new Error("Expected an absolute HTTP URL")
      const socket = track(await connectSocks(proxy, destination.hostname, Number(destination.port || 80)))
      const headers = { ...request.headers, host: destination.host }
      // Honor Connection-nominated hop-by-hop fields as well as proxy credentials.
      for (const name of String(headers.connection ?? "").split(",")) delete headers[name.trim().toLowerCase()]
      for (const key of ["proxy-authorization", "proxy-connection", "connection", "keep-alive", "upgrade"]) delete headers[key]
      headers.connection = "close"
      const agent = new http.Agent({ keepAlive: false })
      agent.createConnection = () => socket
      outgoing = http.request({
        host: destination.hostname, port: Number(destination.port || 80),
        path: `${destination.pathname}${destination.search}`, method: request.method,
        headers, agent,
      }, upstream => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers)
        upstream.pipe(response)
      })
      outgoing.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end("Proxy upstream failed") })
      request.on("aborted", () => outgoing.destroy())
      response.on("close", () => { socket.destroy(); agent.destroy() })
      request.pipe(outgoing)
      socket.resume()
    } catch {
      response.writeHead(502)
      response.end("SOCKS proxy unavailable or request invalid")
    }
  })
  server.on("connection", track)
  server.on("connect", async (request, client, head) => {
    client.pause()
    let upstream
    try {
      const destination = new URL(`http://${request.url}`)
      if (!destination.port || destination.username || destination.password || destination.pathname !== "/") throw new Error("Invalid CONNECT target")
      upstream = track(await connectSocks(proxy, destination.hostname, Number(destination.port)))
      if (client.destroyed) { upstream.destroy(); return }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      client.on("close", () => upstream.destroy())
      upstream.on("close", () => client.destroy())
      upstream.pipe(client)
      client.pipe(upstream)
      client.resume()
      upstream.resume()
    } catch {
      upstream?.destroy()
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
    }
  })
  server.on("clientError", (_error, socket) => socket.destroy())
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => {
      for (const socket of connections) socket.destroy()
      server.close(resolve)
    }),
  }
}

export async function applyTraffic(traffic = {}, inherited = process.env) {
  const env = { ...inherited }
  const mode = traffic.mode ?? "inherit"
  if (!["inherit", "direct", "proxy", "tor"].includes(mode)) throw new Error("Invalid traffic mode")
  if (mode === "inherit") return { env, close: async () => {} }
  for (const key of proxyKeys) delete env[key]
  if (mode === "direct") return { env, close: async () => {} }
  let selected = traffic.proxyURL
  if (mode === "tor") {
    const host = traffic.socksHost || "127.0.0.1"
    if (!/^[a-z0-9.:[\]-]+$/i.test(host)) throw new Error("Invalid Tor SOCKS host")
    selected = `socks5h://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${traffic.socksPort || 9050}`
  }
  const proxy = new URL(selected)
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(proxy.protocol)) throw new Error("Use HTTP, HTTPS or SOCKS5 proxy")
  if (!["", "/"].includes(proxy.pathname) || proxy.search || proxy.hash) throw new Error("Proxy URL cannot contain a path, query or fragment")
  let bridge
  if (proxy.protocol.startsWith("socks")) bridge = await createSocksBridge(proxy.href)
  const url = bridge?.url ?? proxy.href
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "WS_PROXY", "WSS_PROXY", "http_proxy", "https_proxy", "all_proxy", "ws_proxy", "wss_proxy"]) env[key] = url
  env.NO_PROXY = [localBypass, traffic.noProxy].filter(Boolean).join(",")
  env.no_proxy = env.NO_PROXY
  // host:port only, never the credentials a proxy URL may carry.
  return { env, socks: bridge && { host: proxy.hostname, port: Number(proxy.port || 1080) }, close: () => bridge ? bridge.close() : Promise.resolve() }
}