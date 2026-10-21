// Headless Chrome through the DevTools protocol: screenshots at several widths and color schemes, a pixel
// diff, axe-core and an overflow check. Detects an installed Chrome/Chromium/Edge; never installs anything.
// ponytail: one browser per check, sequential captures; add a pool if checks ever need to be faster.
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFile, readFileSync, rmSync, statSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const VIEWPORTS = {
  phone: { width: 375, height: 812, mobile: true },
  tablet: { width: 768, height: 1024, mobile: true },
  desktop: { width: 1280, height: 800, mobile: false },
} as const
export type Scheme = "light" | "dark"
export interface ViewportSpec {
  name: string
  width: number
  height: number
  mobile: boolean
}
export const MAX_HEIGHT = 2000

export function viewportSpecs(names: ReadonlyArray<string | number> | undefined): ViewportSpec[] {
  return (names?.length ? names : Object.keys(VIEWPORTS)).map((item) => {
    const preset = VIEWPORTS[String(item) as keyof typeof VIEWPORTS]
    if (preset) return { name: String(item), ...preset }
    const width = Number(item)
    if (!Number.isFinite(width) || width < 200 || width > 3000) throw new Error(`Unknown viewport "${item}". Use phone, tablet, desktop or a width from 200 to 3000.`)
    return { name: `${width}px`, width, height: Math.round(width * 0.625), mobile: width < 500 }
  })
}

export function findChrome(env: Record<string, string | undefined> = process.env): string | undefined {
  const fixed = [
    env.INFINITEOC_CHROME, env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ]
  for (const candidate of fixed) if (candidate && existsSync(candidate)) return candidate
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
    const found = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" })
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split("\n")[0]
  }
  return playwrightChromium(env)
}

const PLAYWRIGHT_BINARIES = [
  "chrome-linux/chrome", "chrome-linux64/chrome",
  "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
  "chrome-win/chrome.exe", "chrome-win64/chrome.exe",
]

/** Chromium that Playwright downloaded (common on dev machines without a system Chrome), newest revision first. */
export function playwrightChromium(env: Record<string, string | undefined> = process.env): string | undefined {
  const home = env.HOME || env.USERPROFILE
  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0" ? env.PLAYWRIGHT_BROWSERS_PATH : undefined,
    home && path.join(home, ".cache", "ms-playwright"),
    home && path.join(home, "Library", "Caches", "ms-playwright"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "ms-playwright"),
  ]
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    const revisions = readdirSync(root).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    for (const revision of revisions) for (const binary of PLAYWRIGHT_BINARIES) {
      const file = path.join(root, revision, binary)
      if (existsSync(file)) return file
    }
  }
  return undefined
}

