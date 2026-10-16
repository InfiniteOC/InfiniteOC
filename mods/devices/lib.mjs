// InfiniteOC devices: paired InfiniteOC servers (another machine's `infiniteoc serve` or `infiniteoc host`
// backend) that this agent can work on through the `device` tool and switch between mid-session. Plain JS with
// node built-ins only, so the launcher CLI, node tests and the built core plugin all use it as is. Written to
// packages/core/src/plugin/infiniteoc-devices-lib.mjs by mods/devices.
//
// Pairing is explicit and local: `infiniteoc device add NAME URL` stores the server password in a 0600 key file
// (never in the registry, never echoed). The agent can only use paired devices; adding and removing is the
// user's CLI job. Reads (list, sessions, read) run silently; open/prompt ask first, like any remote execution.
import { randomUUID } from "node:crypto"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/
export const POLL_MS = 3000
export const PROMPT_TIMEOUT_MS = 10 * 60_000

export function settingsDir(env = process.env) {
  const file = env.INFINITEOC_SETTINGS_FILE || path.join(homedir(), ".config", "infiniteoc", "settings.json")
  return path.dirname(file)
}

export const registryFile = (env = process.env) => path.join(settingsDir(env), "devices.json")
export const keysDir = (env = process.env) => path.join(settingsDir(env), "keys")

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")) } catch (error) { if (error?.code === "ENOENT") return fallback; throw new Error(`Cannot read ${file}: ${error.message}`) }
}

async function writePrivate(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, text, { mode: 0o600 })
}

/** Pairing registry without secrets: [{ name, url, addedAt }]. */
export async function listDevices(env = process.env) {
  const registry = await readJson(registryFile(env), {})
  return Object.values(registry?.devices ?? {}).map(({ name, url, addedAt }) => ({ name, url, addedAt })).sort((a, b) => a.name.localeCompare(b.name))
}

export function normalizeUrl(raw) {
  let url
  try { url = new URL(String(raw ?? "").trim()) } catch { throw new Error(`Invalid device URL ${JSON.stringify(raw)}: use http(s)://host:port from infiniteoc serve/host.`) }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Invalid device URL ${url.href}: http(s) only.`)
  if (url.username || url.password) throw new Error(`Invalid device URL: userinfo credentials are not stored (pairing uses the server password instead).`)
  return url.href.replace(/\/+$/, "")
}

/** Pair a device. The password goes to a 0600 key file; the registry keeps only its path. */
export async function addDevice({ name, url, password, env = process.env } = {}) {
  const id = String(name ?? "").trim().toLowerCase()
  if (!NAME.test(id)) throw new Error(`Invalid device name ${JSON.stringify(name)}: lowercase letters, digits, - and _.`)
  const target = normalizeUrl(url)
  if (typeof password !== "string" || !password) throw new Error(`Pairing ${id} needs the device's server password (infiniteoc serve prints it; the host login password does not work).`)
  if (/[\r\n\0]/.test(password)) throw new Error("Invalid password value")
  const file = registryFile(env)
  const registry = await readJson(file, {})
  const devices = { ...(registry?.devices ?? {}) }
  const keyFile = path.join(keysDir(env), `device-${id}-${randomUUID()}.key`)
  const previous = devices[id]
  try {
    await writePrivate(keyFile, password)
    devices[id] = { name: id, url: target, key: keyFile, addedAt: new Date().toISOString() }
    await writePrivate(file, JSON.stringify({ ...(registry ?? {}), devices }, null, 2) + "\n")
  } catch (error) {
    await unlink(keyFile).catch(() => {})
    throw error
  }
  if (previous?.key && previous.key !== keyFile && path.dirname(previous.key) === keysDir(env)) await unlink(previous.key).catch(() => {})
  return { name: id, url: target }
}

/** Unpair a device, deleting the key file this command stored for it. */
export async function removeDevice(name, env = process.env) {
  const id = String(name ?? "").trim().toLowerCase()
  const file = registryFile(env)
  const registry = await readJson(file, {})
  const devices = { ...(registry?.devices ?? {}) }
  if (!devices[id]) throw new Error(`Device "${id}" is not paired.`)
  const [removed] = [devices[id]]
  delete devices[id]
  await writePrivate(file, JSON.stringify({ ...(registry ?? {}), devices }, null, 2) + "\n")
  if (removed?.key && path.dirname(removed.key) === keysDir(env)) await unlink(removed.key).catch(() => {})
  return { name: id }
}

/** A paired device with its password resolved (throws when missing or unpaired). */
export async function resolveDevice(name, env = process.env) {
  const id = String(name ?? "").trim().toLowerCase()
  const registry = await readJson(registryFile(env), {})
  const devices = registry?.devices ?? {}
  const found = devices[id] ?? (() => {
    const prefix = Object.keys(devices).filter((key) => key.startsWith(id))
    return prefix.length === 1 ? devices[prefix[0]] : undefined
  })()
  if (!found) {
    const keys = Object.keys(devices)
    throw new Error(keys.length ? `No device "${id}" is paired. Paired: ${keys.slice(0, 20).join(", ")}.` : `No device "${id}" is paired; pair one with: infiniteoc device add ${id || "NAME"} URL.`)
  }
  let password
  // Only key files this command created (inside the keys directory) are ever read back.
  const keys = path.resolve(keysDir(env)) + path.sep
  if (!path.resolve(found.key).startsWith(keys)) throw new Error(`Device "${found.name}" points outside the keys directory; pair it again with infiniteoc device add.`)
  try { password = (await readFile(found.key, "utf8")).trim() } catch { throw new Error(`The stored password for device "${found.name}" is gone; pair it again with infiniteoc device add.`) }
  if (!password) throw new Error(`The stored password for device "${found.name}" is empty; pair it again with infiniteoc device add.`)
  return { name: found.name, url: found.url, password }
}

