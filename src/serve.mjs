// infiniteoc serve / web: upstream's `opencode serve` (the v2 API plus, when built in, the web UI; always behind a
// password) started through the normal launch path, so it runs the InfiniteOC build with the same build cache,
// last-good fallback, mods and settings as the TUI. The launcher adds the policy: loopback unless asked otherwise, a
// strong password whenever another machine could connect, and a startup check that the server really refuses
// requests without it.
import net from "node:net"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFile, writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { lanAddress } from "./remote.mjs"

export const DEFAULT_HOST = "127.0.0.1"
// Upstream's first choice when --port is omitted (it then counts up past busy ports).
export const DEFAULT_PORT = 4096
// Off loopback, a password typed into OPENCODE_PASSWORD must be at least this long; a generated one has 32 characters.
export const MIN_PASSWORD = 16
// Upstream's ServerAuth username.
export const USER = "opencode"

export const usage = (mode) => `Usage: infiniteoc ${mode} [--hostname H] [--port N] [--cors ORIGIN]...${mode === "web" ? " [--no-open]" : ""}`

const bare = (host) => host.replace(/^\[(.*)\]$/, "$1").toLowerCase()
const bracket = (host) => (host.includes(":") ? `[${host}]` : host)

/** 127.0.0.0/8, ::1 (also IPv4-mapped) and localhost: only this machine can connect. */
export function isLoopback(host = "") {
  const ip = bare(host).replace(/^::ffff:/, "")
  if (ip === "localhost") return true
  if (net.isIPv4(ip)) return ip.split(".")[0] === "127"
  return ip === "::1"
}

/** Parses the flags after `serve`/`web`. Throws a message naming the problem and the usage. */
export function parseServeArgs(mode, args) {
  const options = { hostname: DEFAULT_HOST, port: undefined, cors: [], open: mode === "web" }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const value = () => {
      const given = eq === -1 ? args[++i] : arg.slice(eq + 1)
      if (given === undefined || given === "" || (eq === -1 && given.startsWith("--"))) throw new Error(`${flag} needs a value. ${usage(mode)}`)
      return given
    }
    if (flag === "--hostname" || flag === "--host") {
      const host = value()
      if (!/^[a-z0-9.:%_-]+$/i.test(bare(host))) throw new Error(`Invalid hostname ${host}`)
      options.hostname = bare(host)
    } else if (flag === "--port") {
      const text = value()
      const port = Number(text)
      // 0 would let the system pick, and then the launcher could not tell anyone where the server is.
      if (!/^\d+$/.test(text) || port < 1 || port > 65535) throw new Error(`Invalid port ${text}; use 1-65535`)
      options.port = port
    } else if (flag === "--cors") {
      const origin = value()
      let parsed
      try { parsed = new URL(origin) } catch {}
      // Upstream matches origins exactly, so anything but a bare origin would silently never match.
      if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) throw new Error(`Invalid --cors origin ${origin}; use scheme://host[:port], e.g. https://app.example.com`)
      options.cors.push(origin)
    } else if (mode === "web" && eq === -1 && (flag === "--no-open" || flag === "--open")) options.open = flag === "--open"
    else if (flag === "--service") throw new Error("--service is refused: it registers OpenCode's background service, which stock OpenCode shares. Run infiniteoc serve in the foreground (or under your own service manager).")
    else if (flag === "--stdio") throw new Error("--stdio is not supported by infiniteoc serve; it is meant for apps that embed OpenCode.")
    else throw new Error(`Unknown ${mode} option ${arg}. ${usage(mode)}`)
  }
  return options
}

/**
 * The server password: OPENCODE_PASSWORD (or upstream's legacy OPENCODE_SERVER_PASSWORD) if set, else a random one.
 * When other machines can connect, a short typed password is refused rather than trusted.
 */
export function serverPassword(env, exposed) {
  const given = env.OPENCODE_PASSWORD || env.OPENCODE_SERVER_PASSWORD
  if (given) {
    if (exposed && given.length < MIN_PASSWORD) throw new Error(`OPENCODE_PASSWORD has ${given.length} characters; a server other machines can reach needs at least ${MIN_PASSWORD}. Unset it to get a generated one.`)
    return { password: given, generated: false }
  }
  return { password: randomBytes(24).toString("base64url"), generated: true }
}

