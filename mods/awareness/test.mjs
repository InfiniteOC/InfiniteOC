import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import module from "node:module"
import { applyMods } from "../../src/mod-loader.mjs"
import mod, { guidance } from "./index.mjs"

const skip = !module.stripTypeScriptTypes && "needs Node type stripping"
const lib = await import("./lib.ts").catch(() => ({}))
const pluginSource = await readFile(new URL("./plugin.ts", import.meta.url), "utf8")
const libSource = await readFile(new URL("./lib.ts", import.meta.url), "utf8")

const MARKER = "// infiniteoc:guidance-extensions"
const GUIDANCE_FILE = "packages/core/src/infiniteoc/guidance.ts"
const INTERNAL_FILE = "packages/core/src/plugin/internal.ts"
const baseGuidance = `export const infiniteocGuidance: Record<string, string[]> = { "build": ["[InfiniteOC unified workflow]"] }\n${MARKER}\n`
const baseInternal = `import { PlanPlugin } from "./plan.js"\nconst plugins = [\n  PlanPlugin.Plugin,\n]\n`

async function tree(t, { guidanceText = baseGuidance, internalText = baseInternal } = {}) {
  const root = await mkdtemp(join(tmpdir(), "awareness-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "packages/core/src/infiniteoc"), { recursive: true })
  await mkdir(join(root, "packages/core/src/plugin"), { recursive: true })
  await writeFile(join(root, GUIDANCE_FILE), guidanceText)
  await writeFile(join(root, INTERNAL_FILE), internalText)
  return root
}

const project = (files, values = {}) => ({ files, read: (name) => values[name] })

test("detectChecks finds npm, make, cargo, go and pytest commands", { skip }, () => {
  assert.equal(lib.detectCheck(project(["package.json"], { "package.json": JSON.stringify({ scripts: { check: "vitest run", test: "node --test" } }) })), "npm run check")
  assert.equal(lib.detectCheck(project(["package.json", "pnpm-lock.yaml"], { "package.json": JSON.stringify({ scripts: { test: "vitest" } }) }), "tests"), "pnpm run test")
  assert.equal(lib.detectCheck(project(["package.json"], { "package.json": JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }) })), undefined)
  assert.equal(lib.detectCheck(project(["Makefile"], { Makefile: "lint:\n\tnpx eslint .\n" }), "lint"), "make lint")
  assert.equal(lib.detectCheck(project(["Cargo.toml"]), "tests"), "cargo test")
  assert.equal(lib.detectCheck(project(["go.mod"]), "tests"), "go test ./...")
  assert.equal(lib.detectCheck(project(["pyproject.toml"], { "pyproject.toml": "[tool.pytest]\n" })), "python -m pytest -q")
  assert.equal(lib.detectCheck(project(["package.json", "tsconfig.json"], { "package.json": "{}" }), "types"), "npx tsc --noEmit")
  const all = lib.detectChecks(project(["package.json"], { "package.json": JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }) }))
  assert.equal(all.tests, "npm run test")
  assert.equal(all.lint, "npm run lint")
})

test("formatChecks lists every kind and never leaks values", { skip }, () => {
  const text = lib.formatChecks({ check: "npm run check", tests: undefined, types: "npx tsc --noEmit", lint: undefined })
  assert.match(text, /check: npm run check/)
  assert.match(text, /tests: not detected/)
  assert.match(text, /run these instead of guessing/i)
  const empty = lib.formatChecks({ check: undefined, tests: undefined, types: undefined, lint: undefined })
  assert.match(empty, /No check commands detected/)
  assert.doesNotMatch(text + empty, /hunter2|sk-ant|BEGIN PRIVATE KEY/i)
})

