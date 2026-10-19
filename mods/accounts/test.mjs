import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import module from "node:module"
import infiniteoc from "../infiniteoc/index.mjs"
import provKit from "../prov-kit/index.mjs"
import tstat from "../tstat-status/index.mjs"
import { loadSettings, saveSettings } from "../infiniteoc/settings/settings-store.mjs"
import mod, { replace } from "./index.mjs"

const skip = !module.stripTypeScriptTypes && "needs Node type stripping"
const lib = await import("./accounts-lib.ts").catch(() => ({}))
const here = import.meta.dirname
const SECRETS = ["sk-ant-api03-SECRET", "refresh-SECRET", "access-SECRET", "gho_SECRET"]

// Upstream integration listings as the TUI and CLI receive them; the extra value fields must never pass through.
const integrations = () => [
  {
    id: "anthropic",
    name: "Anthropic",
    connections: [
      { type: "credential", id: "cred_work", label: "work", method: "oauth", value: { access: "access-SECRET", refresh: "refresh-SECRET" } },
      { type: "credential", id: "cred_home", label: "personal", method: "key", key: "sk-ant-api03-SECRET" },
      { type: "env", name: "ANTHROPIC_API_KEY" },
    ],
  },
  { id: "openai", name: "OpenAI", connections: [{ type: "env", name: "OPENAI_API_KEY" }] },
  { id: "github-copilot", name: "GitHub Copilot", connections: [{ type: "credential", id: "cred_gh", label: "GitHub Copilot", status: { url: "https://github.com/login" }, token: "gho_SECRET" }] },
  { id: "xai", name: "xAI", connections: [] },
]

test("accounts are grouped per provider with the first credential active and no secret fields", { skip }, () => {
  const groups = lib.accountGroups(integrations())
  assert.deepEqual(groups.map((group) => group.integrationID), ["anthropic", "github-copilot"]) // env-only and empty are not accounts
  const [anthropic, copilot] = groups
  assert.deepEqual(anthropic.accounts, [
    { id: "cred_work", label: "work", active: true, signIn: false },
    { id: "cred_home", label: "personal", active: false, signIn: false },
  ])
  assert.equal(anthropic.active.label, "work")
  assert.equal(copilot.accounts[0].signIn, true)
  const text = JSON.stringify(groups)
  for (const secret of SECRETS) assert.ok(!text.includes(secret), secret)
})

test("footer and summaries show names only, and only when there is a choice", { skip }, () => {
  const [anthropic, copilot] = lib.accountGroups(integrations())
  assert.equal(lib.footerAccount(anthropic), "work")
  assert.equal(lib.footerAccount(copilot), undefined) // a single login adds no footer noise
  assert.equal(lib.footerAccount(undefined), undefined)
  assert.equal(lib.groupSummary(anthropic), "work · 2 accounts")
  assert.equal(lib.groupSummary(copilot), "GitHub Copilot")
  const long = { ...anthropic, active: { ...anthropic.active, label: "a".repeat(40) } }
  assert.equal(Array.from(lib.footerAccount(long)).length, 24)
  assert.equal(lib.integrationFor("claude-max", [{ id: "claude-max", integrationID: "anthropic" }]), "anthropic")
  assert.equal(lib.integrationFor("openai", [{ id: "anthropic" }]), "openai")
})

test("account names are validated and found by ID or unique name", { skip }, () => {
  assert.deepEqual(lib.validateLabel("  work  "), { label: "work" })
  for (const bad of ["", "   ", undefined, "a\nb", "\u0007", "x".repeat(65)]) assert.ok("error" in lib.validateLabel(bad), JSON.stringify(bad))
  assert.deepEqual(lib.validateLabel("ü".repeat(64)), { label: "ü".repeat(64) })
  const accounts = [{ id: "c1", label: "Work" }, { id: "c2", label: "home" }, { id: "c3", label: "home" }]
  assert.equal(lib.findAccount(accounts, "c2").account.id, "c2")
  assert.equal(lib.findAccount(accounts, "work").account.id, "c1")
  assert.match(lib.findAccount(accounts, "home").error, /ambiguous.*c2, c3/)
  assert.match(lib.findAccount(accounts, "nope").error, /not found/)
})