/** Where this machine reaches the server (`local`), and where other devices do when it listens on all interfaces. */
export function serverUrls(hostname, port, lan = lanAddress) {
  const host = bare(hostname)
  const wildcard = host === "0.0.0.0" || host === "::"
  const local = `http://${wildcard ? (host === "::" ? "[::1]" : "127.0.0.1") : bracket(host)}:${port}`
  const address = wildcard ? lan() : undefined
  return { local, network: isLoopback(host) ? undefined : wildcard ? (address && !isLoopback(address) ? `http://${bracket(address)}:${port}` : undefined) : local }
}

const bindable = (port, host) => new Promise((resolve) => {
  const probe = net.createServer()
  probe.once("error", () => resolve(false))
  probe.listen(port, host, () => probe.close(() => resolve(true)))
})

/** Upstream's choice when no port is given (4096, else the next free one), made here so the URL is known up front. */
export async function choosePort(hostname, from = DEFAULT_PORT) {
  for (let port = from; port < from + 100 && port <= 65535; port++) if (await bindable(port, bare(hostname))) return port
  throw new Error(`No free port in ${from}-${from + 99} on ${hostname}; pass --port`)
}

export function exposureWarning(hostname, urls) {
  return [
    `WARNING: listening on ${hostname}, which other machines can reach${urls.network ? ` (${urls.network})` : ""}.`,
    "  Anyone with the password controls this agent: it reads and edits files and runs shell commands as you.",
    "  Traffic is plain HTTP, so the password crosses the network in clear text: use a network you trust, or put",
    "  TLS (a reverse proxy) or an SSH tunnel in front. Ctrl+C stops it.",
  ].join("\n")
}

const basic = (password) => `Basic ${Buffer.from(`${USER}:${password}`).toString("base64")}`
const request = (url, init = {}, signal) => fetch(url, { ...init, redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]) })

