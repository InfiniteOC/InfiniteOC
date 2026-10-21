import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, cp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import module from "node:module"
import { applyMods, loadMods } from "../src/mod-loader.mjs"
import { builtinSlashNames, closeAllMethod, installTuiFeatures, validateCommand, replaceExact } from "../src/tui-features.mjs"
import { checkFeatures, scaffoldFeature } from "../src/feature-scaffold.mjs"
import { buildLive } from "../src/live-build.mjs"
import clearall from "../mods/clearall/index.mjs"
// Personal mods (src/user-mods.mjs) must never touch the real ~/.config/infiniteoc/mods from a test.
process.env.INFINITEOC_MODS_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "ioc-personal-mods-"))
const personalModsDir = process.env.INFINITEOC_MODS_DIR, { rmSync: removeTree } = await import("node:fs")
process.on("exit", () => removeTree(personalModsDir, { recursive: true, force: true }))

// The injected tab methods and the upstream tab model are TypeScript.
const skip = !(process.features.typescript && module.stripTypeScriptTypes) && "needs Node type stripping"
const { recordClosedSessionTab, reopenSessionTab } = skip ? {} : await import("../.upstream/packages/tui/src/context/session-tabs-model.ts")

const home = new URL("../", import.meta.url).pathname
async function fixture(t, prefix = "", files = []) {
  const root = await mkdtemp(join(tmpdir(), "infiniteoc-tui-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const file of ["app.tsx", "context/session-tabs.tsx", ...files]) {
    await mkdir(join(root, prefix, "packages/tui/src", file, ".."), { recursive: true })
    await cp(join(home, ".upstream/packages/tui/src", file), join(root, prefix, "packages/tui/src", file))
  }
  return root
}
const definition = { id: "hello", title: "Hello", slash: "hello", source: "export function run(ctx: FeatureContext) {}" }
test("typed UI command integration uses frontend registry, not server prompts", async t => {
  const root = await fixture(t)
  const result = await applyMods([clearall], root)
  assert.equal(result.features[0].slash, "clearall")
  const app = await readFile(join(root, "packages/tui/src/app.tsx"), "utf8")
  assert.match(app, /import \{ createDialogApi \} from "\.\/plugin\/api"/)
  assert.match(app, /const infiniteocContext = \{ tabs: sessionTabs, route, dialog, toast, ui: createDialogApi\(dialog, \(render\) => render\(\)\), client \}/)
  // The backend client is declared before the commands are built.
  assert.ok(app.indexOf("const client = useClient()") < app.indexOf("const infiniteocContext"))
  assert.match(app, /createLiveCommands\(infiniteocContext, \(\) => infiniteocCommands\(infiniteocContext\)\)/)
  assert.match(await readFile(join(root, "packages/tui/src/infiniteoc-features/api.ts"), "utf8"), /ui: ReturnType<typeof createDialogApi>/)
  const generated = await readFile(join(root, "packages/tui/src/infiniteoc-features/index.ts"), "utf8")
  assert.match(generated, /name: "infiniteoc\.clearall\.close-all-tabs"/)
  assert.match(generated, /"name":"clearall"/)
  assert.match(generated, /import \{ errorMessage \} from "\.\.\/util\/error"/)
  assert.match(generated, /ctx\.dialog\.clear\(\)\n.*title: "\/clearall failed", message: errorMessage\(error\)/)
  assert.match(generated, /Promise.resolve\(run0\(ctx\)\)\.catch\(failed\)/)
  const handler = await readFile(join(root, "packages/tui/src/infiniteoc-features/clearall--close-all-tabs.tsx"), "utf8")
  assert.match(handler, /await ctx.tabs.closeAll\(\)/)
  assert.doesNotMatch(handler, /\.interrupt\(|\.delete\(|\.prompt\(/)
  const cached = await applyMods([clearall], root, {}, true)
  assert.deepEqual(cached.features, result.features)
  assert.deepEqual(cached.changes, [])
})
test("duplicate slash names/aliases/builtins and command ids fail closed", async t => {
  for (const [id, a, b, error] of [
    ["builtin", { ...definition, slash: "clear" }, undefined, /Duplicate TUI slash/],
    ["same", definition, { ...definition }, /Duplicate TUI command id/],
    ["aliases", definition, { ...definition, id: "second", slash: "second", aliases: ["hello"] }, /Duplicate TUI slash/],
  ]) {
    const root = await fixture(t)
    await assert.rejects(applyMods([{ id, setup(api) { api.tui.command(a); if (b) api.tui.command(b) } }], root), error)
  }
  // Tagged safe: static framework text that the daemon may show in the UI.
  assert.throws(() => validateCommand("mod", { ...definition, slash: "/bad" }), { safe: true })
  assert.throws(() => validateCommand("mod", { ...definition, id: "../escape" }), { safe: true })
  assert.throws(() => validateCommand("mod", { ...definition, source: "not a handler" }), { safe: true })
})
test("slash names declared anywhere in the TUI, plus reserved /live, fail closed for build, check and live", async t => {
  const base = await fixture(t, ".upstream", ["routes/session/index.tsx"])
  const source = join(base, ".upstream/packages/tui/src")
  await writeFile(join(base, "infiniteoc.json"), '{"mods":[],"options":{}}')
  const names = await builtinSlashNames(source)
  for (const name of ["undo", "compact", "resume", "live"]) assert.ok(names.has(name), name)
  const undo = validateCommand("m", { ...definition, slash: "undo" })
  const api = { read: file => readFile(join(base, ".upstream", file), "utf8") }
  await assert.rejects(installTuiFeatures([undo], api, source), /Duplicate TUI slash command: \/undo/)
  await assert.rejects(installTuiFeatures([undo], api), { code: "ERR_INVALID_ARG_TYPE" }) // no silent app.tsx-only fallback
  await assert.rejects(buildLive(base, base, "r1", undefined, [undo]), { message: "Duplicate TUI slash command: /undo", safe: true })
  // A failed compile or a bundle loading a framework copy is named safely; compiler output never is.
  const bun = join(base, ".tools/node_modules/.bin/bun")
  await mkdir(join(bun, ".."), { recursive: true })
  // Exact strings: a safe-tagged message reaches the UI, so any appended compiler output must fail here.
  for (const [script, message] of [
    ["echo SECRET >&2; exit 1", "Cannot compile infiniteoc.m.hello; check its syntax and imports (live handlers are ctx-only; UI components and framework imports belong in a source mod)"],
    [`printf 'import x from "solid-js"' > "$5"`, "Live handlers must use the supplied context, not load another framework instance"],
  ]) {
    await writeFile(bun, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    await assert.rejects(buildLive(base, base, "r2", undefined, [validateCommand("m", definition)]), { message, safe: true })
  }
  await scaffoldFeature(base, "undo")
  await assert.rejects(checkFeatures(base, "undo"), /Duplicate TUI slash command: \/undo/)
})
test("patchExact rejects missing/ambiguous anchors", async t => {
  assert.throws(() => replaceExact("a a", "a", "b"), /expected one/)
  const root = await fixture(t)
  await writeFile(join(root, "anchor.txt"), "original")
  await applyMods([{ id: "exact", setup: api => api.patchExact("anchor.txt", "original", "changed") }], root)
  assert.equal(await readFile(join(root, "anchor.txt"), "utf8"), "changed")
  await assert.rejects(applyMods([{ id: "exact", setup: api => api.patchExact("anchor.txt", "missing", "changed") }], root), /expected one/)
})
test("patchExact inserts the replacement literally, without $ patterns", () => {
  const code = 'text.replace(/[.]/g, "\\\\$&") + "$$" + "$`" + "$\'" + "$1"'
  assert.equal(replaceExact("before ANCHOR after", "ANCHOR", code), `before ${code} after`)
})

// Execute the exact methods injected into the TUI (types stripped) with the real
// upstream tab model and queued storage/route adapters. Testing the old server
// command as text alone missed the UI bug.
function tabHarness(scope = "cwd", enabled = true) {
  const originalTabs = [{ sessionID: "a" }, { sessionID: "b" }, { sessionID: "c" }]
  const persistedSessions = new Map(originalTabs.map(tab => [tab.sessionID, { messages: ["saved"] }]))
  const store = { global: { tabs: [...originalTabs], unread: { a: true } }, cwd: { here: { tabs: [...originalTabs], unread: { a: true } }, other: { tabs: [{ sessionID: "elsewhere" }], unread: {} } } }
  const ctx = {
    enabled: () => enabled,
    state: () => scope === "cwd" ? store.cwd.here : store.global,
    current: () => "b",
    family: id => [id, `${id}-child`],
    cancelledTabs: new Set(), scrollAnchors: new Map([["a", 1]]),
    setExpandedGroups() {}, closed: [], closedTabs: () => ctx.closed, setClosedTabs(fn) { ctx.closed = fn(ctx.closed) },
    recordClosedSessionTab, reopenSessionTab,
    history: { entries: ["a", "b"], index: 1 },
    setPromptPulses(value) { ctx.pulses = value },
    route: { navigate(value) { ctx.navigated = value } },
    config: { tabs: { scope } }, paths: { cwd: "here" }, location: { ref: { directory: "/lab" } },
    empty: () => ({ tabs: [], unread: {} }),
    writes: 0,
    async updateStore(fn) {
      ctx.writes++
      await Promise.resolve()
      assert.equal(ctx.navigated.type, "home")
      // Simulate a queued registration arriving while writes are pending.
      if (!ctx.cancelledTabs.has("b")) ctx.state().tabs.push({ sessionID: "b" })
      ctx.whilePending?.()
      fn(store)
    },
  }
  const names = Object.keys(ctx)
  const methods = new Function(...names, `return ${module.stripTypeScriptTypes(`({${closeAllMethod}})`)}`)(...names.map(name => typeof ctx[name] === "function" ? ctx[name].bind(ctx) : ctx[name]))
  return { method: methods.closeAll, restoreAll: methods.restoreAll, ctx, store, persistedSessions }
}
test("closeAll clears the current scope, navigates home once, preserves saved sessions and prevents queued resurrection", { skip }, async () => {
  for (const scope of ["cwd", "global"]) {
    const { method, ctx, store, persistedSessions } = tabHarness(scope)
    const original = structuredClone([...persistedSessions])
    assert.equal(await method(), 3)
    assert.deepEqual(ctx.state().tabs, [])
    assert.deepEqual(ctx.state().unread, {})
    assert.deepEqual([...persistedSessions], original)
    assert.deepEqual([...ctx.cancelledTabs].sort(), ["a", "b", "c"])
    assert.equal(ctx.closed.length, 3)
    assert.deepEqual(store.cwd.other.tabs, [{ sessionID: "elsewhere" }])
    if (scope === "cwd") assert.equal(store.global.tabs.length, 3)
    else assert.equal(store.cwd.here.tabs.length, 3)
    assert.equal(await method(), 0)
  }
})
test("closeAll records tabs so repeated reopen (ctrl+shift+t) restores the original order", { skip }, async () => {
  const { method, ctx } = tabHarness()
  await method()
  let stack = ctx.closed, tabs = []
  for (let i = 0; i < 3; i++) ({ stack, tabs } = reopenSessionTab(stack, tabs))
  assert.deepEqual(tabs.map(tab => tab.sessionID), ["a", "b", "c"])
})
test("restoreAll undoes closeAll in one write at original positions, skips open tabs, and both no-op when tabs are disabled", { skip }, async () => {
  for (const scope of ["cwd", "global"]) {
    const { method, restoreAll, ctx } = tabHarness(scope)
    await method()
    ctx.state().tabs.push({ sessionID: "c" }) // reopened before Undo
    const writes = ctx.writes
    assert.equal(await restoreAll(["a", "b", "c"], "b"), 2)
    assert.equal(ctx.writes, writes + 1)
    assert.deepEqual(ctx.state().tabs.map(tab => tab.sessionID), ["a", "b", "c"])
    assert.deepEqual([...ctx.cancelledTabs], ["c"])
    assert.deepEqual(ctx.closed.map(entry => entry.tab.sessionID), ["c"])
    assert.deepEqual(ctx.navigated, { type: "session", sessionID: "b" })
  }
  const disabled = tabHarness("cwd", false)
  assert.equal(await disabled.method(), 0)
  assert.equal(await disabled.restoreAll(["a"], "a"), 0)
  assert.equal(disabled.store.cwd.here.tabs.length, 3)
})
test("restoreAll leaves closed a session deleted while its write waits for the lock", { skip }, async () => {
  const { method, restoreAll, ctx } = tabHarness()
  await method()
  // Upstream session.deleted prunes the closed stack; its remove() writes nothing for a closed tab.
  ctx.whilePending = () => ctx.setClosedTabs(entries => entries.filter(entry => entry.tab.sessionID !== "a"))
  assert.equal(await restoreAll(["a", "b"]), 1)
  assert.deepEqual(ctx.state().tabs.map(tab => tab.sessionID), ["b"])
})
test("scaffold creates a working typed example without modifying configuration", async t => {
  const root = await fixture(t)
  const config = '{"mods":[]}'
  await writeFile(join(root, "infiniteoc.json"), config)
  const dir = await scaffoldFeature(root, "hello-ai")
  assert.match(await readFile(join(dir, "command.tsx"), "utf8"), /FeatureContext/)
  const mods = await loadMods([join(dir, "index.mjs")], root)
  const result = await applyMods(mods, root)
  assert.equal(result.features[0].slash, "hello-ai")
  assert.equal(await readFile(join(root, "infiniteoc.json"), "utf8"), config)
  await assert.rejects(scaffoldFeature(root, "hello-ai"), /already exists/)
  await assert.rejects(scaffoldFeature(root, "../bad"), /Feature id/)
})