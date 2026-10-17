import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import mod, { contextSource, historySource, internalSource, variantSource } from "./index.mjs"
import { applyMods } from "../../src/mod-loader.mjs"
import { LOW_EFFORT_GUIDANCE, autoTier, chooseEffort, effortChoices, effortTier, rewriteLowEffort, withAutoEffort } from "./effort-lib.ts"

const tmp = async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "effort-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// --- auto selection -----------------------------------------------------------------------------

test("effortChoices hides the meta selections", () => {
  assert.deepEqual(effortChoices(["low", "medium", "high", "auto", "infinicode"]), ["low", "medium", "high"])
})

test("chooseEffort prefers the id named after the tier", () => {
  const ids = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
  assert.equal(chooseEffort(ids, "hi"), "low")
  assert.equal(chooseEffort(ids, "fix the typo"), "low")
  assert.equal(chooseEffort(ids, "walk me through the session runner"), "medium")
  assert.equal(chooseEffort(ids, "why does the build fail"), "high")
})

test("chooseEffort falls back to the nearest rank, ties to the cheaper variant", () => {
  assert.equal(chooseEffort(["low", "medium", "max"], "why does it crash"), "medium")
  assert.equal(chooseEffort(["low", "max"], "design the schema"), "low")
  assert.equal(chooseEffort(["low", "high", "max"], "debug the parser"), "high")
})

test("chooseEffort handles on/off models, custom ids and no candidates", () => {
  assert.equal(chooseEffort(["none", "thinking"], "hi"), "none")
  assert.equal(chooseEffort(["none", "thinking"], "explain the design"), "thinking")
  assert.equal(chooseEffort(["fast", "slow"], "hello"), "fast")
  assert.equal(chooseEffort(["fast", "slow"], "refactor the module"), "slow")
  assert.equal(chooseEffort([], "hello"), undefined)
  assert.equal(chooseEffort(["auto", "infinicode"], "hello"), undefined)
  assert.equal(chooseEffort(["low"], "why does it break"), "low")
})

test("autoTier only escalates on real signals", () => {
  assert.equal(autoTier(undefined), "medium")
  assert.equal(autoTier("   "), "medium")
  assert.equal(autoTier("hey"), "low")
  assert.equal(autoTier("show me the package.json"), "low")
  assert.equal(autoTier("rename the variable"), "low")
  assert.equal(autoTier("add a settings dialog"), "medium")
  assert.equal(autoTier("why is the build failing?"), "high")
  assert.equal(autoTier("look at ```const x = 1```"), "high")
  assert.equal(autoTier("x".repeat(700)), "high")
  assert.equal(autoTier("Error: cannot find module\n    at foo (/a.js:1:2)"), "high")
  assert.equal(autoTier("a\nb\nc\nd\ne\nf"), "high")
})

test("withAutoEffort adds auto only when there is a choice, and is idempotent", () => {
  const native = [{ id: "low" }, { id: "medium" }]
  assert.deepEqual(withAutoEffort(native).map((v) => v.id), ["low", "medium", "auto"])
  const empty = []
  assert.strictEqual(withAutoEffort(empty), empty)
  assert.deepEqual(withAutoEffort([]), [])
  const once = withAutoEffort(native)
  assert.strictEqual(withAutoEffort(once), once)
  assert.deepEqual(withAutoEffort([{ id: "infinicode" }]).map((v) => v.id), ["infinicode"])
})

test("effortTier only marks the low tiers", () => {
  assert.equal(effortTier(undefined), "standard")
  assert.equal(effortTier("auto"), "standard")
  assert.equal(effortTier("none"), "low")
  assert.equal(effortTier("minimal"), "low")
  assert.equal(effortTier("low"), "low")
  assert.equal(effortTier("medium"), "standard")
  assert.equal(effortTier("xhigh"), "standard")
})

test("rewriteLowEffort swaps the workflow block and drops depth blocks", () => {
  const workflow = "[InfiniteOC unified workflow]\nFollow the phases.\n[End InfiniteOC unified workflow]"
  const deep = "[Deep deliberation]\nDeliberate before acting.\n[End Deep deliberation]"
  const quality = "[Quality tools]\nRun ui_check.\n[End Quality tools]"
  const safety = "[Safety]\nAsk before force-push.\n[End Safety]"
  const entries = [workflow, deep, quality, safety]
  const rendered = entries.join("\n\n")
  const out = rewriteLowEffort(rendered, entries)
  assert.ok(out.includes(LOW_EFFORT_GUIDANCE))
  assert.doesNotMatch(out, /Follow the phases/)
  assert.doesNotMatch(out, /Deep deliberation/)
  assert.doesNotMatch(out, /Quality tools/)
  assert.ok(out.includes(safety))
  assert.ok(!out.includes("\n\n\n"))
  // Unknown guidance is left byte-for-byte.
  assert.equal(rewriteLowEffort("plain guidance", ["plain guidance"]), "plain guidance")
})