/** Polls until the API is ready (upstream: 503 while starting, 500 if startup failed). False when `signal` aborts first (the server exited). */
export async function waitUntilUp(url, password, signal, timeout = 60_000) {
  const until = Date.now() + timeout
  while (!signal?.aborted) {
    const status = await request(`${url}/api/info`, { headers: { authorization: basic(password) } }, signal).then((r) => r.status, () => 0)
    if (status >= 200 && status < 300) return true
    if (status === 401) throw new Error(`The server at ${url} does not accept the password it was started with; is another server on that port?`)
    if (status === 500) throw new Error(`The server on ${url} failed to start; its output above says why`)
    if (Date.now() > until) throw new Error(`The server did not answer on ${url} within ${timeout / 1000}s`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/** Throws unless the API refuses both a request without credentials and one with a wrong password. */
export async function assertAuthenticated(url) {
  for (const headers of [{}, { authorization: basic(randomBytes(12).toString("base64url")) }]) {
    const status = (await request(`${url}/api/info`, { headers })).status
    if (status !== 401) throw new Error(`Refusing to keep running: ${url}/api/info answered ${status} to a request ${headers.authorization ? "with a wrong password" : "without a password"}. This build does not enforce the server password; the server was stopped.`)
  }
}

/** True when the server returns the web app's page (the build includes the web UI). */
export async function hasWebUi(url) {
  const response = await request(`${url}/`, { headers: { accept: "text/html" } }).catch(() => undefined)
  await response?.body?.cancel()
  return response?.status === 200 && /text\/html/.test(response.headers.get("content-type") ?? "")
}

/** A one-time sign-in link for a browser (upstream `opencode pair`), on `base`. */
export async function pairingLink(url, password, base = url) {
  const response = await request(`${url}/api/pair`, { method: "POST", headers: { authorization: basic(password) } })
  if (!response.ok) throw new Error(`Could not create a sign-in link (${response.status})`)
  const { code, expires_in: expires } = await response.json()
  return { link: new URL(`/auth/connect/${encodeURIComponent(code)}`, base).href, minutes: Math.round(expires / 60) }
}

/** open (macOS) or xdg-open (Linux with a display); undefined over SSH or without a desktop. */
export function browserCommand(platform = process.platform, env = process.env) {
  if (platform === "darwin") return "open"
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) return "xdg-open"
}

export function openBrowser(link) {
  const command = browserCommand()
  if (!command) return false
  const child = spawn(command, [link], { stdio: "ignore", detached: true })
  child.on("error", () => {})
  child.unref()
  return true
}

/**
 * Runs while the server does: waits for it, proves it enforces the password, then prints how to connect. A throw makes
 * launch() stop the server and fail. Returns quietly when the server exits first (launch reports its exit code).
 */
export async function announce({ mode, urls, password, generated, exposed, open, signal, built, out = console.log, browser = openBrowser }) {
  if (!await waitUntilUp(urls.local, password, signal)) return
  await assertAuthenticated(urls.local)
  // The build manifest says so for builds made since webUi existed; older ones (a last-good fallback) are asked.
  const ui = built === false ? false : await hasWebUi(urls.local)
  if (mode === "web" && !ui) throw new Error('This build has no web UI; the server was stopped. It needs "options": {"webUi": true} in infiniteoc.json and a build made with it (the next launch rebuilds; a last-good fallback may predate it).')
  const lines = [
    "",
    `  InfiniteOC ${mode === "web" ? "web UI" : "server"} on ${urls.local}${exposed ? "" : " (this machine only)"}`,
    ...(urls.network && urls.network !== urls.local ? [`  From other devices: ${urls.network}`] : []),
    `  Sign in as ${USER} with ${generated ? `password ${password}` : "the password in OPENCODE_PASSWORD"}`,
    `  TUI on this server: OPENCODE_PASSWORD=${generated ? password : "..."} infiniteoc --server ${urls.local}`,
  ]
  if (ui) {
    const local = await pairingLink(urls.local, password)
    lines.push(`  Browser sign-in link (works once, expires in ${local.minutes} min):`, `    ${local.link}`)
    if (urls.network && urls.network !== urls.local) lines.push(`  For another device (works once):`, `    ${(await pairingLink(urls.local, password, urls.network)).link}`)
    if (mode === "web" && open && browser(local.link)) lines.push("  Opened it in your browser.")
  } else lines.push("  Web UI: not in this build (infiniteoc web offers to add it)")
  lines.push("  Ctrl+C stops it.", "")
  out(lines.join("\n"))
}

/** Parses the flags, applies the safety policy, and runs the InfiniteOC build's `serve` through launch(). */
export async function serve({ mode, prefix = [], args, settings, launch, env = process.env, err = console.error, out = console.log, browser = openBrowser }) {
  const options = parseServeArgs(mode, args)
  const exposed = !isLoopback(options.hostname)
  const { password, generated } = serverPassword(env, exposed)
  const port = options.port ?? await choosePort(options.hostname)
  const urls = serverUrls(options.hostname, port)
  if (exposed) err(`[InfiniteOC] ${exposureWarning(options.hostname, urls)}`)
  const argv = [...prefix, "serve", "--hostname", options.hostname, "--port", String(port), ...options.cors.flatMap((origin) => ["--cors", origin])]
  return launch(argv, settings, {
    tui: false,
    // Set explicitly so upstream never falls back to printing its own; the legacy name could otherwise disagree.
    env: { OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: undefined },
    whileRunning: ({ signal, manifest }) => announce({ mode, urls, password, generated, exposed, open: options.open, signal, built: manifest?.webUi, out, browser }),
  })
}

/** Adds "webUi": true to infiniteoc.json options (keeps infiniteoc.json.bak); the next launch rebuilds with the web UI. */
export async function enableWebUi(base) {
  const file = join(base, "infiniteoc.json")
  const raw = await readFile(file, "utf8")
  const config = JSON.parse(raw)
  if (config.options?.webUi === true) return false
  config.options = { ...config.options, webUi: true }
  await writeFile(`${file}.bak`, raw)
  // Renamed into place: the daemon polls infiniteoc.json and must never read a partial file.
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(config, null, 2) + "\n")
  await rename(temporary, file)
  return true
}