test("toolGuide returns one entry, all entries, or the known list", { skip }, () => {
  assert.match(lib.toolGuide("free_port"), /PORT/)
  assert.match(lib.toolGuide("project_checks"), /before claiming/i)
  assert.match(lib.toolGuide(), /free_port.*env_diff.*project_checks.*tool_guide.*ui_check/s)
  assert.match(lib.toolGuide("nope"), /Unknown tool.*Known custom tools/s)
  assert.equal(Object.keys(lib.TOOL_GUIDE).length >= 20, true)
})

test("applyMods writes the plugin files and patches both anchors", async (t) => {
  const root = await tree(t)
  const result = await applyMods([mod], root)
  const paths = result.changes.map((change) => change.path).sort()
  assert.deepEqual(paths, [
    "packages/core/src/infiniteoc/guidance.ts",
    "packages/core/src/plugin/infiniteoc-awareness-lib.ts",
    "packages/core/src/plugin/infiniteoc-awareness.ts",
    "packages/core/src/plugin/internal.ts",
  ])
  const afterGuidance = await readFile(join(root, GUIDANCE_FILE), "utf8")
  assert.ok(afterGuidance.includes(`infiniteocGuidance.build.push(${JSON.stringify(guidance)})`))
  assert.equal(afterGuidance.split(MARKER).length, 2)
  const afterInternal = await readFile(join(root, INTERNAL_FILE), "utf8")
  assert.match(afterInternal, /InfiniteocAwareness\.Plugin/)
  assert.match(afterInternal, /infiniteoc-awareness\.js/)
  // Generated guidance module still evaluates with the new block appended.
  const code = afterGuidance.replace(": Record<string, string[]>", "")
  const value = new Function(`${code.replace("export const", "const")}; return infiniteocGuidance`)()
  assert.equal(value.build.at(-1), guidance)
})

test("fails closed on missing/duplicate anchors and repeat application", async (t) => {
  await assert.rejects(applyMods([mod], await tree(t, { guidanceText: "unrelated\n" })), /expected one source anchor/)
  await assert.rejects(applyMods([mod], await tree(t, { internalText: "unrelated\n" })), /expected one source anchor/)
  await assert.rejects(applyMods([mod], await tree(t, { guidanceText: `${MARKER}\n${MARKER}\n` })), /expected one source anchor/)
  const root = await tree(t)
  await applyMods([mod], root)
  await assert.rejects(applyMods([mod], root), /already applied/)
})

test("guidance stays bounded and grants nothing", () => {
  assert.ok(guidance.startsWith("[Tool awareness]"))
  assert.ok(guidance.length < 1200, `guidance is ${guidance.length} chars`)
  assert.ok(guidance.includes("tool_guide"))
  assert.ok(guidance.includes("These add no permissions"))
  assert.doesNotMatch(guidance, /effect\s*:\s*"allow"|"allow"|apiKey|secret\s*=/i)
})