/** axe-core from the project (or an explicit path), never fetched: nearest node_modules above cwd, then the global one. */
export function findAxe(cwd: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.INFINITEOC_AXE_CORE && existsSync(env.INFINITEOC_AXE_CORE)) return env.INFINITEOC_AXE_CORE
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "node_modules", "axe-core", "axe.min.js")
    if (existsSync(file)) return file
    if (path.dirname(dir) === dir) break
  }
  const global = spawnSync("npm", ["root", "-g"], { encoding: "utf8" })
  const file = global.status === 0 ? path.join(global.stdout.trim(), "axe-core", "axe.min.js") : ""
  return file && existsSync(file) ? file : undefined
}

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|[^.]+\.localhost)$/
/** A URL or a local file path to a navigable URL; remote hosts only when the user allowed network access. */
export function toUrl(target: string, network: boolean): string {
  if (/^https?:\/\//i.test(target)) {
    const host = new URL(target).hostname
    const bracketed = host.includes(":") ? `[${host.replace(/^\[|\]$/g, "")}]` : host
    if (!LOCAL.test(bracketed) && !network) throw new Error(`Refusing to load ${target}: only localhost and local files are rendered unless INFINITEOC_QUALITY_NETWORK=1 is set.`)
    return target
  }
  if (/^file:\/\//i.test(target)) return target
  const full = path.resolve(target)
  if (!existsSync(full)) throw new Error(`Not found: ${target}. Pass an http://localhost URL (a running dev server) or an HTML file path.`)
  return pathToFileURL(full).href
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".cjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".map": "application/json", ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
}

export interface LocalServer {
  /** The page's http URL. */
  url: string
  /** `http://127.0.0.1:PORT`, to map messages back to file paths. */
  origin: string
  /** The served folder: the HTML file's own directory. */
  root: string
  /** Files the page requested that do not exist (relative to root), favicon.ico aside. */
  missing: string[]
  close: () => Promise<void>
}

/**
 * Serve an HTML file's folder on 127.0.0.1 for the length of one check. Under file:// Chrome blocks ES
 * module scripts and fetch, so a page that works in any static server rendered broken. Only GET and
 * HEAD, only files inside the folder, never dotfiles or dot-folders (.env, .git), no caching.
 */
export async function serveLocal(file: string): Promise<LocalServer> {
  const root = path.dirname(path.resolve(file))
  const missing: string[] = []
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end()
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname)
    } catch {
      return void res.writeHead(400).end()
    }
    if (pathname.includes("\0") || pathname.split("/").some((part) => part.startsWith("."))) return void res.writeHead(404).end()
    let full = path.join(root, pathname)
    if (full !== root && !full.startsWith(root + path.sep)) return void res.writeHead(404).end()
    try {
      if (statSync(full).isDirectory()) full = path.join(full, "index.html")
    } catch {}
    readFile(full, (error, body) => {
      if (error) {
        const name = path.relative(root, full)
        if (name !== "favicon.ico" && !missing.includes(name)) missing.push(name)
        return void res.writeHead(404).end()
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" })
      res.end(req.method === "HEAD" ? undefined : body)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const relative = path.relative(root, path.resolve(file)).split(path.sep).map(encodeURIComponent).join("/")
  return {
    url: `${origin}/${relative}`,
    origin,
    root,
    missing,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}

const WS: any = (globalThis as any).WebSocket

class Cdp {
  private id = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private listeners: Array<(method: string, params: any) => void> = []
  private ws: any
  private constructor(ws: any) {
    this.ws = ws
    ws.onmessage = (event: { data: string }) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) entry?.reject(new Error(`${message.error.message}`))
        else entry?.resolve(message.result)
      } else for (const listener of this.listeners) listener(message.method, message.params)
    }
    ws.onclose = () => {
      for (const entry of this.pending.values()) entry.reject(new Error("Chrome closed the connection"))
      this.pending.clear()
    }
  }
  static open(url: string) {
    return new Promise<Cdp>((resolve, reject) => {
      const ws = new WS(url)
      ws.onopen = () => resolve(new Cdp(ws))
      ws.onerror = () => reject(new Error("Could not connect to Chrome's DevTools port"))
    })
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  on(listener: (method: string, params: any) => void) {
    this.listeners.push(listener)
  }
  waitFor(method: string, ms: number) {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      const listener = (name: string) => {
        if (name !== method) return
        clearTimeout(timer)
        this.listeners = this.listeners.filter((item) => item !== listener)
        resolve(true)
      }
      this.listeners.push(listener)
    })
  }
  close() {
    this.ws.onclose = null
    try {
      this.ws.close()
    } catch {}
  }
}

