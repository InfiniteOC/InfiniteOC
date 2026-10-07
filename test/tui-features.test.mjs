import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, cp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyMods, loadMods } from "../src/mod-loader.mjs"
import { closeAllMethod, validateCommand, replaceExact } from "../src/tui-features.mjs"
import { scaffoldFeature } from "../src/feature-scaffold.mjs"
import clearall from "../mods/clearall/index.mjs"

const home = new URL("../", import.meta.url).pathname
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "infiniteoc-tui-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const file of ["app.tsx", "context/session-tabs.tsx"]) {
    await mkdir(join(root, "packages/tui/src", file, ".."), { recursive: true })
    await cp(join(home, ".upstream/packages/tui/src", file), join(root, "packages/tui/src", file))
  }
  return root
}
const definition = { id: "hello", title: "Hello", slash: "hello", source: "export function run(ctx: FeatureContext) {}" }
test("typed UI command integration uses frontend registry, not server prompts", async t => {
  const root = await fixture(t)
  const result = await applyMods([clearall], root)
  assert.equal(result.features[0].slash, "clearall")
  const app = await readFile(join(root, "packages/tui/src/app.tsx"), "utf8")
  assert.match(app, /createLiveCommands\(\{ tabs: sessionTabs, route, dialog, toast \}/)
  const generated = await readFile(join(root, "packages/tui/src/infiniteoc-features/index.ts"), "utf8")
  assert.match(generated, /"name":"clearall"/)
  assert.match(generated, /Promise.resolve/)
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
  assert.throws(() => validateCommand("mod", { ...definition, slash: "/bad" }))
  assert.throws(() => validateCommand("mod", { ...definition, id: "../escape" }))
  assert.throws(() => validateCommand("mod", { ...definition, source: "not a handler" }))
})
test("patchExact rejects missing/ambiguous anchors", async t => {
  assert.throws(() => replaceExact("a a", "a", "b"), /expected one/)
  const root = await fixture(t)
  await writeFile(join(root, "anchor.txt"), "original")
  await applyMods([{ id: "exact", setup: api => api.patchExact("anchor.txt", "original", "changed") }], root)
  assert.equal(await readFile(join(root, "anchor.txt"), "utf8"), "changed")
  await assert.rejects(applyMods([{ id: "exact", setup: api => api.patchExact("anchor.txt", "missing", "changed") }], root), /expected one/)
})

// Execute the exact method injected into the TUI with queued storage/route
// adapters. Testing the old server command as text alone missed the UI bug.
function tabHarness(scope = "cwd") {
  const originalTabs = [{ sessionID: "a" }, { sessionID: "b" }, { sessionID: "c" }]
  const persistedSessions = new Map(originalTabs.map(tab => [tab.sessionID, { messages: ["saved"] }]))
  const store = { global: { tabs: [...originalTabs], unread: { a: true } }, cwd: { here: { tabs: [...originalTabs], unread: { a: true } }, other: { tabs: [{ sessionID: "elsewhere" }], unread: {} } } }
  const ctx = {
    state: () => scope === "cwd" ? store.cwd.here : store.global,
    current: () => "b",
    family: id => [id, `${id}-child`],
    cancelledTabs: new Set(), scrollAnchors: new Map([["a", 1]]),
    setExpandedGroups() {}, closed: [], setClosedTabs(fn) { ctx.closed = fn(ctx.closed) },
    recordClosedSessionTab: (stack, tab, index) => [...stack, { tab, index }],
    history: { entries: ["a", "b"], index: 1 },
    setPromptPulses(value) { ctx.pulses = value },
    route: { navigate(value) { ctx.navigated = value } },
    config: { tabs: { scope } }, paths: { cwd: "here" }, location: { ref: { directory: "/lab" } },
    empty: () => ({ tabs: [], unread: {} }),
    async updateStore(fn) {
      await Promise.resolve()
      assert.equal(ctx.navigated.type, "home")
      // Simulate a queued registration arriving while writes are pending.
      if (!ctx.cancelledTabs.has("b")) ctx.state().tabs.push({ sessionID: "b" })
      fn(store)
    },
  }
  const names = Object.keys(ctx)
  const method = new Function(...names, `return ({${closeAllMethod}}).closeAll`)(...names.map(name => typeof ctx[name] === "function" ? ctx[name].bind(ctx) : ctx[name]))
  return { method, ctx, store, persistedSessions }
}
test("closeAll clears the current scope, navigates home once, preserves saved sessions and prevents queued resurrection", async () => {
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