test("fallback is opt-in and rotates through each other account once per failure streak", { skip }, () => {
  assert.equal(lib.fallbackEnabled({}), false)
  assert.equal(lib.fallbackEnabled({ accounts: { fallback: "yes" } }), false)
  assert.equal(lib.fallbackEnabled({ accounts: { fallback: true } }), true)
  for (const error of [{ type: "provider.rate-limit" }, { type: "provider.quota" }, { type: "x", status: 429 }, { type: "rate_limit_exceeded" }, { type: "insufficient_quota" }])
    assert.ok(lib.isAccountLimit(error), JSON.stringify(error))
  for (const error of [{ type: "provider.auth", status: 401 }, { type: "provider.internal", status: 500 }, { type: "provider.invalid-request", status: 400 }, undefined])
    assert.ok(!lib.isAccountLimit(error), JSON.stringify(error))
  assert.equal(lib.kindOf({ type: "provider.quota" }), "quota limit")
  assert.equal(lib.kindOf({ type: "provider.rate-limit" }), "rate limit")

  const accounts = [{ id: "a" }, { id: "b" }, { id: "c" }]
  const state = new Map()
  let active = "b"
  const order = []
  for (let attempt = 0; attempt < 5; attempt++) {
    const tried = lib.track(state, "ses_1", active, 1000 + attempt)
    const next = lib.nextAccount(accounts, active, tried)
    if (!next) break
    tried.add(next.id)
    order.push(next.id)
    active = next.id
  }
  assert.deepEqual(order, ["c", "a"]) // each other account once, then upstream's own backoff
  // Another session has its own streak; a quiet window starts a new one.
  assert.equal(lib.nextAccount(accounts, "a", lib.track(state, "ses_2", "a", 2000)).id, "b")
  const later = 1000 + lib.TRIED_WINDOW_MS + 10
  assert.equal(lib.nextAccount(accounts, "a", lib.track(state, "ses_1", "a", later)).id, "b")
  assert.equal(lib.nextAccount([{ id: "only" }], "only", new Set(["only"])), undefined)
  assert.equal(lib.nextAccount(accounts, "gone", new Set()).id, "b") // an unknown active ID still yields a candidate
})

test("fallback toast names accounts, never secrets", { skip }, () => {
  const message = lib.fallbackMessage("Anthropic", "work", "personal", "rate limit")
  assert.equal(message, 'Anthropic: "work" hit a rate limit; switched to "personal" and retrying. /account switches back.')
  assert.match(lib.fallbackMessage("OpenAI", undefined, "b", "quota limit"), /the active account hit a quota limit/)
})

