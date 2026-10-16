import { readFile, mkdir, open, rename, unlink, lstat } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"

export function settingsFile(env = process.env) {
  return env.INFINITEOC_SETTINGS_FILE || path.join(os.homedir(), ".config/infiniteoc/settings.json")
}
export function providerConfigFile(env = process.env) {
  // OpenCode uses ~/.config on every OS, Windows included (packages/util/src/global-roots.ts).
  return env.OPENCODE_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode/opencode.json")
}
const defaults = () => ({ traffic: { mode: "inherit", proxyURL: "", socksHost: "127.0.0.1", socksPort: 9050, noProxy: "" }, providers: {} })
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
export function validateTraffic(input = {}) {
  if (!record(input)) throw new Error("Traffic must be an object")
  const result = { ...defaults().traffic, ...input }
  if (!["inherit", "direct", "proxy", "tor"].includes(result.mode)) throw new Error("Invalid traffic mode")
  if (typeof result.proxyURL !== "string" || typeof result.noProxy !== "string") throw new Error("Invalid traffic fields")
  if (result.mode === "proxy" || result.proxyURL) {
    let url
    try { url = new URL(result.proxyURL) } catch { throw new Error("Proxy URL must be a valid HTTP(S) or SOCKS5 URL") }
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) || !url.hostname || url.hash || url.search || (url.pathname !== "" && url.pathname !== "/")) throw new Error("Unsupported proxy URL")
  }
  const host = result.socksHost
  // Only Tor reads the host, with this rule and URL (src/traffic.mjs applyTraffic): a host it rejects would block
  // the next launch. Other modes keep the loose check, so files older versions saved still load.
  if (typeof host !== "string" || !host || /[\s/@?#]/.test(host) || (result.mode === "tor" && (!/^[a-z0-9.:[\]-]+$/i.test(host) || !URL.canParse(`socks5h://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:9050`)))) throw new Error("SOCKS host must use letters, digits, dots, hyphens or an IPv6 address, without a port")
  result.socksPort = Number(result.socksPort)
  if (!Number.isInteger(result.socksPort) || result.socksPort < 1 || result.socksPort > 65535) throw new Error("SOCKS port must be 1–65535")
  if (/[\r\n\0]/.test(result.noProxy)) throw new Error("Invalid no-proxy list")
  return result
}
export async function readObject(file) {
  let raw
  try { raw = await readFile(file, "utf8") } catch (e) { if (e.code === "ENOENT") return { raw: null, value: {} }; throw new Error("Unable to read configuration file") }
  let value
  try { value = JSON.parse(raw) } catch { throw new Error("Configuration must be strict JSON; JSONC/comments are not modified") }
  if (!record(value)) throw new Error("Configuration root must be an object")
  return { raw, value }
}
export async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  try { if (!(await lstat(file)).isFile()) throw new Error("Configuration target must be a regular file") } catch (e) { if (e.code !== "ENOENT") throw e }
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmp, "wx", 0o600)
    try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
    await rename(tmp, file)
  } finally { await unlink(tmp).catch(() => {}) }
}
export async function loadSettings(file = settingsFile()) {
  const { value } = await readObject(file)
  if (value.providers !== undefined && !record(value.providers)) throw new Error("Providers must be an object")
  return { ...defaults(), ...value, traffic: validateTraffic(value.traffic), providers: value.providers || {} }
}
export async function saveSettings(settings, file = settingsFile()) {
  if (!record(settings) || !record(settings.providers || {})) throw new Error("Invalid settings")
  const normalized = { ...settings, traffic: validateTraffic(settings.traffic), providers: settings.providers || {} }
  await atomicWrite(file, JSON.stringify(normalized, null, 2) + "\n")
  return normalized
}
export const providerProtocols = Object.freeze({
  anthropic: "@ai-sdk/anthropic",
  "openai-completions": "@ai-sdk/openai-compatible",
  "openai-responses": "@ai-sdk/openai",
  gemini: "@ai-sdk/google",
})
export function validateProvider(input) {
  if (!record(input) || !Object.hasOwn(providerProtocols, input.protocol)) throw new Error("Invalid provider protocol")
  if (typeof input.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.id) || ["constructor", "prototype", "__proto__"].includes(input.id)) throw new Error("Provider ID must use letters, digits, underscores or hyphens")
  let url
  try { url = new URL(input.baseURL) } catch { throw new Error("Provider base URL must be HTTP(S)") }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search || /\{(?:env|file):/.test(input.baseURL)) throw new Error("Provider base URL must be HTTP(S), without credentials or query")
  const models = typeof input.models === "string" ? input.models.split(/[\s,]+/).filter(Boolean) : input.models
  if (!Array.isArray(models) || !models.length || models.some((id) => typeof id !== "string" || !id.trim() || /[\s#\0]/.test(id) || ["__proto__", "constructor", "prototype"].includes(id))) throw new Error("At least one valid model ID is required")
  const apiKey = input.apiKey || ""
  if (typeof apiKey !== "string" || /[\r\n\0]/.test(apiKey)) throw new Error("Invalid API key")
  if (apiKey.startsWith("{env:") && !/^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(apiKey)) throw new Error("Invalid environment key reference")
  return { id: input.id, protocol: input.protocol, baseURL: input.baseURL, models: [...new Set(models)], apiKey }
}
export function buildProvider(input, keyReference) {
  const provider = validateProvider(input)
  return {
    name: provider.id,
    package: providerProtocols[provider.protocol],
    settings: { baseURL: provider.baseURL, ...(keyReference ? { apiKey: keyReference } : {}) },
    models: Object.fromEntries(provider.models.map((id) => [id, { name: id, modelID: id }])),
  }
}
// Keys never enter settings metadata or error messages. Raw keys are stored separately;
// OpenCode's ConfigVariable substitutes {file:...} and {env:...} on load.
// opencode merges opencode.json with an opencode.jsonc beside it; the overlay only beats this write when it
// defines the same provider ID. Comments and trailing commas are stripped outside of strings to read it.
export function parseJsonc(text) {
  let out = "", quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) { out += c; if (c === "\\") out += text[++i] ?? ""; else if (c === '"') quoted = false; continue }
    if (c === '"') { quoted = true; out += c; continue }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 1; continue }
    out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}
