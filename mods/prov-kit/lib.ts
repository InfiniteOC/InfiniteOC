// Pure helpers for mods/prov-kit. Copied next to the server plugin and the TUI commands, so this file
// has no imports beyond node: built-ins and uses only erasable TypeScript (tests load it directly).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import path from "node:path"

// ---- settings.json (shared with the launcher; unknown keys are always preserved) ----

export const settingsPath = (env: Record<string, string | undefined> = process.env) =>
  env.INFINITEOC_SETTINGS_FILE || path.join(homedir(), ".config/infiniteoc/settings.json")

export function readSettings(file = settingsPath()): Record<string, any> {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"))
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export const MODEL_KEYS = ["cheap", "strong", "fallback", "local"] as const
export type ModelKey = (typeof MODEL_KEYS)[number]
// Where each key lives in settings.json.
const SECTION: Record<ModelKey, [string, string]> = {
  cheap: ["routing", "cheap"],
  strong: ["routing", "strong"],
  fallback: ["fallback", "model"],
  local: ["local", "model"],
}

export const configuredModel = (settings: Record<string, any>, key: ModelKey): string | undefined => {
  const [section, field] = SECTION[key]
  const value = settings?.[section]?.[field]
  return typeof value === "string" && isModelRef(value) ? value : undefined
}

export const isModelRef = (text: string) => /^[^/#\s]+\/[^#\s]+(#[^#\s]+)?$/.test(text)

/** Sets or clears one model key. A settings file that is not strict JSON is never overwritten. */
export function writeModelSetting(key: ModelKey, value: string | undefined, file = settingsPath()) {
  let raw: string | undefined
  try {
    raw = readFileSync(file, "utf8")
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw new Error("Unable to read the settings file")
  }
  let settings: Record<string, any> = {}
  if (raw !== undefined) {
    try {
      settings = JSON.parse(raw)
    } catch {
      throw new Error("The settings file is not strict JSON; not modifying it")
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("The settings file root must be an object")
  }
  const [section, field] = SECTION[key]
  const next = { ...(settings[section] ?? {}) }
  if (value === undefined) delete next[field]
  else next[field] = value
  settings[section] = next
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, file)
}

// ---- /budget ----

export const BUDGET = "[InfiniteOC budget]"

/** "5", "$5", "2.50" -> dollars; undefined when it is not a positive amount. */
export function parseAmount(text: string): number | undefined {
  const match = /^\$?\s*(\d+(?:\.\d+)?)$/.exec(text.trim())
  const amount = match ? Number(match[1]) : NaN
  return Number.isFinite(amount) && amount > 0 ? amount : undefined
}

export const money = (value: number) => `$${value.toFixed(value < 1 ? 3 : 2)}`

export const budgetNote = (limit: number | undefined) =>
  `${BUDGET}\nLimit: ${limit === undefined ? "off" : limit.toFixed(2)}\n\n${limit === undefined ? "Session spending limit removed." : `Session spending limit set to ${money(limit)}. Tool calls are refused once it is reached.`}`

type Msg = { type: string; text?: string }

/** The limit from the most recent budget note in a transcript; undefined when none or switched off. */
export function budgetLimit(messages: ReadonlyArray<Msg>): number | undefined {
  for (const message of messages.toReversed()) {
    if ((message.type !== "user" && message.type !== "synthetic") || !message.text?.startsWith(BUDGET)) continue
    const value = /^Limit: (\S+)$/m.exec(message.text)?.[1]
    return value && value !== "off" && Number(value) > 0 ? Number(value) : undefined
  }
  return undefined
}

export const overBudget = (limit: number | undefined, spent: number) => limit !== undefined && spent >= limit

export const budgetRefusal = (limit: number, spent: number) =>
  `Refused: this session's spending limit ${money(limit)} is reached (${money(spent)} spent). Do not call more tools. ` +
  `Summarize what is done and what remains, then stop. The user can raise the limit with /budget <amount> or remove it with /budget off.`

/** True when the transcript's last /goal control note is not a stop or finish. */
export function goalActive(messages: ReadonlyArray<Msg>): boolean {
  for (const message of messages.toReversed()) {
    if ((message.type !== "user" && message.type !== "synthetic") || !message.text?.startsWith("[InfiniteOC goal")) continue
    return !message.text.startsWith("[InfiniteOC goal: stopped]") && !message.text.startsWith("[InfiniteOC goal: finished]")
  }
  return false
}

export const stopGoalNote = (limit: number, spent: number) =>
  `[InfiniteOC goal: stopped]\nGoal paused: the session budget ${money(limit)} is reached (${money(spent)} spent). Raise it with /budget <amount>, then run /goal again.`

// ---- fallback ----

/** Rate limits and server errors; other errors (auth, bad request) would fail on the backup too. */
export const failsOver = (error: { status?: number; type?: string }) =>
  error.status === 429 || (error.status !== undefined && error.status >= 500) || /rate.?limit|overload|unavailable|internal/i.test(error.type ?? "")

// ---- network and power ----

type Interfaces = Record<string, Array<{ address: string; internal: boolean; family: string | number }> | undefined>

/** No non-loopback, non-link-local address on any interface. Sends no traffic. */
export function offline(interfaces: Interfaces, env: Record<string, string | undefined> = process.env): boolean {
  if (env.INFINITEOC_OFFLINE === "1") return true
  if (env.INFINITEOC_OFFLINE === "0") return false
  return !Object.values(interfaces).some((list) =>
    (list ?? []).some((item) => !item.internal && !/^(169\.254\.|fe80:)/i.test(item.address)),
  )
}

/** pmset -g batt output: on battery, not AC. */
export const onBattery = (pmset: string) => /drawing from 'Battery Power'/.test(pmset)

// ---- free port, env diff, docker ----

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))))
    })
  })
}

