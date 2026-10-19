import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import mod, { contextSource, historySource, internalSource, variantSource } from "./index.mjs"
import { applyMods } from "../../src/mod-loader.mjs"
import { LOW_EFFORT_GUIDANCE, autoDecision, autoTier, lowEffortTurnNote, variantFor, chooseEffort, effortChoices, effortTier, rewriteLowEffort, turnSignals, variantTier, withAutoEffort } from "./effort-lib.ts"

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
  assert.equal(autoTier("Error: cannot find module\n    at foo (/a.js:1:2)"), "high")
  // Size alone is weak evidence: a long or many-line prompt is medium until it is very long.
  assert.equal(autoTier("x".repeat(700)), "medium")
  assert.equal(autoTier("x".repeat(1600)), "high")
  assert.equal(autoTier("a\nb\nc\nd\ne\nf"), "medium")
  // Several separate tasks in one prompt are real work.
  assert.equal(autoTier("- add the button\n- wire it up\n- test it"), "high")
})

test("autoTier follows what the user says about effort", () => {
  assert.equal(autoTier("quickly, what does refactor mean here"), "medium")
  assert.equal(autoTier("explain the parser carefully, with edge cases"), "high")
  assert.equal(autoTier("ultrathink: how should sessions sync across devices"), "max")
  assert.equal(autoTier("think harder about it"), "max")
  assert.equal(autoTier("thanks!"), "low")
  assert.equal(autoTier('"show me the config"'), "low", "wrapping quotes are not part of the ask")
  assert.equal(autoTier("`yes`"), "medium")
})

test("a go-ahead keeps the previous turn's effort instead of dropping to low", () => {
  assert.equal(autoTier({ text: "yes", previousVariant: "high" }), "high")
  assert.equal(autoTier({ text: "continue", previousVariant: "xhigh" }), "max")
  assert.equal(autoTier({ text: "go ahead", previousVariant: "low" }), "low")
  // No effort recorded: the previous prompt decides.
  assert.equal(autoTier({ text: "ok", previousText: "debug the race condition in the scheduler" }), "high")
  assert.equal(autoTier({ text: "ok" }), "medium")
  // A retry after a failing turn gets one step more, but never max without an explicit ask.
  assert.equal(autoTier({ text: "try again", previousVariant: "medium", previousFailures: 3 }), "high")
  assert.equal(autoTier({ text: "try again", previousVariant: "high", previousFailures: 3 }), "high")
})

test("a borderline turn keeps the previous, higher effort; upgrades are never held back", () => {
  // "add a settings dialog" scores 1 (medium); "rename the variable" -1 (low); "why does X fail" 3 (high).
  assert.equal(autoTier({ text: "add the export button", previousVariant: "high" }), "medium")
  assert.equal(autoTier({ text: "add the export button to src/a.ts\nand\nthe\nmenu\nin\nsrc/b.tsx", previousVariant: "high" }), "high")
  assert.equal(autoTier({ text: "show the config", previousVariant: "medium" }), "low")
  assert.equal(autoTier({ text: "list the open ports please", previousVariant: "medium" }), "low")
  assert.equal(autoTier({ text: "add a settings dialog", previousVariant: "low" }), "medium")
  assert.equal(autoTier({ text: "why does the export fail", previousVariant: "medium" }), "high")
  const kept = autoDecision({ text: "add a toggle\nfor\ndark\nmode\nin\nsettings", previousVariant: "high" })
  assert.equal(kept.tier, "high")
  assert.match(kept.reasons.at(-1), /borderline: keeps the previous turn's high/)
})

test("a complaint about the last attempt gets more effort than that attempt had", () => {
  assert.equal(autoTier({ text: "still not working", previousVariant: "low" }), "medium")
  assert.equal(autoTier({ text: "it still doesn't work", previousVariant: "medium" }), "high")
  assert.equal(autoTier({ text: "same error", previousVariant: "high" }), "high")
  assert.equal(autoTier({ text: "same error", previousVariant: "max" }), "max")
})

test("subagent briefs never reach max; inferred max needs a pile-up", () => {
  const brief = "Very thorough read-only review of the diff in src/a.ts, src/b.ts and src/c.ts:\n- security\n- regressions\n- race conditions\n- edge cases\n" + "context ".repeat(200)
  assert.equal(autoTier(brief), "max")
  assert.equal(autoTier({ text: brief, subagent: true }), "high")
  assert.equal(autoTier({ text: "ultrathink", subagent: true }), "high")
  assert.equal(autoTier("review the design of src/a.ts, src/b.ts, src/c.ts:\n- one\n- two\n- three"), "high")
})

test("attachments, failures and the plan agent add weight; reasons say why", () => {
  assert.equal(autoTier({ text: "add a settings dialog" }), "medium")
  assert.equal(autoTier({ text: "add a settings dialog", attachments: ["image/png"], previousFailures: 2 }), "high")
  assert.equal(autoTier({ text: "add a settings dialog", agent: "plan", attachments: ["image/png"] }), "high")
  const decision = autoDecision({ text: "why does the export crash?", previousFailures: 6 })
  assert.equal(decision.tier, "high")
  assert.deepEqual(decision.reasons, ["+2 hard work (why does)", "+2 6 failures last turn"])
})

test("turnSignals reads the stored turn; variantTier maps concrete ids", () => {
  const signals = turnSignals(
    { type: "user", text: "again", files: [{ mime: "image/png" }] },
    { type: "user", text: "fix the crash" },
    [
      { type: "assistant", model: { variant: "medium" }, content: [{ type: "tool", state: { status: "error" } }, { type: "tool", state: { status: "completed" } }] },
      { type: "assistant", model: { variant: "high" }, error: { message: "boom" }, content: [{ type: "text" }] },
    ],
    { agent: "build" },
  )
  assert.deepEqual(signals, { text: "again", attachments: ["image/png"], previousText: "fix the crash", previousVariant: "high", previousFailures: 2, agent: "build", subagent: false })
  assert.equal(autoTier(signals), "high")
  assert.equal(turnSignals({ type: "user", text: "x" }, undefined, [], { parentID: "ses_1" }).subagent, true)
  assert.equal(variantTier("minimal"), "low")
  assert.equal(variantTier("thinking"), "medium")
  assert.equal(variantTier("xhigh"), "max")
  assert.equal(variantTier("custom"), undefined)
})

test("variantFor maps a tier; the low note for an auto turn names its reasons and overrides only that turn", () => {
  assert.equal(variantFor(["low", "medium", "high", "xhigh", "max"], "max"), "max")
  assert.equal(variantFor(["low", "medium", "high", "xhigh"], "max"), "xhigh")
  assert.equal(variantFor(["low", "high", "max"], "max"), "max")
  assert.equal(variantFor(["low", "medium", "high"], "max"), "high")
  const note = lowEffortTurnNote(["-2 lookup or small edit"])
  assert.match(note, /^\[Low effort for this turn\]/)
  assert.match(note, /\(-2 lookup or small edit\)/)
  assert.match(note, /For this turn only/)
  assert.match(note, /permissions and approvals still apply/)
  assert.doesNotMatch(lowEffortTurnNote([]), /\(\)/)
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
  assert.match(history, /export const latestTurn/)
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
  assert.match(historySource(HISTORY), /latestTurn/)
  assert.match(contextSource(CONTEXT), /autoEffort/)
  assert.match(internalSource(INTERNAL), /InfiniteocEffort\.Plugin/)
  // The variant list is produced by one expression, so InfiniCode still appends after auto.
  assert.equal(variantSource(VARIANT).match(/withAutoEffort/g).length, 2)
})
