// Crash-guard preflight: pure logic plus small IO helpers for the beforeLaunch hook.
//
// Root cause it fixes: upstream ConfigVariable.substitute fails Config.load with
// ConfigInvalidError when any {file:...} token points at a missing file, and
// Config.load wraps file loads in Effect.orDie. Every API endpoint then answers
// 500 and `serve --stdio` exits with `UnexpectedStatus: 500`, so the backend
// crash-loops on any device whose opencode.json references key files that are
// not there (second device, synced dotfiles, deleted keys dir, shared config).
// {env:...} never crashes (missing vars substitute to ""), so only {file:} is handled.
//
// Strategy: quarantine (backup, then drop) exactly the providers/MCP servers
// whose subtree contains a missing {file:} ref, so the server boots. Anything
// else (unparseable JSONC, refs outside provider/server subtrees) is warn-only:
// the hook never blocks a launch and never prints secrets, only paths.
import { access, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const FILE_TOKEN = /\{file:[^}]+\}/g

/** All {file:...} tokens in a string. */
export function fileTokens(text) {
  if (typeof text !== "string") return []
  return text.match(FILE_TOKEN) ?? []
}

/**
 * Resolve a {file:...} token exactly like upstream config/variable.ts:
 * ~/ expands against the home dir, absolute stays, relative resolves against
 * the config file's directory.
 */
export function resolveFileRef(token, configDir, homeDir = homedir()) {
  const inner = token.slice("{file:".length, -1)
  const expanded = inner.startsWith("~/") ? path.join(homeDir, inner.slice(2)) : inner
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded)
}

/** Walk a parsed config, collecting { token, jsonPath } for every string value holding file tokens. */
export function collectRefs(value, jsonPath = []) {
  const found = []
  if (typeof value === "string") {
    for (const token of fileTokens(value)) found.push({ token, jsonPath })
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...collectRefs(item, [...jsonPath, String(index)])))
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) found.push(...collectRefs(item, [...jsonPath, key]))
  }
  return found
}

const atPath = (config, jsonPath) => jsonPath.reduce((node, key) => node?.[key], config)

/**
 * Decide what to quarantine. Returns { missing, dropProviders, dropServers,
 * unfixable, next } where next is the pruned config (original untouched).
 * exists(resolvedPath) is an injected async predicate for testability.
 */
export async function planRepair(config, { configDir, homeDir = homedir(), exists }) {
  const refs = collectRefs(config)
  const missing = []
  for (const { token, jsonPath } of refs) {
    const resolved = resolveFileRef(token, configDir, homeDir)
    if (!await exists(resolved)) missing.push({ token, resolved, jsonPath })
  }
  const dropProviders = new Set()
  const dropServers = new Set()
  const unfixable = []
  for (const item of missing) {
    const [head, id] = item.jsonPath
    if (head === "providers" && typeof id === "string") dropProviders.add(id)
    else if (head === "mcp" && typeof id === "string") {
      // Modern shape: mcp.servers.<name>. Legacy shape: mcp.<name> with a command array.
      if (id === "servers" && typeof item.jsonPath[2] === "string") dropServers.add(`servers.${item.jsonPath[2]}`)
      else if (id !== "servers") dropServers.add(id)
      else unfixable.push(item)
    } else unfixable.push(item)
  }
  const next = JSON.parse(JSON.stringify(config))
  for (const id of dropProviders) delete next.providers?.[id]
  for (const name of dropServers) {
    if (name.startsWith("servers.")) delete next.mcp?.servers?.[name.slice("servers.".length)]
    else delete next.mcp?.[name]
  }
  return { missing, dropProviders: [...dropProviders], dropServers: [...dropServers], unfixable, next }
}

/** Tokens in raw text, skipping full-line // comments like upstream does. */
export function scanTextRefs(text) {
  const found = []
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("//")) continue
    found.push(...fileTokens(line))
  }
  return [...new Set(found)]
}

const defaultExists = (file) => access(file).then(() => true, () => false)

/**
 * Preflight one config file. Never throws for config problems: returns a
 * result the hook turns into a backup + rewrite + notice, or a warn-only notice.
 * { changed, droppedProviders, dropServers, backup, warning }
 */
export async function preflightFile(configFile, { homeDir = homedir(), exists = defaultExists } = {}) {
  let raw
  try {
    raw = await readFile(configFile, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return { changed: false }
    return { changed: false, warning: `crash-guard could not read ${configFile}` }
  }
  const configDir = path.dirname(configFile)
  let config
  try {
    config = JSON.parse(raw)
  } catch {
    // Strict JSON is required for a safe rewrite (same rule as the settings
    // store: JSONC is never modified). Scan and warn only.
    const missing = []
    for (const token of scanTextRefs(raw)) {
      const resolved = resolveFileRef(token, configDir, homeDir)
      if (!await exists(resolved)) missing.push(resolved)
    }
    if (!missing.length) return { changed: false }
    return { changed: false, warning: `crash-guard: ${path.basename(configFile)} has ${missing.length} missing file reference(s) and is not strict JSON, so it was left alone (fix or convert it before the backend can start)` }
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) return { changed: false }
  const plan = await planRepair(config, { configDir, homeDir, exists })
  if (!plan.missing.length) return { changed: false }
  if (plan.unfixable.length || (!plan.dropProviders.length && !plan.dropServers.length)) {
    return { changed: false, warning: `crash-guard: ${plan.missing.length} missing file reference(s) outside providers/MCP servers in ${path.basename(configFile)}; remove them before the backend can start` }
  }
  if (configFile.endsWith(".jsonc")) {
    return { changed: false, warning: `crash-guard: ${path.basename(configFile)} has dangling references but JSONC is never rewritten; convert it to strict JSON or fix the paths` }
  }
  const backup = `${configFile}.${Date.now()}-crash-guard.bak`
  await writeFile(backup, raw, { mode: 0o600 })
  await writeFile(configFile, `${JSON.stringify(plan.next, null, 2)}\n`)
  const parts = [
    ...plan.dropProviders.map((id) => `provider ${id}`),
    ...plan.dropServers.map((name) => `mcp ${name}`),
  ]
  return {
    changed: true,
    droppedProviders: plan.dropProviders,
    dropServers: plan.dropServers,
    backup,
    warning: `crash-guard quarantined ${parts.join(", ")} (dangling file reference; backup ${path.basename(backup)})`,
  }
}

/** Config files upstream actually loads from the global dir. */
export function candidateFiles(env = process.env) {
  const explicit = env.OPENCODE_CONFIG
  if (explicit) return [explicit]
  const dir = env.XDG_CONFIG_HOME || path.join(homeDir(env), ".config")
  return [path.join(dir, "opencode", "opencode.json"), path.join(dir, "opencode", "opencode.jsonc")]
}

const homeDir = (env) => env.HOME || homedir()