async function launch(chrome: string) {
  const profile = mkdtempSync(path.join(tmpdir(), "infiniteoc-chrome-"))
  const child: ChildProcess = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    // Chrome refuses to start as root on Linux (containers, CI) unless its sandbox is off.
    ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] })
  const remove = () => {
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {}
  }
  const stop = () => {
    child.kill("SIGKILL")
    remove()
    // Chrome's helper processes can still write to the profile for a moment after the kill, which left
    // profile folders behind; remove it again once the browser has exited.
    if (child.exitCode === null && child.signalCode === null) child.once("exit", () => setTimeout(remove, 200))
    else setTimeout(remove, 200)
  }
  const endpoint = await new Promise<string>((resolve, reject) => {
    let log = ""
    const limit = Number(process.env.INFINITEOC_CHROME_TIMEOUT_SECONDS ?? 120)
    const timer = setTimeout(() => reject(new Error(`Chrome did not start within ${limit}s. ${log.slice(-300)}`)), limit * 1000)
    child.stderr!.on("data", (chunk) => {
      log += chunk
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(log)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.on("exit", (code) => reject(new Error(`Chrome exited early (${code}). ${log.slice(-300)}`)))
  }).catch((error) => {
    stop()
    throw error
  })
  try {
    const port = new URL(endpoint).port
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
    const page = targets.find((target) => target.type === "page")
    if (!page) throw new Error("Chrome has no page target")
    return { cdp: await Cdp.open(page.webSocketDebuggerUrl), stop }
  } catch (error) {
    stop()
    throw error
  }
}

// Runs in the page: pixel-compare two images (any format Chrome decodes), return the summary and a diff PNG.
// Built-in checks for when axe-core is not installed: labels, accessible names, repeated row-action names,
// text contrast against the nearest opaque background, image alt and html lang. Returns JSON violations.
export const BASIC_AUDIT = `(() => {
  const found = new Map()
  const short = (el, depth = 0) => {
    if (el.id) return \`#\${CSS.escape(el.id)}\`
    let part = el.tagName.toLowerCase()
    if (el.classList.length) part += \`.\${[...el.classList].slice(0, 2).map((c) => CSS.escape(c)).join(".")}\`
    const parent = el.parentElement
    if (!parent || parent === document.body || depth >= 2) return part
    const same = [...parent.children].filter((c) => c.tagName === el.tagName)
    if (same.length > 1) part += \`:nth-of-type(\${same.indexOf(el) + 1})\`
    return \`\${short(parent, depth + 1)} > \${part}\`
  }
  const add = (id, impact, help, el) => {
    const item = found.get(id) ?? { id, impact, help, nodes: [] }
    if (item.nodes.length < 12) item.nodes.push(short(el))
    found.set(id, item)
  }
  const visible = (el) => {
    const style = getComputedStyle(el)
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const text = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim()
  const name = (el) => {
    const by = el.getAttribute("aria-labelledby")
    if (by) { const t = by.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(text).join(" ").trim(); if (t) return t }
    const aria = (el.getAttribute("aria-label") || "").trim()
    if (aria) return aria
    if (el.labels && el.labels.length) { const t = [...el.labels].map(text).join(" ").trim(); if (t) return t }
    if (/^(BUTTON|A|SUMMARY)$/.test(el.tagName) || el.getAttribute("role") === "button") {
      const t = text(el) || [...el.querySelectorAll("img[alt]")].map((i) => i.alt).join(" ").trim()
      if (t) return t
    }
    if (el.tagName === "INPUT" && /^(submit|button|reset)$/.test(el.type)) return (el.value || "").trim()
    return (el.getAttribute("title") || "").trim()
  }

  if (!document.documentElement.getAttribute("lang")) add("html-has-lang", "serious", "The <html> element needs a lang attribute.", document.documentElement)
  for (const img of document.querySelectorAll("img:not([alt])")) if (visible(img)) add("image-alt", "critical", "Images need alt text (empty alt for decorative images).", img)
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea'))
    if (visible(el) && !name(el)) add("label", "critical", "Form control has no label (use <label for>, aria-label or aria-labelledby).", el)
  const actions = [...document.querySelectorAll('button, a[href], [role=button], input[type=submit], input[type=button]')].filter(visible)
  for (const el of actions) if (!name(el)) add("button-name", "critical", "Button or link has no accessible name.", el)
  // Repeated row actions: "Edit", "Edit", "Edit" in a list tells a screen reader user nothing about which item.
  const groups = new Map()
  for (const el of actions) {
    const row = el.closest("li, tr, [role=row], [role=listitem], article")
    const label = name(el).toLowerCase()
    if (!row || !label) continue
    const list = groups.get(label) ?? []
    if (!list.some((other) => other.row === row)) list.push({ el, row })
    groups.set(label, list)
  }
  for (const [label, list] of groups) if (list.length > 1)
    for (const { el } of list.slice(0, 2)) add("repeated-action-name", "moderate", \`Several list items have an action named "\${label}"; name each after its item (for example aria-label="\${label[0].toUpperCase() + label.slice(1)} <item>").\`, el)

  // Text contrast against the nearest opaque background (WCAG AA: 4.5:1, 3:1 for large text).
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  const cache = new Map()
  const rgba = (color) => {
    if (cache.has(color)) return cache.get(color)
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    const value = [r, g, b, a / 255]; cache.set(color, value); return value
  }
  const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1)
  const background = (el) => {
    const layers = []
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.backgroundImage && style.backgroundImage !== "none") return undefined
      const color = rgba(style.backgroundColor)
      if (color[3] > 0) layers.push(color)
      if (color[3] >= 1) break
    }
    const dark = matchMedia("(prefers-color-scheme: dark)").matches && /dark/.test(getComputedStyle(document.documentElement).colorScheme)
    return layers.reverse().reduce((acc, layer) => over(layer, acc), dark ? [18, 18, 18, 1] : [255, 255, 255, 1])
  }
  const luminance = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const hex = (c) => \`#\${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}\`
  let checked = 0
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    if (checked > 600) break
    if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|CANVAS|IMG|VIDEO|OPTION)$/i.test(el.tagName)) continue
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue
    if (!visible(el)) continue
    checked++
    const style = getComputedStyle(el)
    const bg = background(el)
    if (!bg) continue
    const fg = over(rgba(style.color), bg)
    const size = parseFloat(style.fontSize), bold = Number(style.fontWeight) >= 700
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5
    const got = ratio(fg, bg)
    if (got < need) add("color-contrast", "serious", \`Text contrast below \${need}:1 (for example \${got.toFixed(2)}:1, \${hex(fg)} on \${hex(bg)}).\`, el)
  }
  return JSON.stringify([...found.values()])
})()`

const DIFF_SCRIPT = `(async (a, b) => {
  const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("image decode failed")); i.src = u })
  const [A, B] = await Promise.all([load(a), load(b)])
  const w = Math.max(A.width, B.width), h = Math.max(A.height, B.height)
  const draw = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data }
  const da = draw(A), db = draw(B)
  const out = document.createElement("canvas"); out.width = w; out.height = h
  const ox = out.getContext("2d"); const od = ox.createImageData(w, h)
  const G = 4, cells = new Array(G * G).fill(0), size = new Array(G * G).fill(0)
  let changed = 0, x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let i = 0, p = 0; i < da.length; i += 4, p++) {
    const x = p % w, y = (p - x) / w, cell = Math.min(G - 1, Math.floor(y * G / h)) * G + Math.min(G - 1, Math.floor(x * G / w))
    size[cell]++
    if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 48) {
      changed++; cells[cell]++
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
      od.data[i] = 255; od.data[i + 1] = 0; od.data[i + 2] = 80; od.data[i + 3] = 255
    } else { od.data[i] = od.data[i + 1] = od.data[i + 2] = 255 - (255 - db[i]) * 0.25; od.data[i + 3] = 255 }
  }
  ox.putImageData(od, 0, 0)
  const names = ["top", "upper middle", "lower middle", "bottom"], cols = ["left", "center-left", "center-right", "right"]
  const hot = cells.map((n, i) => ({ n: n / size[i], where: names[Math.floor(i / G)] + " " + cols[i % G] })).filter((c) => c.n > 0.01).sort((p, q) => q.n - p.n).slice(0, 5).map((c) => c.where + " " + Math.round(c.n * 100) + "%")
  return { width: w, height: h, a: [A.width, A.height], b: [B.width, B.height], changedPct: Math.round(changed / (w * h) * 10000) / 100, box: changed ? [x0, y0, x1, y1] : null, hot, png: out.toDataURL("image/png").split(",")[1] }
})`

export interface Diff {
  width: number
  height: number
  a: [number, number]
  b: [number, number]
  changedPct: number
  box: [number, number, number, number] | null
  hot: string[]
  png: string
}

// Which elements make the page wider than the viewport: those whose right edge passes it while their parent's
// does not (the outermost offender of each chain), skipping anything inside a scrolling or clipping container.
export const OFFENDERS = `(() => {
  const vw = window.innerWidth
  const label = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : [...el.classList].slice(0, 2).map((c) => "." + c).join(""))
  const where = (el) => { const parts = []; for (let e = el; e && e !== document.documentElement && (e !== document.body || e === el) && parts.length < 3; e = e.parentElement) parts.unshift(label(e)); return parts.join(" > ") }
  const contained = (el) => { for (let e = el.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) if (/^(auto|scroll|hidden|clip)$/.test(getComputedStyle(e).overflowX)) return true; return false }
  const found = []
  const all = document.body ? [document.body, ...document.body.querySelectorAll("*")] : []
  for (const el of all.slice(0, 5000)) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.right <= vw + 1 || getComputedStyle(el).position === "fixed") continue
    const parent = el.parentElement
    if (parent && parent !== document.documentElement && parent.getBoundingClientRect().right > vw + 1) continue
    if (contained(el)) continue
    found.push({ at: where(el), right: Math.round(r.right), width: Math.round(r.width) })
  }
  return found.sort((a, b) => b.right - a.right).slice(0, 3).map((f) => f.at + " (" + f.width + "px wide, right edge at " + f.right + "px)")
})()`

const dataUrl = (png: string) => `data:image/png;base64,${png}`
const mimeOf = (file: string) => (/\.jpe?g$/i.test(file) ? "image/jpeg" : /\.webp$/i.test(file) ? "image/webp" : "image/png")

export interface Shot {
  label: string
  viewport: string
  scheme: Scheme
  width: number
  png: string
  overflow?: number
  /** The outermost elements that stick out past the viewport, when the page overflows. */
  offenders?: string[]
  baseline?: string
  diff?: Diff
}
export interface Violation {
  id: string
  impact: string
  help: string
  nodes: string[]
  seen: string[]
}
export interface CheckOptions {
  chrome: string
  url: string
  /** What to capture, in order. */
  plan: Array<{ viewport: ViewportSpec; scheme: Scheme }>
  fullPage: boolean
  axeSource?: string
  /** Without axeSource: run the built-in BASIC_AUDIT instead. */
  basicAudit?: boolean
  /** Previously saved PNG (base64) for a viewport/scheme label, to diff against. */
  baseline?: (label: string) => string | undefined
  mockup?: { file: string; base64: string }
}
export interface CheckResult {
  shots: Shot[]
  violations: Violation[]
  consoleErrors: string[]
  mockup?: { shot: Shot; diff: Diff }
}

export async function runCheck(opts: CheckOptions): Promise<CheckResult> {
  const { cdp, stop } = await launch(opts.chrome)
  try {
    const consoleErrors: string[] = []
    cdp.on((method, params) => {
      if (method === "Runtime.exceptionThrown") consoleErrors.push(String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text).split("\n")[0])
      // A missing favicon is browser noise, not a page error.
      else if (method === "Log.entryAdded" && params.entry.level === "error" && !/\/favicon\.ico(?:[?#]|$)/.test(params.entry.url ?? "")) consoleErrors.push(`${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ""}`)
      else if (method === "Runtime.consoleAPICalled" && params.type === "error") consoleErrors.push(params.args.map((arg: { value?: unknown; description?: string }) => arg.value ?? arg.description).join(" "))
    })
    for (const domain of ["Page", "Runtime", "Log"]) await cdp.send(`${domain}.enable`)
    const evaluate = async (expression: string) => {
      const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value
    }
    const capture = async (viewport: ViewportSpec, scheme: Scheme, height?: number): Promise<Shot> => {
      // Not mobile emulation: a page without a viewport meta tag would be laid out at 980px and its overflow at phone width would go unseen.
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: height ?? viewport.height, deviceScaleFactor: 1, mobile: false })
      await cdp.send("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-color-scheme", value: scheme }] })
      const loaded = cdp.waitFor("Page.loadEventFired", 20000)
      const nav = await cdp.send("Page.navigate", { url: opts.url })
      if (nav.errorText) throw new Error(`Could not load ${opts.url}: ${nav.errorText}`)
      if (!(await loaded)) throw new Error(`Timed out loading ${opts.url}`)
      // Fonts and a short settle for entry animations and client rendering.
      await evaluate("document.fonts ? document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 400))) : new Promise((r) => setTimeout(r, 400))")
      const overflow: number = await evaluate("Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0) - window.innerWidth")
      const offenders: string[] | undefined = overflow > 1 ? await evaluate(OFFENDERS) : undefined
      const content: number = await evaluate("Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))")
      const tall = opts.fullPage || height ? Math.min(Math.max(content, height ?? viewport.height), MAX_HEIGHT) : viewport.height
      const image = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: viewport.width, height: tall, scale: 1 } })
      return { label: `${viewport.name}-${scheme}`, viewport: viewport.name, scheme, width: viewport.width, png: image.data, overflow: overflow > 1 ? overflow : undefined, offenders: offenders?.length ? offenders : undefined }
    }

    const shots: Shot[] = []
    const violations = new Map<string, Violation>()
    for (const { viewport, scheme } of opts.plan) {
      const shot = await capture(viewport, scheme)
      shots.push(shot)
      let found: Array<{ id: string; impact: string; help: string; nodes: string[] }> = []
      if (opts.axeSource) {
        await evaluate(readFileSync(opts.axeSource, "utf8"))
        found = JSON.parse(
          await evaluate(`axe.run(document, { resultTypes: ["violations"] }).then((r) => JSON.stringify(r.violations.map((v) => ({ id: v.id, impact: v.impact || "minor", help: v.help, nodes: v.nodes.map((n) => n.target.join(" ")) }))))`),
        )
      } else if (opts.basicAudit) found = JSON.parse(await evaluate(BASIC_AUDIT))
      for (const item of found) {
        const known = violations.get(item.id) ?? { ...item, nodes: [], seen: [] }
        for (const node of item.nodes) if (!known.nodes.includes(node)) known.nodes.push(node)
        known.seen.push(shot.label)
        violations.set(item.id, known)
      }
    }

    // Diffs and the mockup compare run on a blank page: they only need a canvas.
    const diffs = async (a: string, b: string, mime = "image/png"): Promise<Diff> => {
      await cdp.send("Page.navigate", { url: "about:blank" })
      return evaluate(`(${DIFF_SCRIPT})(${JSON.stringify(dataUrl(a))}, ${JSON.stringify(`data:${mime};base64,${b}`)})`)
    }
    for (const shot of shots) {
      const before = opts.baseline?.(shot.label)
      if (before) {
        shot.baseline = before
        shot.diff = await diffs(before, shot.png)
      }
    }
    let mockup: CheckResult["mockup"]
    if (opts.mockup) {
      await cdp.send("Page.navigate", { url: "about:blank" })
      const size: [number, number] = await evaluate(`new Promise((res, rej) => { const i = new Image(); i.onload = () => res([i.width, i.height]); i.onerror = () => rej(new Error("mockup image could not be decoded")); i.src = ${JSON.stringify(`data:${mimeOf(opts.mockup.file)};base64,${opts.mockup.base64}`)} })`)
      const width = Math.min(Math.max(size[0], 320), 2560)
      const shot = await capture({ name: `mockup-${width}px`, width, height: Math.min(size[1], MAX_HEIGHT), mobile: width < 500 }, "light", Math.min(size[1], MAX_HEIGHT))
      mockup = { shot, diff: await diffs(shot.png, opts.mockup.base64, mimeOf(opts.mockup.file)) }
    }
    return { shots, violations: [...violations.values()], consoleErrors: [...new Set(consoleErrors)].slice(0, 8), mockup }
  } finally {
    cdp.close()
    stop()
  }
}