test("the opt-in flag is stored in settings.json at mode 600 and keeps every other key", { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accounts-"))
  const file = path.join(dir, "settings.json")
  try {
    assert.equal(lib.fallbackEnabled(lib.readSettings(file)), false) // missing file: off
    await writeFile(file, JSON.stringify({ traffic: { mode: "direct" }, providers: {}, routing: { cheap: "a/b" }, updates: { mode: "off" }, accounts: { note: "kept" } }))
    await saveSettings(lib.withFallback(await loadSettings(file), true), file)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const saved = JSON.parse(await readFile(file, "utf8"))
    assert.deepEqual(saved.accounts, { note: "kept", fallback: true })
    assert.deepEqual(saved.routing, { cheap: "a/b" })
    assert.equal(saved.updates.mode, "off")
    assert.equal(lib.fallbackEnabled(lib.readSettings(file)), true)
    await saveSettings(lib.withFallback(await loadSettings(file), false), file)
    assert.equal(lib.fallbackEnabled(lib.readSettings(file)), false)
    await writeFile(file, "{ not json")
    assert.deepEqual(lib.readSettings(file), {}) // unreadable: fallback stays off
    assert.equal(lib.settingsPath({ INFINITEOC_SETTINGS_FILE: file }), file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("mod sources never read, print or store credential values", async () => {
  const sources = Object.fromEntries(await Promise.all(["tui.tsx", "plugin.ts", "cli-rename.ts", "accounts-lib.ts", "index.mjs", "menu.ts"].map(async (name) => [name, await readFile(path.join(here, name), "utf8")])))
  for (const [name, source] of Object.entries(sources)) {
    // credential.list and auth export return secret values; accounts come from integration listings instead.
    assert.doesNotMatch(source, /credential\.(list|export)\b|\.export\(|auth\.json|opencode\.db|INSERT INTO|UPDATE credential/i, name)
    assert.doesNotMatch(source, /\.value\.(key|access|refresh)|\.(apiKey|accessToken|authToken)\b/, name)
    assert.doesNotMatch(source, /console\.(log|error|warn)/, name)
  }
  // The server plugin reads the stored list but only passes ids and labels on.
  assert.doesNotMatch(sources["plugin.ts"], /\.value\b/)
  assert.match(sources["plugin.ts"], /credentialID: next\.id/)
})

const root = path.resolve(here, "../../.upstream")
function harness() {
  const files = new Map()
  const api = (options, registerOnly = false) => ({
    root,
    options,
    tui: { command() {} },
    on() {},
    async read(file) { return files.get(file) ?? readFile(path.join(root, file), "utf8") },
    async patch(file, transform) { if (!registerOnly) files.set(file, await transform(files.get(file) ?? await readFile(path.join(root, file), "utf8"))) },
    async write(file, content) { if (!registerOnly) files.set(file, content) },
  })
  return { files, api }
}
async function apply(chain) {
  const { files, api } = harness()
  for (const item of chain) await item.setup(api({ reducedMotion: false }))
  return files
}

test("applies after infiniteoc, prov-kit and tstat-status: plugin order, builtin, settings row, CLI", async () => {
  const files = await apply([infiniteoc, provKit, tstat, mod])
  const internal = files.get("packages/core/src/plugin/internal.ts")
  assert.match(internal, /import \{ PlanPlugin \} from "\.\/plan\.js"\nimport \* as InfiniteocAccounts from "\.\/infiniteoc-accounts\.js"/)
  // Before prov-kit so its model fallback sees a rotated event and stands down.
  assert.match(internal, /  PlanPlugin\.Plugin,\n  InfiniteocAccounts\.Plugin,\n  InfiniteocProv\.Plugin,\n  InfiniteocGoal\.Plugin,/)
  assert.match(files.get("packages/core/src/plugin/infiniteoc-prov.ts"), /lib\.failsOver\(event\.error\) \|\| \(event as \{ accountRotated\?: boolean \}\)\.accountRotated\) return/)
  assert.equal(files.get("packages/core/src/plugin/infiniteoc-accounts-lib.ts"), files.get("packages/tui/src/feature-plugins/system/infiniteoc-accounts-lib.ts"))
  assert.match(files.get("packages/core/src/plugin/infiniteoc-accounts.ts"), /from "\.\/infiniteoc-accounts-lib\.js"/)

  const builtins = files.get("packages/tui/src/plugin/builtins.ts")
  assert.match(builtins, /import InfiniteocAccounts from "\.\.\/feature-plugins\/system\/infiniteoc-accounts"/)
  assert.match(builtins, /  Notifications,\n  InfiniteocAccounts,\n  Tstat,\n/)
  const plugin = files.get("packages/tui/src/feature-plugins/system/infiniteoc-accounts.tsx")
  assert.match(plugin, /slash: \{ name: "account", aliases: \["accounts"\] \}/)
  assert.match(plugin, /append: "prompt\.footer\.status"/)
  for (const [, spec] of plugin.matchAll(/from "(\.[^"]+)"/g)) {
    const base = path.posix.join("packages/tui/src/feature-plugins/system", spec)
    const found = [".ts", ".tsx"].some((ext) => files.has(base + ext)) || await Promise.any([".ts", ".tsx"].map((ext) => stat(path.join(root, base + ext)))).then(() => true, () => false)
    assert.ok(found, `import resolves: ${spec}`)
  }

  const settings = files.get("packages/tui/src/component/dialog-infiniteoc.tsx")
  assert.match(settings, /import \{ accountsMenu \} from "\.\.\/feature-plugins\/system\/infiniteoc-accounts-menu"/)
  assert.match(settings, /\{ title: "Accounts", value: "accounts",[^\n]*\n      \{ title: "Updates"/)
  assert.match(settings, /if \(option\.value === "accounts"\) accountsMenu\.open\?\.\(\)/)
  assert.match(files.get("packages/tui/src/component/dialog-config.tsx"), /"api key", "account"\]/)

  const commands = files.get("packages/cli/src/commands/commands.ts")
  assert.match(commands, /Spec\.make\("rename", \{[\s\S]*?name: Argument\.String\("name"\)[\s\S]*?\}\),\n        Spec\.make\("switch", \{/)
  assert.match(commands, /Flag\.String\("method"\)[^\n]*\n            label: Flag\.String\("label"\)/)
  assert.match(files.get("packages/cli/src/index.ts"), /switch: \(\) => import\("\.\/commands\/handlers\/auth\/switch"\),\n    rename: \(\) => import\("\.\/commands\/handlers\/auth\/rename"\),/)
  assert.match(files.get("packages/cli/src/commands/handlers/auth/account.ts"), /action: "log out" \| "switch to" \| "rename",/)
  assert.match(files.get("packages/cli/src/commands/handlers/auth/list.ts"), /index === 0 && integration\.connections\.length > 1 \? ", active" : ""/)
  const login = files.get("packages/cli/src/commands/handlers/auth/login.ts")
  assert.match(login, /authenticate\(client, integration, method, answer, input\.label\)/)
  assert.match(login, /connect\.key\(\{ integrationID: integration\.id, key, answer, label, location \}/)
  assert.match(login, /command\.connect\(\{ integrationID: integration\.id, methodID: method\.id, label, location \}/)
  assert.match(login, /return yield\* oauthLogin\(client, integration, method, answer, label\)/)
  assert.match(files.get("packages/cli/src/commands/handlers/auth/rename.ts"), /Commands\.commands\.auth\.commands\.rename/)
})

test("works without prov-kit and tstat-status", async () => {
  const files = await apply([infiniteoc, mod])
  assert.match(files.get("packages/core/src/plugin/internal.ts"), /  PlanPlugin\.Plugin,\n  InfiniteocAccounts\.Plugin,\n  InfiniteocGoal\.Plugin,/)
  assert.ok(!files.has("packages/core/src/plugin/infiniteoc-prov.ts"))
  assert.match(files.get("packages/tui/src/plugin/builtins.ts"), /  Notifications,\n  InfiniteocAccounts,\n/)
})

test("cached launches register nothing and touch no source", async () => {
  const { files, api } = harness()
  await mod.setup(api({}, true))
  assert.equal(files.size, 0)
})

test("missing or duplicated anchors fail closed", () => {
  assert.throws(() => replace("a", "b", "c"), /expected one source anchor/)
  assert.throws(() => replace("b b", "b", "c"), /expected one source anchor/)
  assert.equal(replace("a b", "b", "$&c"), "a $&c") // replacement text is literal
})

test("without mods/infiniteoc the settings dialog anchor is reported", async () => {
  await assert.rejects(apply([mod]), /accounts: expected one source anchor|ENOENT/)
})

// Upstream v2.0.21 behavior this mod relies on; a new pin must re-check these.
test("pinned upstream: multi-account credential store, live switch, mode 600, separate channel DB", async () => {
  const src = (file) => readFile(path.join(root, file), "utf8")
  const credential = await src("packages/core/src/credential.ts")
  assert.match(credential, /readonly activate: \(id: ID\) => Effect\.Effect<void>/)
  assert.match(credential, /const activate = input\.activate !== false \|\| !current/) // a new login becomes active
  // Requests resolve the active credential each time a model loads, so a switch needs no restart.
  assert.match(await src("packages/core/src/model-resolver.ts"), /const connection = yield\* integrations\.connection\.active\(/)
  assert.match(await src("packages/core/src/provider.ts"), /bus\.subscribe\(\[Integration\.Event\.Updated, Credential\.Event\.Updated, Credential\.Event\.Switched\]\)/)
  const database = await src("packages/core/src/database/database.ts")
  assert.match(database, /openSync\(filename, "a", 0o600\)/)
  assert.match(database, /await chmod\(filename, 0o600\)/)
  // OPENCODE_CHANNEL=infiniteoc (set by the launcher's build) selects opencode-infiniteoc.db, not stock opencode.db.
  assert.match(await src("packages/cli/src/database-path.ts"), /`opencode-\$\{OPENCODE_CHANNEL\.replace/)
  assert.match(await readFile(path.resolve(here, "../../src/launcher.mjs"), "utf8"), /OPENCODE_CHANNEL: "infiniteoc"/)
  // auth.json is only imported, never written.
  assert.match(await src("packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts"), /readFile\(filepath, "utf8"\)/)
  // The retry hook runs for quota errors too (decision retry:false), and SessionError types are stable.
  assert.match(await src("packages/core/src/session/runner/retry.ts"), /yield\* input\.hook\(event\)/)
  // Each retry reloads the session context (and so the model and its active credential).
  assert.match(await src("packages/core/src/session/runner/llm.ts"), /retries refresh context[^\n]*\n\s*const loaded = initial \?\? \(yield\* prepareContext\(sessionID\)\.pipe\(Effect\.flatMap\(context\.load\)\)\)\n\s*initial = undefined/)
  const errors = await src("packages/core/src/session/to-session-error.ts")
  assert.match(errors, /providerError\("provider\.rate-limit"/)
  assert.match(errors, /providerError\("provider\.quota"/)
})