const auth = (password) => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

/** One authenticated call against a paired device's serve API. Never includes the password in errors. */
export async function callDevice(device, method, resource, { body, timeoutMs = 30_000 } = {}) {
  const target = `${device.url}${resource}`
  let response
  try {
    response = await fetch(target, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: auth(device.password), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw new Error(`Device "${device.name}" did not answer at ${device.url} (${error instanceof Error ? error.message : String(error)}).`)
  }
  if (response.status === 401) throw new Error(`Device "${device.name}" refused the stored password (401); pair it again with infiniteoc device add.`)
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Device "${device.name}" answered ${response.status} for ${method} ${resource}${detail ? `: ${detail.slice(0, 200)}` : "."}`)
  }
  if (response.status === 204) return undefined
  try { return await response.json() } catch { throw new Error(`Device "${device.name}" answered ${method} ${resource} with a non-JSON body.`) }
}

export const deviceSessions = (device, { limit = 50 } = {}) =>
  callDevice(device, "GET", `/api/session?limit=${Math.max(1, Math.min(Number(limit) || 50, 200))}&order=desc`).then((body) => body?.data ?? [])

export const deviceSession = (device, sessionID) =>
  callDevice(device, "GET", `/api/session/${encodeURIComponent(sessionID)}`).then((body) => body?.data)

export const deviceMessages = (device, sessionID, { limit = 50, order = "asc" } = {}) =>
  callDevice(device, "GET", `/api/session/${encodeURIComponent(sessionID)}/message?limit=${Math.max(1, Math.min(Number(limit) || 50, 200))}&order=${order === "desc" ? "desc" : "asc"}`).then((body) => body?.data ?? [])

export const deviceOpen = async (device, { directory, title } = {}) => {
  if (typeof directory !== "string" || !directory.startsWith("/")) throw new Error("open needs an absolute directory on the device.")
  return callDevice(device, "POST", "/api/session", { body: { ...(title ? { title } : {}), location: { directory } }, timeoutMs: 60_000 }).then((body) => body?.data)
}

/**
 * Work on a device: admit the prompt, then poll its messages until a new assistant/idle message lands after
 * the admitted one (or the timeout). Identity is by message id: the serve API has no seq numbers, so the ids
 * seen before admission are the baseline. Returns { sessionID, text } so the local run can switch devices
 * and continue.
 */
export async function devicePrompt(device, { sessionID, text, timeoutMs = PROMPT_TIMEOUT_MS, pollMs = POLL_MS, onWait } = {}) {
  const clean = String(text ?? "").trim()
  if (!clean) throw new Error("prompt needs text to send.")
  const seen = new Set((await deviceMessages(device, sessionID, { limit: 50, order: "desc" })).map((item) => (item?.info ?? item)?.id).filter(Boolean))
  await callDevice(device, "POST", `/api/session/${encodeURIComponent(sessionID)}/prompt`, { body: { text: clean }, timeoutMs: 60_000 })
  const until = Date.now() + Math.max(10_000, Math.min(Number(timeoutMs) || PROMPT_TIMEOUT_MS, 30 * 60_000))
  for (;;) {
    if (Date.now() > until) throw new Error(`Device "${device.name}" is still working on session ${sessionID}; read it later with the read action.`)
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    if (onWait) await onWait()
    const messages = await deviceMessages(device, sessionID, { limit: 50, order: "desc" })
    // Newest first: the first unseen assistant/idle message is the freshest completion.
    const done = messages.filter((item) => {
      const info = item?.info ?? item
      return info?.id && !seen.has(info.id) && ["assistant", "idle"].includes(info?.type ?? item?.type)
    })
    if (done.length) {
      const info = done[0]?.info ?? done[0]
      return { sessionID, text: renderRemoteText(info) || "(the device finished without printable text; read the session for details.)" }
    }
  }
}

/** Printable text out of a serve-API message, same idea as the sessions lib. */
export function renderRemoteText(info) {
  const texts = []
  const visit = (value, isText) => {
    if (typeof value === "string") { if (isText) texts.push(value); return }
    if (Array.isArray(value)) return value.forEach((item) => visit(item, isText))
    if (value && typeof value === "object") {
      if (typeof value.text === "string" && value.text) texts.push(value.text)
      for (const [key, item] of Object.entries(value)) if (key !== "text") visit(item, key === "content" || key === "parts")
    }
  }
  visit(info?.parts ?? info?.content ?? info, true)
  return texts.join("\n\n").slice(0, 20000)
}

export function formatDeviceSessions(device, sessions) {
  if (!sessions.length) return `No sessions on device "${device.name}".`
  return sessions.slice(0, 50).map((item) => `- ${item.id} · ${item.title || "Untitled"} · ${item.location?.directory ?? item.directory ?? "?"}`).join("\n")
}

export function formatDeviceMessages(device, sessionID, messages) {
  const head = `Session ${sessionID} on device "${device.name}" (${messages.length} message${messages.length === 1 ? "" : "s"})`
  if (!messages.length) return `${head}\nNo messages.`
  const rendered = messages.map((item) => {
    const info = item?.info ?? item
    const text = renderRemoteText(info) || "(no text)"
    const seq = info?.seq ?? item?.seq ?? "?"
    const type = info?.type ?? item?.type ?? "?"
    return `[${seq} ${type}]\n${String(text).slice(0, 2000)}`
  })
  const out = [head, "", ...rendered].join("\n")
  return out.length > 20000 ? `${out.slice(0, 20000)}\n… (output truncated)` : out
}
