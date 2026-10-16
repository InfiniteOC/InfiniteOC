// Connectors: wire an app into the agent as an MCP server. Each one becomes mcp.servers.<id> in the OpenCode
// config the launcher uses (the file /settings providers go to). Used by `infiniteoc connect` and by /apps in the
// TUI (mods/connectors writes a copy of this file into the TUI tree with its imports relinked).
// Secrets never enter opencode.json: a typed secret goes to a 0600 key file referenced as {file:...}; a value
// left empty is read from the environment as {env:NAME}. Non-secret values (project IDs, client IDs) are stored
// as typed.
import { randomUUID } from "node:crypto"
import { lstat, readFile, unlink } from "node:fs/promises"
import path from "node:path"
import { atomicWrite, providerConfigFile, readObject, settingsFile } from "../infiniteoc/settings/settings-store.mjs"
import { CATALOG, CATEGORIES } from "./catalog.mjs"

export { CATALOG, CATEGORIES }

const ID = /^[a-z0-9][a-z0-9_-]*$/
const PLATFORMS = { darwin: "macOS" }
export const findConnector = (id) => CATALOG.find((entry) => entry.id === id)
export const defaultKeysDir = () => path.join(path.dirname(settingsFile()), "keys")

/** The mcp.servers entry for a catalog item; `refs` maps each variable to {env:..}, {file:..} or a literal. */
export function serverEntry(entry, refs = {}) {
  const vars = entry.vars ?? []
  if (entry.kind === "local") {
    const environment = Object.fromEntries(vars.filter((item) => !item.arg && refs[item.name] !== undefined).map((item) => [item.name, refs[item.name]]))
    const args = vars.filter((item) => item.arg && refs[item.name] !== undefined).map((item) => refs[item.name])
    return { type: "local", command: [...entry.command, ...args], ...(Object.keys(environment).length ? { environment } : {}) }
  }
  const token = vars[0] && refs[vars[0].name]
  return {
    type: "remote",
    url: entry.url,
    ...(entry.protocol ? { protocol: entry.protocol } : {}),
    ...(entry.auth === "token" ? { headers: { [entry.header ?? "Authorization"]: entry.header ? token : `Bearer ${token}` }, oauth: false } : {}),
    ...(entry.auth === "none" ? { oauth: false } : {}),
  }
}

/**
 * {env:NAME} and {file:path} replaced by their values, as OpenCode does when it loads the config file.
 * The TUI needs it to connect a server at runtime (that API takes a ready config, not the file's references).
 */
export async function resolve(value, env = process.env) {
  if (typeof value === "string") {
    const file = /^\{file:([^}]+)\}$/.exec(value)?.[1]
    if (file) return (await readFile(file, "utf8")).trim()
    let out = value
    for (const match of value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) out = out.replace(match[0], env[match[1]] ?? "")
    for (const match of value.matchAll(/\{file:([^}]+)\}/g)) out = out.replace(match[0], (await readFile(match[1], "utf8")).trim())
    return out
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolve(item, env)))
  if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolve(item, env)])))
  return value
}

/** Reads mcp.servers from the config file (a missing file is empty). */
export async function configuredServers(configFile = providerConfigFile()) {
  const { value } = await readObject(configFile)
  return value.mcp?.servers ?? {}
}

/** Required variables a configured server reads from the environment that are not set there. */
const missingVars = (entry, server, env) =>
  (entry.vars ?? []).filter((item) => !item.optional && JSON.stringify(server).includes(`{env:${item.name}}`) && !env[item.name]).map((item) => item.name)

/** Catalog rows with their state in this config and environment. */
export async function connectorStatus({ configFile = providerConfigFile(), env = process.env, platform = process.platform } = {}) {
  const servers = await configuredServers(configFile)
  return CATALOG.map((entry) => {
    const server = servers[entry.id]
    return {
      ...entry,
      connected: Boolean(server),
      disabled: server?.disabled === true,
      missing: server ? missingVars(entry, server, env) : [],
      unsupported: entry.platform && entry.platform !== platform ? `${PLATFORMS[entry.platform] ?? entry.platform} only` : undefined,
    }
  })
}

async function writeServers(configFile, update) {
  if (configFile.endsWith(".jsonc")) throw new Error("JSONC configuration is not modified; use a strict JSON opencode.json")
  try { await lstat(`${configFile}c`); throw new Error(`${configFile}c exists and would override this file; convert it to strict JSON first`) } catch (error) { if (error.code !== "ENOENT") throw error }
  const { raw, value } = await readObject(configFile)
  if (value.mcp !== undefined && (typeof value.mcp !== "object" || Array.isArray(value.mcp))) throw new Error("mcp in the OpenCode config must be an object")
  const servers = { ...value.mcp?.servers }
  update(servers)
  const backup = raw === null ? undefined : `${configFile}.${Date.now()}-${randomUUID().slice(0, 8)}.bak`
  if (backup) await atomicWrite(backup, raw)
  await atomicWrite(configFile, JSON.stringify({ ...value, mcp: { ...value.mcp, servers } }, null, 2) + "\n")
  return backup
}