// --- ordered application ------------------------------------------------------------------------

const VARIANT = `import { Model } from "./model.js"
import { Provider } from "./provider.js"

export function resolve(model: Model.Info, supports: readonly Support[] = [{ type: "effort" }]): Variants {
  const protocol = model.package === undefined ? undefined : PROTOCOLS[model.package]
  if (!protocol) return []
  const variants = []
  return variants.filter((variant, index) => variants.findIndex((other) => other.id === variant.id) === index)
}
`

const INTERNAL = `import { PlanPlugin } from "./plan.js"
export const plugins = [
  PlanPlugin.Plugin,
  Other.Plugin,
]
`

const CONTEXT = `import { Model } from "../model.js"
export const make = Effect.fn(function* () {
    const resolveModel = (session: SessionSchema.Info) => models.resolve(session, model.available)
    return resolveModel
})
`

const HISTORY = `export const firstUserMessage = Effect.fn("x")(function* () {})
export * as SessionHistory from "./history.js"
`

const write = async (root, file, text) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

const seed = async (root) => {
  await write(root, "packages/core/src/variant.ts", VARIANT)
  await write(root, "packages/core/src/session/history.ts", HISTORY)
  await write(root, "packages/core/src/session/context.ts", CONTEXT)
  await write(root, "packages/core/src/plugin/internal.ts", INTERNAL)
}

test("applies to a pristine tree: files and patches", async (t) => {
  const root = await tmp(t)
  await seed(root)
  const result = await applyMods([mod], root)
  assert.equal(result.changes.length, 7)

  const lib = await readFile(path.join(root, "packages/core/src/infiniteoc/effort-lib.ts"), "utf8")
  assert.ok(lib.includes("export function chooseEffort"))
  const auto = await readFile(path.join(root, "packages/core/src/infiniteoc/auto-effort.ts"), "utf8")
  assert.match(auto, /from "\.\/effort-lib\.js"/)
  const plugin = await readFile(path.join(root, "packages/core/src/plugin/infiniteoc-effort.ts"), "utf8")
  assert.match(plugin, /ctx\.session\.hook\("context"/)

  const variant = await readFile(path.join(root, "packages/core/src/variant.ts"), "utf8")
  assert.match(variant, /import { withAutoEffort } from "\.\/infiniteoc\/effort-lib\.js"/)
  assert.match(variant, /return withAutoEffort\(variants\.filter\(/)
  assert.doesNotMatch(variant, /return withAutoEffort\(withAutoEffort/)

  const history = await readFile(path.join(root, "packages/core/src/session/history.ts"), "utf8")
  assert.match(history, /export const latestUserMessage/)
  assert.match(history, /orderBy\(desc\(SessionMessageTable\.seq\)\)/)
  assert.match(history, /export \* as SessionHistory from "\.\/history\.js"/)

  const context = await readFile(path.join(root, "packages/core/src/session/context.ts"), "utf8")
  assert.match(context, /autoEffort\(session, model\.available, db\)/)
  assert.match(context, /Effect\.flatMap\(\(chosen\) => models\.resolve\(chosen, model\.available\)\)/)

  const internal = await readFile(path.join(root, "packages/core/src/plugin/internal.ts"), "utf8")
  assert.match(internal, /import \* as InfiniteocEffort from "\.\/infiniteoc-effort\.js"/)
  assert.match(internal, /  PlanPlugin\.Plugin,\n  InfiniteocEffort\.Plugin,\n/)
})

test("fails closed: re-applying and missing anchors", async (t) => {
  const root = await tmp(t)
  await seed(root)
  await applyMods([mod], root)
  await assert.rejects(applyMods([mod], root), /already applied/)

  const missing = await tmp(t)
  await seed(missing)
  await write(missing, "packages/core/src/session/context.ts", "nothing here\n")
  await assert.rejects(applyMods([mod], missing), /expected one source anchor: context\.ts/)

  const doubled = await tmp(t)
  await seed(doubled)
  await write(doubled, "packages/core/src/variant.ts", `${VARIANT}\n${VARIANT}`)
  await assert.rejects(applyMods([mod], doubled), /expected one source anchor/)
})

test("source helpers patch their anchors directly", () => {
  assert.match(variantSource(VARIANT), /withAutoEffort/)
  assert.match(historySource(HISTORY), /latestUserMessage/)
  assert.match(contextSource(CONTEXT), /autoEffort/)
  assert.match(internalSource(INTERNAL), /InfiniteocEffort\.Plugin/)
  // The variant list is produced by one expression, so InfiniCode still appends after auto.
  assert.equal(variantSource(VARIANT).match(/withAutoEffort/g).length, 2)
})