const ORDER = ["critical", "serious", "moderate", "minor"]
export function formatReport(result: CheckResult, axe: "ran" | "missing" | "basic" | "off", target: string) {
  const out = [`UI check of ${target}: ${result.shots.map((shot) => shot.label).join(", ")}.`]
  const overflowing = result.shots.filter((shot) => shot.overflow)
  out.push(overflowing.length ? `Horizontal overflow (page wider than the viewport): ${overflowing.map((shot) => `${shot.label} by ${shot.overflow}px`).join(", ")}. Fix it.` : "No horizontal overflow at any width.")
  const culprits = overflowing.find((shot) => shot.offenders?.length)
  if (culprits) out.push(`  Sticking out at ${culprits.label}: ${culprits.offenders!.join("; ")}`)
  if (result.consoleErrors.length) out.push(`Console errors:\n${result.consoleErrors.map((line) => `  ${line}`).join("\n")}`)
  const source = axe === "basic" ? "built-in checks; add axe-core as a devDependency for a full audit" : "axe-core"
  if (axe === "off") {}
  else if (axe === "missing") out.push("Accessibility: axe-core not found, so no automated accessibility audit ran. Resolve it by adding axe-core as a devDependency (not installed automatically) or set INFINITEOC_AXE_CORE to its axe.min.js. Check contrast, labels and keyboard focus by hand.")
  else if (result.violations.length === 0) out.push(`Accessibility (${source}): no violations in the rendered page.${axe === "basic" ? " Still tab through the page and check focus by hand." : ""}`)
  else
    out.push(
      `Accessibility (${source}): ${result.violations.length} violation${result.violations.length === 1 ? "" : "s"}; fix them before reporting done.\n` +
        result.violations
          .sort((a, b) => ORDER.indexOf(a.impact) - ORDER.indexOf(b.impact))
          .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n    at ${v.nodes.slice(0, 3).join(" ; ")}${v.nodes.length > 3 ? ` (+${v.nodes.length - 3} more)` : ""}\n    seen in ${[...new Set(v.seen)].join(", ")}`)
          .join("\n"),
    )
  for (const shot of result.shots.filter((item) => item.diff)) {
    const diff = shot.diff!
    out.push(
      `Visual diff ${shot.label} versus the saved baseline: ${diff.changedPct}% of pixels changed${diff.box ? `, bounding box x ${diff.box[0]}-${diff.box[2]} y ${diff.box[1]}-${diff.box[3]}` : ""}${diff.hot.length ? `; most in ${diff.hot.join(", ")}` : ""}${diff.a[0] !== diff.b[0] || diff.a[1] !== diff.b[1] ? `; size ${diff.a.join("x")} became ${diff.b.join("x")}` : ""}.`,
    )
  }
  if (result.mockup) {
    const { diff } = result.mockup
    out.push(`Mockup compare at ${result.mockup.shot.width}px: ${diff.changedPct}% of pixels differ from the mockup${diff.hot.length ? `; largest differences: ${diff.hot.join(", ")}` : ""}${diff.a[0] !== diff.b[0] || diff.a[1] !== diff.b[1] ? `; rendered ${diff.a.join("x")} versus mockup ${diff.b.join("x")}` : ""}. The last image highlights differing pixels in red.`)
  }
  return out.join("\n")
}