/** Variable names declared in a dotenv file: KEY=..., optionally `export KEY=`; comments and blanks skipped. */
export function envKeys(text: string): Map<string, boolean> {
  const keys = new Map<string, boolean>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/.exec(line)
    if (match) keys.set(match[1], match[2].trim().replace(/^(['"])(.*)\1$/, "$2") !== "")
  }
  return keys
}

export type EnvDiff = { missing: string[]; empty: string[]; extra: string[] }

/** Names only. A key counts as empty when .env sets it to nothing; values are never kept. */
export function envDiff(example: string, env: string): EnvDiff {
  const want = envKeys(example)
  const have = envKeys(env)
  return {
    missing: [...want.keys()].filter((key) => !have.has(key)),
    empty: [...want.keys()].filter((key) => have.get(key) === false && want.get(key) !== false),
    extra: [...have.keys()].filter((key) => !want.has(key)),
  }
}

export function formatEnvDiff(diff: EnvDiff, files: { example: string; env: string }) {
  const list = (title: string, keys: string[]) => (keys.length ? [`${title} (${keys.length}): ${keys.join(", ")}`] : [])
  const lines = [...list("Missing from " + files.env, diff.missing), ...list("Empty in " + files.env + " but set in " + files.example, diff.empty), ...list("Only in " + files.env, diff.extra)]
  return lines.length ? lines.join("\n") : `${files.env} has every key from ${files.example}.`
}

export type ComposeService = { service: string; name: string; state: string }

/** `docker compose ps --format json`: one JSON object per line (newer) or one array (older). */
export function composeServices(output: string): ComposeService[] {
  const text = output.trim()
  if (!text) return []
  let rows: any[]
  try {
    const parsed = JSON.parse(text)
    rows = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    rows = text.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  }
  return rows
    .filter((row) => row && typeof row.Service === "string")
    .map((row) => ({ service: row.Service, name: String(row.Name ?? row.Service), state: String(row.State ?? "") }))
}

export const dockerNote = (services: ComposeService[]) => {
  const running = services.filter((item) => item.state === "running")
  return running.length
    ? `Docker Compose services are running for this project: ${running.map((item) => item.service).join(", ")}. ` +
        `If a command needs a service's environment (database, runtime, installed tools), offer to run it inside with \`docker compose exec <service> <command>\` instead of on the host, and ask before doing so.`
    : undefined
}

// ---- /usage ----

export type UsageRow = { day: string; project: string; provider: string; cost: number }
export type Usage = { total: number; days: [string, number][]; projects: [string, number][]; providers: [string, number][] }

const rank = (totals: Map<string, number>, limit: number) =>
  [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)

export function aggregateUsage(rows: UsageRow[], dayLimit = 14, topLimit = 8): Usage {
  const days = new Map<string, number>()
  const projects = new Map<string, number>()
  const providers = new Map<string, number>()
  let total = 0
  for (const row of rows) {
    if (!(row.cost > 0)) continue
    total += row.cost
    days.set(row.day, (days.get(row.day) ?? 0) + row.cost)
    projects.set(row.project, (projects.get(row.project) ?? 0) + row.cost)
    providers.set(row.provider, (providers.get(row.provider) ?? 0) + row.cost)
  }
  return {
    total,
    days: [...days].sort((a, b) => b[0].localeCompare(a[0])).slice(0, dayLimit),
    projects: rank(projects, topLimit),
    providers: rank(providers, topLimit),
  }
}

export function formatUsage(usage: Usage, home = homedir()): string {
  if (usage.total === 0) return "No priced usage recorded yet. Models without a configured price report a cost of zero."
  const width = Math.max(...[...usage.days, ...usage.projects, ...usage.providers].map(([, value]) => money(value).length))
  const table = (title: string, rows: [string, number][], label = (key: string) => key) =>
    [title, ...rows.map(([key, value]) => `  ${money(value).padStart(width)}  ${label(key)}`)].join("\n")
  const short = (dir: string) => (home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir)
  return [`Total ${money(usage.total)}`, table("By day", usage.days), table("By project", usage.projects, short), table("By provider", usage.providers)].join("\n\n")
}

// ---- local runtimes ----

export type LocalRuntime = { id: string; name: string; baseURL: string; models: string[] }

/** Ollama /api/tags and LM Studio /v1/models payloads. Embedding-only models are skipped. */
export function parseLocalModels(kind: "ollama" | "lmstudio", payload: any): string[] {
  const rows: any[] = kind === "ollama" ? payload?.models : payload?.data
  if (!Array.isArray(rows)) return []
  const ids = rows
    .map((row) => (kind === "ollama" ? row?.name : row?.id))
    .filter((id): id is string => typeof id === "string" && id !== "" && !/embed/i.test(id))
  return [...new Set(ids)]
}