async function assertNoOverlayConflict(configFile, id) {
  let raw
  try { raw = await readFile(`${configFile}c`, "utf8") } catch (e) { if (e.code === "ENOENT") return; throw e }
  let overlay
  try { overlay = parseJsonc(raw) } catch { throw new Error("Could not read the JSONC overlay beside the config; fix its syntax or remove it before adding providers") }
  if (record(overlay) && [overlay.providers, overlay.provider].some((group) => record(group) && Object.hasOwn(group, id))) throw new Error("The JSONC overlay already defines this provider ID; choose a new ID")
}
// Asks the endpoint which models it serves. The key only goes to the base URL the user typed, redirects are refused so
// it cannot be forwarded elsewhere, and failures give static text (never the key, URL or response body).
export async function discoverModels(input, options = {}) {
  const provider = validateProvider({ ...input, models: input.models || "x" })
  let key = provider.apiKey
  const env = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(key)
  if (env) key = (options.env || process.env)[env[1]] || ""
  const headers = { accept: "application/json" }
  if (provider.protocol === "gemini") { if (key) headers["x-goog-api-key"] = key }
  else if (provider.protocol === "anthropic") { headers["anthropic-version"] = "2023-06-01"; if (key) headers["x-api-key"] = key }
  else if (key) headers.authorization = `Bearer ${key}`
  let body
  try {
    const response = await (options.fetch || fetch)(`${provider.baseURL.replace(/\/+$/, "")}/models${provider.protocol === "gemini" ? "?pageSize=1000" : ""}`, { headers, redirect: "error", signal: AbortSignal.timeout(options.timeout ?? 8000) })
    if (!response.ok) throw new Error(`The endpoint answered HTTP ${response.status} to its model list`)
    body = await response.json()
  } catch (e) {
    if (e instanceof Error && e.constructor === Error && e.message.startsWith("The endpoint")) throw e
    throw new Error("Could not reach the endpoint's model list")
  }
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
  const ids = list
    .filter((m) => !Array.isArray(m?.supportedGenerationMethods) || m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => String(typeof m === "string" ? m : m?.id ?? m?.name ?? "").replace(/^models\//, ""))
    .filter((id) => id && !/[\s#\0]/.test(id) && !["__proto__", "constructor", "prototype"].includes(id))
  if (!ids.length) throw new Error("The endpoint returned no models")
  return [...new Set(ids)].sort()
}
export async function saveProvider(input, options = {}) {
  const provider = validateProvider(input)
  const configFile = options.configFile || providerConfigFile()
  if (configFile.endsWith(".jsonc")) throw new Error("JSONC configuration is not modified; choose a strict JSON file")
  const { raw, value } = await readObject(configFile)
  if (value.providers !== undefined && !record(value.providers)) throw new Error("Existing providers must be an object")
  if (Object.hasOwn(value.providers || {}, provider.id) || Object.hasOwn(value.provider || {}, provider.id)) throw new Error("Provider ID already exists; choose a new ID")
  await assertNoOverlayConflict(configFile, provider.id)
  let keyReference = provider.apiKey
  let keyFile
  if (keyReference && !/^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(keyReference)) {
    keyFile = path.join(path.dirname(options.settingsFile || settingsFile()), "keys", `${provider.id}-${randomUUID()}.key`)
    if (/[{}]/.test(keyFile)) throw new Error("Key file path cannot contain braces")
    await atomicWrite(keyFile, provider.apiKey)
    keyReference = `{file:${keyFile}}`
  }
  let backup
  try {
    if (raw !== null) {
      backup = `${configFile}.${Date.now()}-${randomUUID()}.bak`
      await atomicWrite(backup, raw)
    }
    const next = { ...value, providers: { ...value.providers, [provider.id]: buildProvider(provider, keyReference) } }
    await atomicWrite(configFile, JSON.stringify(next, null, 2) + "\n")
  } catch (e) { if (keyFile) await unlink(keyFile).catch(() => {}); throw e }
  return { id: provider.id, protocol: provider.protocol, models: provider.models, configFile, backup }
}

export async function deleteProvider(id, options = {}) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error("Invalid provider ID")
  const configFile = options.configFile || providerConfigFile()
  if (configFile.endsWith(".jsonc")) throw new Error("JSONC configuration is not modified; choose a strict JSON file")
  const { raw, value } = await readObject(configFile)
  const existing = (value.providers || {})[id]
  if (!existing) throw new Error("Provider not found")
  const settingsPath = options.settingsFile || settingsFile()
  const keysDir = path.join(path.dirname(settingsPath), "keys")
  const ref = existing?.settings?.apiKey
  const match = typeof ref === "string" ? /^\{file:(.+)\}$/.exec(ref) : null
  let backup
  if (raw !== null) {
    backup = `${configFile}.${Date.now()}-${randomUUID()}.bak`
    await atomicWrite(backup, raw)
  }
  const nextProviders = { ...value.providers }
  delete nextProviders[id]
  await atomicWrite(configFile, JSON.stringify({ ...value, providers: nextProviders }, null, 2) + "\n")
  if (match) {
    const keyFile = match[1]
    const resolved = path.resolve(keyFile)
    if (resolved === keyFile && resolved.startsWith(path.resolve(keysDir) + path.sep)) {
      await unlink(resolved).catch(() => {})
    }
  }
  try {
    const current = await loadSettings(settingsPath)
    if (Object.hasOwn(current.providers || {}, id)) {
      const next = { ...current.providers }
      delete next[id]
      await saveSettings({ ...current, providers: next }, settingsPath)
    }
  } catch {}
  return { id, configFile, backup }
}