/**
 * Adds a catalog connector as mcp.servers.<id>. `values` holds what the user typed per variable: secrets go to
 * key files, the rest is stored as typed; required variables left out read {env:NAME}, optional ones are
 * omitted. Refuses to replace an existing server unless `force`. Returns { id, configFile, backup, keyFiles,
 * server, next } where `next` lists what the user still has to do.
 */
export async function connect(id, { configFile = providerConfigFile(), keysDir = defaultKeysDir(), values = {}, force = false, env = process.env, platform = process.platform } = {}) {
  const entry = findConnector(id)
  if (!entry) throw new Error(`Unknown connector "${id}". Run infiniteoc connect (or /apps) to list them.`)
  const refs = {}
  const keyFiles = []
  try {
    for (const item of entry.vars ?? []) {
      const typed = typeof values[item.name] === "string" ? values[item.name].trim() : ""
      if (/[\r\n\0]/.test(typed)) throw new Error(`Invalid value for ${item.name}`)
      if (typed && item.secret) {
        const keyFile = path.join(keysDir, `mcp-${entry.id}-${randomUUID()}.key`)
        if (/[{}]/.test(keyFile)) throw new Error("Key file path cannot contain braces")
        await atomicWrite(keyFile, typed)
        keyFiles.push(keyFile)
        refs[item.name] = `{file:${keyFile}}`
      } else if (typed) {
        if (/[{}]/.test(typed)) throw new Error(`${item.name} cannot contain { or }`)
        refs[item.name] = typed
      } else if (!item.optional) refs[item.name] = `{env:${item.name}}`
    }
    const server = serverEntry(entry, refs)
    const backup = await writeServers(configFile, (servers) => {
      if (Object.hasOwn(servers, id) && !force) throw new Error(`${id} is already configured in ${configFile}; replace it with --force (or remove it first)`)
      servers[id] = server
    })
    const next = []
    if (entry.platform && entry.platform !== platform) next.push(`${entry.name} runs on ${PLATFORMS[entry.platform] ?? entry.platform} only; this config is used there`)
    for (const item of entry.vars ?? []) if (refs[item.name] === `{env:${item.name}}` && !env[item.name]) next.push(`Set ${item.name} (${item.help})`)
    if (entry.setup) next.push(entry.setup)
    if (entry.auth === "oauth") next.push(`Sign in once: infiniteoc mcp auth ${id} (or select it in /apps)`)
    if (entry.needs) next.push(`Needs ${entry.needs} on PATH when OpenCode starts it`)
    return { id, configFile, backup, keyFiles, server, next }
  } catch (error) {
    await Promise.all(keyFiles.map((file) => unlink(file).catch(() => {})))
    throw error
  }
}

/** Removes mcp.servers.<id> (any server, catalog or not) and the key files this command stored for it. */
export async function disconnect(id, { configFile = providerConfigFile(), keysDir = defaultKeysDir() } = {}) {
  if (!ID.test(id)) throw new Error("Invalid connector id")
  let removed
  const backup = await writeServers(configFile, (servers) => {
    if (!Object.hasOwn(servers, id)) throw new Error(`${id} is not configured in ${configFile}`)
    removed = servers[id]
    delete servers[id]
  })
  // Only key files this command created (inside the keys directory, named for this connector) are deleted.
  for (const match of JSON.stringify(removed).matchAll(/\{file:([^}]+)\}/g)) {
    const ref = match[1].replaceAll("\\\\", "\\")
    if (path.dirname(ref) === keysDir && path.basename(ref).startsWith(`mcp-${id}-`)) await unlink(ref).catch(() => {})
  }
  return { id, configFile, backup }
}

/** The list `infiniteoc connect` prints. */
export function formatStatus(rows) {
  const lines = []
  for (const category of CATEGORIES) {
    const members = rows.filter((item) => item.category === category)
    if (!members.length) continue
    lines.push(category)
    for (const row of members) {
      const state = row.connected ? (row.disabled ? "disabled" : row.missing.length ? `needs ${row.missing.join(", ")}` : "connected") : row.unsupported ?? ""
      lines.push(`  ${row.connected ? "●" : "○"} ${row.id.padEnd(24)} ${row.name.padEnd(28)} ${row.description}${state ? `  [${state}]` : ""}`)
    }
    lines.push("")
  }
  lines.push("infiniteoc connect ID [--ask] [--force]   add one (--ask prompts for its values)   infiniteoc disconnect ID")
  lines.push("Inside InfiniteOC: /apps adds, signs in and removes them without a restart.")
  return lines.join("\n")
}
