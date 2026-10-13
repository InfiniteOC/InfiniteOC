// InfiniteOC accounts: pure helpers shared by the server plugin (packages/core/src/plugin/infiniteoc-accounts-lib.ts),
// the TUI plugin (packages/tui/src/feature-plugins/system/infiniteoc-accounts-lib.ts) and mods/accounts/test.mjs.
// Accounts are upstream's stored credentials; nothing here ever reads or returns a secret value.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type Account = { readonly id: string; readonly label: string; readonly active: boolean; readonly signIn: boolean }
export type ProviderAccounts = { readonly integrationID: string; readonly name: string; readonly accounts: readonly Account[]; readonly active?: Account }

type Connection = { readonly type: string; readonly id?: string; readonly label?: string; readonly status?: unknown }
type IntegrationLike = { readonly id: string; readonly name: string; readonly connections: readonly Connection[] }

/**
 * Stored accounts per integration. Upstream lists the selected credential first, then environment
 * connections, and uses connections[0] for requests. Only id and label are copied, never values.
 */
export function accountGroups(integrations: readonly IntegrationLike[]): ProviderAccounts[] {
  return integrations
    .flatMap((integration) => {
      const accounts = integration.connections.flatMap((connection, index) =>
        connection.type === "credential" && typeof connection.id === "string"
          ? [{ id: connection.id, label: String(connection.label || connection.id), active: index === 0, signIn: Boolean(connection.status) }]
          : [],
      )
      if (!accounts.length) return []
      return [{ integrationID: integration.id, name: integration.name, accounts, active: accounts.find((account) => account.active) }]
    })
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.integrationID.localeCompare(b.integrationID))
}

/** Upstream resolves a provider's credentials through its integration, which defaults to the provider ID. */
export function integrationFor(providerID: string, providers: readonly { readonly id: string; readonly integrationID?: string }[]) {
  return providers.find((provider) => provider.id === providerID)?.integrationID ?? providerID
}

const FOOTER_MAX = 24
const clip = (text: string, max: number) => (Array.from(text).length > max ? Array.from(text).slice(0, max - 1).join("") + "…" : text)

/** Footer text: only when the provider has several stored accounts, so a single login adds no noise. */
export function footerAccount(group: ProviderAccounts | undefined) {
  if (!group || group.accounts.length < 2 || !group.active) return undefined
  return clip(group.active.label, FOOTER_MAX)
}

/** Row footer in /account: active label and account count. */
export function groupSummary(group: ProviderAccounts) {
  const count = group.accounts.length
  return `${group.active ? group.active.label : "none active"}${count > 1 ? ` · ${count} accounts` : ""}`
}

/** Account names: trimmed, 1-64 characters, no control characters. Returns an error message or the clean name. */
export function validateLabel(input: string | undefined): { label: string } | { error: string } {
  const label = (input ?? "").trim()
  if (!label) return { error: "Name cannot be empty" }
  if (/[\u0000-\u001f\u007f]/.test(label)) return { error: "Name cannot contain control characters" }
  if (Array.from(label).length > 64) return { error: "Name must be at most 64 characters" }
  return { label }
}

/** Find an account by exact ID, else by unique case-insensitive name. */
export function findAccount<T extends { readonly id: string; readonly label: string }>(accounts: readonly T[], target: string): { account: T } | { error: string } {
  const byID = accounts.find((account) => account.id === target)
  if (byID) return { account: byID }
  const matches = accounts.filter((account) => account.label.toLowerCase() === target.trim().toLowerCase())
  if (matches.length === 1) return { account: matches[0] }
  if (matches.length > 1) return { error: `Account name "${target}" is ambiguous; use an ID: ${matches.map((item) => item.id).join(", ")}` }
  return { error: `Account not found: ${target}` }
}

// ---- opt-in fallback ----

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

/** Off unless settings.json has "accounts": { "fallback": true }. */
export const fallbackEnabled = (settings: Record<string, any> | undefined) => settings?.accounts?.fallback === true

/** A copy of the settings with accounts.fallback set; every other key is kept. */
export function withFallback<T extends Record<string, any>>(settings: T, enabled: boolean): T {
  const accounts = settings.accounts && typeof settings.accounts === "object" && !Array.isArray(settings.accounts) ? settings.accounts : {}
  return { ...settings, accounts: { ...accounts, fallback: enabled } }
}

/** Errors where another account of the same provider can help: rate limits and exhausted quota. */
export function isAccountLimit(error: { readonly type?: string; readonly status?: number } | undefined) {
  if (!error) return false
  if (error.type === "provider.rate-limit" || error.type === "provider.quota") return true
  if (error.status === 429) return true
  return /rate.?limit|quota|usage.?limit/i.test(error.type ?? "")
}

export const kindOf = (error: { readonly type?: string }) => (error.type === "provider.quota" ? "quota limit" : "rate limit")

/** Accounts already tried in this session's current failure streak; a quiet window starts a new streak. */
export type Tried = { readonly ids: Set<string>; at: number }
export const TRIED_WINDOW_MS = 10 * 60 * 1000

export function track(state: Map<string, Tried>, sessionID: string, activeID: string, now: number) {
  for (const [key, entry] of state) if (now - entry.at > TRIED_WINDOW_MS) state.delete(key)
  const entry = state.get(sessionID) ?? { ids: new Set<string>(), at: now }
  entry.ids.add(activeID)
  entry.at = now
  state.set(sessionID, entry)
  return entry.ids
}

/** The next stored account after the active one (wrapping), skipping accounts already tried. */
export function nextAccount<T extends { readonly id: string }>(accounts: readonly T[], activeID: string, tried: ReadonlySet<string>): T | undefined {
  const start = accounts.findIndex((account) => account.id === activeID)
  for (let step = 1; step <= accounts.length; step++) {
    const candidate = accounts[(Math.max(start, 0) + step) % accounts.length]
    if (candidate.id !== activeID && !tried.has(candidate.id)) return candidate
  }
  return undefined
}

/** Toast text for an automatic switch: provider and account names only. */
export function fallbackMessage(provider: string, from: string | undefined, to: string, kind: string) {
  return `${provider}: ${from ? `"${from}"` : "the active account"} hit a ${kind}; switched to "${to}" and retrying. /account switches back.`
}