test("plugin is read-only: three tools, no exec/writes/permission changes", () => {
  assert.match(pluginSource, /name: "project_checks"/)
  assert.match(pluginSource, /name: "tool_guide"/)
  assert.match(pluginSource, /name: "infiniteoc"/)
  assert.match(pluginSource, /codemode: false/)
  assert.doesNotMatch(pluginSource, /child_process|spawn\(|execFile|writeFileSync|renameSync|chmod|effect\s*=\s*"allow"/)
  assert.doesNotMatch(pluginSource, /safety\.ts|SAFETY_GATE|InfiniteOC safety settings/)
  // lib is pure: no fs, no network, no upstream imports.
  assert.doesNotMatch(libSource, /node:fs|node:child_process|fetch\(|@opencode\//)
})

test("toolGuide covers the infiniteoc manager", { skip }, () => {
  assert.match(lib.toolGuide("infiniteoc"), /user-only|never execute/i)
  assert.match(lib.toolGuide(), /infiniteoc \{op\?/)
})

test("toolGuide documents parallel-call rules", { skip }, () => {
  assert.match(lib.toolGuide("parallel"), /concurrently/)
  assert.match(lib.toolGuide("parallel"), /SAME file/)
  assert.match(lib.toolGuide("parallel"), /prompts separately/)
  assert.match(lib.toolGuide(), /parallel \(guide entry/)
})

test("toolGuide documents the agent display", { skip }, () => {
  assert.match(lib.toolGuide("agent_display"), /agent_display \{action/)
  assert.match(lib.toolGuide("agent_display"), /:99/)
  assert.match(lib.toolGuide("agent_display"), /shell permission/)
  assert.match(lib.toolGuide(), /agent_display \{action/)
})

test("runner concurrency properties hold (regression guard)", async (t) => {
  const root = new URL("../../.upstream/", import.meta.url)
  const step = await readFile(new URL("packages/core/src/session/runner/step.ts", root), "utf8").catch(() => null)
  const edit = await readFile(new URL("packages/core/src/tool/plugin/edit.ts", root), "utf8").catch(() => null)
  if (!step || !edit) {
    t.skip("run `node bin/infiniteoc.mjs setup` first")
    return
  }
  // One fiber per tool-call, joined each turn: same-block calls run concurrently.
  assert.match(step, /Effect\.forkScoped/)
  assert.match(step, /Fiber\.awaitAll\(toolRuns/)
  assert.match(step, /toolRuns\.push/)
  // No global concurrency cap on tool execution.
  assert.doesNotMatch(step, /maxConcurr|concurrency:\s*\d+/i)
  // Same-file writes stay serialized through the per-path lock.
  assert.match(edit, /fileMutation\.withLock\(\[FileAccess\.resolvePath/)
})

test("findCheckout walks up to infiniteoc.json", { skip }, () => {
  const exists = (dir) => dir === "/home/user/InfiniteOC"
  assert.equal(lib.findCheckout("/home/user/InfiniteOC/mods/awareness", exists), "/home/user/InfiniteOC")
  assert.equal(lib.findCheckout("/elsewhere/deep", exists), undefined)
})

test("readCheckout parses pin+mods and fails closed", { skip }, () => {
  const info = lib.readCheckout("/c", JSON.stringify({ upstream: "v2.0.21", mods: ["./mods/a/index.mjs"] }), "feat/x")
  assert.equal(info.dir, "/c")
  assert.equal(info.upstream, "v2.0.21")
  assert.deepEqual(info.mods, ["./mods/a/index.mjs"])
  assert.match(lib.readCheckout("/c", undefined), /No infiniteoc.json/)
  assert.match(lib.readCheckout("/c", "{oops"), /not strict JSON/)
  assert.match(lib.readCheckout("/c", JSON.stringify({ mods: [] })), /no upstream string/)
})

test("infiniteoc dispatch: reads answer, recipes quote, user-only stops", { skip }, () => {
  const status = { dir: "/c", upstream: "v2.0.21", mods: ["./mods/a/index.mjs"], branch: "main" }
  assert.match(lib.infiniteoc(undefined, undefined, status), /Upstream pin: v2\.0\.21/)
  assert.match(lib.infiniteoc("mods", undefined, status), /\./)
  assert.match(lib.infiniteoc("help", undefined, status), /user-only ops stop there/)
  assert.match(lib.infiniteoc("nope", undefined, status), /Unknown op/)
  assert.match(lib.infiniteoc("check", undefined, status), /Usage.*target/)
  assert.match(lib.infiniteoc("enable", "my-mod", status), /User runs: .*feature enable my-mod/)
  assert.match(lib.infiniteoc("rebuild", undefined, status), /safe boundary.*User runs:/s)
  for (const op of ["update", "bench", "remote", "mod", "wizard"]) {
    const out = lib.infiniteoc(op, undefined, status)
    assert.match(out, /Refused from agent context/, op)
    assert.match(out, /User runs:/, op)
  }
  assert.match(lib.infiniteoc("status", undefined, "No infiniteoc.json in /x."), /No infiniteoc.json/)
})
