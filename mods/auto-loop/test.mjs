import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import infiniteoc from "../infiniteoc/index.mjs"
import mod from "./index.mjs"
import * as L from "./logic.ts"

const root = path.resolve(import.meta.dirname, "../../.upstream")

// Minimal transcript builders, shaped like SessionMessage.Info.
let id = 0
const user = (text) => ({ type: "user", id: `u${++id}`, text })
const synthetic = (text) => ({ type: "synthetic", id: `s${++id}`, text })
const reply = (text, tools = []) => ({
  type: "assistant",
  id: `a${++id}`,
  content: [{ type: "text", text }, ...tools],
})
const tool = (name, input, status = "completed", metadata) => ({ type: "tool", id: `t${++id}`, name, state: { status, input, metadata } })
const edit = (file) => tool("edit", { path: file })
const project = (files) => ({ files: Object.keys(files), read: (name) => files[name] })

test("the mod applies after infiniteoc: plugin, goal templates, guidance", async () => {
  const files = new Map()
  const api = {
    root,
    options: {},
    async patch(file, transform) {
      files.set(file, await transform(files.get(file) ?? (await readFile(path.join(root, file), "utf8"))))
    },
    async write(file, content) {
      files.set(file, content)
    },
  }
  await infiniteoc.setup(api)
  await mod.setup(api)
  for (const name of ["", "-logic", "-project"]) assert.ok(files.has(`packages/core/src/plugin/infiniteoc-auto${name}.ts`), name)
  const internal = files.get("packages/core/src/plugin/internal.ts")
  assert.match(internal, /import \* as InfiniteocAuto from "\.\/infiniteoc-auto\.js"/)
  assert.match(internal, /PlanPlugin\.Plugin,\n  InfiniteocAuto\.Plugin,\n/)
  assert.match(files.get("packages/core/src/plugin/infiniteoc-goal.ts"), /expandGoal\(goal, `\$\{session\.location\.directory\}/)
  const guidance = files.get("packages/core/src/infiniteoc/guidance.ts")
  assert.match(guidance, /infiniteocGuidance\.build\.push\(.*question tool/)
  assert.equal(guidance.split("// infiniteoc:guidance-extensions").length, 2)
})

test("check command detection reads package.json, Makefile, cargo, go and pytest", () => {
  const scripts = (value, extra = {}) => project({ "package.json": JSON.stringify({ scripts: value }), ...extra })
  assert.equal(L.detectCheck(scripts({ test: "node --test", check: "tsc && node --test" })), "npm run check")
  assert.equal(L.detectCheck(scripts({ test: "vitest" }, { "pnpm-lock.yaml": "" })), "pnpm run test")
  assert.equal(L.detectCheck(scripts({ test: "vitest" }, { "bun.lock": "" }), "tests"), "bun run test")
  assert.equal(L.detectCheck(scripts({ test: "vitest" }, { "yarn.lock": "" })), "yarn test")
  assert.equal(L.detectCheck(scripts({ test: 'echo "Error: no test specified" && exit 1' })), undefined)
  assert.equal(L.detectCheck(scripts({ typecheck: "tsc --noEmit" }), "types"), "npm run typecheck")
  assert.equal(L.detectCheck(scripts({}, { "tsconfig.json": "{}" }), "types"), "npx tsc --noEmit")
  assert.equal(L.detectCheck(scripts({ lint: "eslint ." }), "lint"), "npm run lint")
  assert.equal(L.detectCheck(project({ Makefile: "build:\n\tcc x\ncheck: build\n\t./t\n" })), "make check")
  assert.equal(L.detectCheck(project({ "Cargo.toml": "" }), "tests"), "cargo test")
  assert.equal(L.detectCheck(project({ "go.mod": "" })), "go vet ./... && go test ./...")
  assert.equal(L.detectCheck(project({ "pyproject.toml": "[tool.pytest.ini_options]" })), "python -m pytest -q")
  assert.equal(L.detectCheck(project({ "README.md": "" })), undefined)
  assert.equal(L.detectCheck(project({ "package.json": "{not json" })), undefined)
})

test("verifyPlan runs after edits, counts failure notes per prompt, and skips unchanged retries", () => {
  assert.deepEqual(L.verifyPlan([user("hi"), reply("hello")], 2), { run: false, attempt: 0 })
  const edited = [user("fix"), reply("done", [edit("a.ts")])]
  assert.deepEqual(L.verifyPlan(edited, 2), { run: true, attempt: 0 })
  assert.equal(L.verifyPlan(edited, 2, edited.length).run, false, "already passed at this point")
  // One failed attempt, and the fix-up edited again: run again; no edit in the fix-up: do not.
  const note = synthetic(L.verifyFailText("npm test", "boom", 1, 2))
  assert.deepEqual(L.verifyPlan([...edited, note, reply("fixed", [edit("a.ts")])], 2), { run: true, attempt: 1 })
  assert.equal(L.verifyPlan([...edited, note, reply("no idea")], 2).run, false)
  // The cap, and a new user prompt resets the count.
  const capped = [...edited, note, reply("x", [edit("a.ts")]), synthetic(L.verifyFailText("npm test", "boom", 2, 2)), reply("y", [edit("a.ts")])]
  assert.deepEqual(L.verifyPlan(capped, 2), { run: false, attempt: 2 })
  assert.deepEqual(L.verifyPlan([...capped, user("again"), reply("z", [edit("b.ts")])], 2), { run: true, attempt: 0 })
  // Failed or non-edit tool calls are not edits.
  assert.equal(L.verifyPlan([user("x"), reply("y", [tool("edit", { path: "a" }, "error"), tool("read", { path: "a" })])], 2).run, false)
  assert.deepEqual(L.editedFiles([user("x"), reply("y", [tool("patch", { patchText: "*** Update File: a.ts\n*** Add File: b.ts\n*** Move to: c.ts" })])], 0), ["a.ts", "b.ts", "c.ts"])
})

test("stuck detection trips on the third identical failure and resets on success", () => {
  const counts = new Map()
  const key = L.callKey("shell", { command: "make", cwd: "/x" })
  assert.equal(key, L.callKey("shell", { cwd: "/x", command: "make" }), "key order does not matter")
  assert.notEqual(key, L.callKey("shell", { command: "make test" }))
  assert.equal(L.bump(counts, key + "|err", true), 1)
  assert.equal(L.bump(counts, key + "|other", true), 1, "a different failure output is different progress")
  assert.equal(L.bump(counts, key + "|err", true), 2)
  assert.equal(L.bump(counts, key + "|err", true), L.STUCK_AT)
  assert.equal(L.bump(counts, key + "|err", false), 0)
  assert.equal(L.bump(counts, key + "|err", true), 1)
  assert.match(L.stuckNote("shell"), /question tool/)
  assert.match(L.stuckRefusal("edit"), /Do not retry/)
})

test("durations, /loop parsing and formatting", () => {
  assert.equal(L.parseDuration("90s"), 90_000)
  assert.equal(L.parseDuration("5m"), 300_000)
  assert.equal(L.parseDuration("1h30m"), 5_400_000)
  assert.equal(L.parseDuration("1.5h"), 5_400_000)
  for (const bad of ["", "5", "m", "5x", "0m", "5 m", "abc", "-5m"]) assert.equal(L.parseDuration(bad), undefined, bad)
  assert.equal(L.formatDuration(5_400_000), "1h 30m")
  assert.equal(L.formatDuration(45_000), "45s")
  assert.equal(L.formatDuration(120_000), "2m")
  assert.deepEqual(L.parseLoop("5m check the build  now"), { action: "start", ms: 300_000, prompt: "check the build now" })
  assert.deepEqual(L.parseLoop("stop"), { action: "stop" })
  assert.deepEqual(L.parseLoop(""), { action: "status" })
  assert.equal(L.parseLoop("5s hi").action, "error", "below the minimum interval")
  assert.equal(L.parseLoop("5m").action, "error", "needs a prompt")
  assert.equal(L.parseLoop("soon do it").action, "error")
})

test("plan state follows the approval answer; ask-first gates the second file; goal activity", () => {
  const ask = (answer) => reply("Approve?", [tool("question", { questions: [] }, "completed", { answers: [[answer]] })])
  const plan = synthetic(L.planText("add x"))
  assert.equal(L.planState([user("hi")]), "none")
  assert.equal(L.planState([plan, user("add x"), reply("- [ ] one")]), "planning")
  assert.equal(L.planState([plan, user("add x"), reply("- [ ] one"), ask("Revise the plan")]), "planning")
  assert.equal(L.planState([plan, user("add x"), ask("Edit step 2 please")]), "planning")
  assert.equal(L.planState([plan, user("add x"), ask(L.APPROVE)]), "approved")
  assert.equal(L.planState([plan, user("add x"), ask(L.CANCEL)]), "none")
  assert.equal(L.planState([plan, user("add x"), ask(L.APPROVE), synthetic(L.planText("next")), user("next")]), "planning")

  assert.equal(L.askFirstOn([user("x")]), false)
  assert.equal(L.askFirstOn([synthetic(L.MARK.askOn), user("x")]), true)
  assert.equal(L.askFirstOn([synthetic(L.MARK.askOn), synthetic(L.MARK.askOff)]), false)
  const turn = [user("change things")]
  assert.equal(L.askFirstGate(turn, ["a.ts"]), false, "one file is fine")
  assert.equal(L.askFirstGate([...turn, reply("", [edit("a.ts")])], ["a.ts"]), false, "same file again")
  assert.equal(L.askFirstGate([...turn, reply("", [edit("a.ts")])], ["b.ts"]), true, "second file")
  assert.equal(L.askFirstGate([...turn, reply("", [tool("question", {}, "completed"), edit("a.ts")])], ["b.ts"]), false, "asked first")
  assert.equal(L.askFirstGate([user("old"), reply("", [edit("a.ts")]), user("new")], ["b.ts"]), false, "a new prompt starts over")

  assert.equal(L.goalActive([user("[InfiniteOC goal]\nGoal: x")]), true)
  assert.equal(L.goalActive([user("[InfiniteOC goal]\nGoal: x"), synthetic("[InfiniteOC goal: finished]\nok")]), false)
  assert.equal(L.goalActive([user("[InfiniteOC goal]\nGoal: x"), synthetic("[InfiniteOC goal: stopped]\nok")]), false)
  assert.equal(L.goalActive([user("hello")]), false)
})

test("escalation state, model refs and review verdicts", () => {
  assert.equal(L.escalatedFrom([user("x")]), undefined)
  const up = synthetic(L.escalatedText("lab/fake", "lab/haiku", "The check failed 2 times"))
  assert.equal(L.escalatedFrom([user("x"), up]), "lab/fake")
  assert.equal(L.escalatedFrom([user("x"), up, synthetic(L.restoredText("lab/fake"))]), undefined)
  assert.equal(L.escalatedFrom([up, synthetic(L.restoredText("lab/fake")), synthetic(L.escalatedText("a/b#high", "c/d", "again"))]), "a/b#high")
  assert.equal(L.refString({ providerID: "lab", id: "fake" }), "lab/fake")
  assert.equal(L.refString({ providerID: "lab", id: "fake", variant: "high" }), "lab/fake#high")
  assert.equal(L.refString(undefined), undefined)
  for (const ok of ["lab/fake", "anthropic/claude-opus#high", "openrouter/a/b"]) assert.ok(L.modelRef(ok), ok)
  for (const bad of ["fake", "/x", "a/", "a b/c", 5, ""]) assert.ok(!L.modelRef(bad), String(bad))
  assert.ok(L.reviewClean("NO DEFECTS"))
  assert.ok(L.reviewClean("  no defects."))
  assert.ok(!L.reviewClean("- major, a.ts:3, NO DEFECTS here? no"))
  assert.match(L.reviewPrompt("do x", "diff --git"), /NO DEFECTS[\s\S]*$|diff --git/)
})

test("settings normalize, change one key at a time, and reject bad values", () => {
  assert.deepEqual(L.normalizeSettings(undefined), L.defaults)
  assert.deepEqual(L.normalizeSettings({ verify: "no", verifyRetries: 99, reviewerModel: "nope", persona: "pirate", escalateModel: "a/b" }), { ...L.defaults, escalateModel: "a/b" })
  const next = (current, key, value) => {
    const result = L.applySetting(current, key, value)
    assert.ok("next" in result, JSON.stringify(result))
    return result.next
  }
  assert.deepEqual(next({}, "verify", "off"), { verify: false })
  assert.deepEqual(next({ verify: false }, "VERIFY", "on"), { verify: true })
  assert.deepEqual(next({}, "verifycmd", "make check"), { verifyCommand: "make check" })
  assert.deepEqual(next({ verifyCommand: "x" }, "verifycmd", "off"), {})
  assert.deepEqual(next({}, "retries", "3"), { verifyRetries: 3 })
  assert.deepEqual(next({ other: 1 }, "persona", "Terse"), { other: 1, persona: "terse" })
  assert.deepEqual(next({ escalateModel: "a/b" }, "escalate", "off"), {})
  for (const [key, value] of [["verify", "maybe"], ["retries", "0"], ["retries", "x"], ["reviewer", "nomodel"], ["persona", "pirate"], ["nope", "1"], ["timeout", "1"]])
    assert.ok("error" in L.applySetting({}, key, value), `${key} ${value}`)
  assert.match(L.describeSettings(L.defaults), /verify on.*stuck on.*critique off.*reviewer off.*escalate off.*persona off/)
})

test("goal templates expand to goals with the detected command", () => {
  assert.match(L.goalTemplate("tests", "npm run test"), /^the project's tests pass: `npm run test` exits 0/)
  assert.match(L.goalTemplate("Types", "npx tsc --noEmit"), /type-checks cleanly: `npx tsc --noEmit`/)
  assert.match(L.goalTemplate("lint", undefined), /find the lint command/)
  assert.equal(L.goalTemplate("make the tests pass", "x"), undefined)
  assert.equal(L.goalTemplate("testsuite", "x"), undefined)
})

test("macros and queue prompts stay plain, timebox and why texts keep their instructions", () => {
  assert.match(L.timeboxText("30m"), /Stop starting new work[\s\S]*summarize/)
  assert.match(L.whyText(""), /evidence[\s\S]*Do not make any changes/)
  assert.match(L.whyText("the rename"), /Focus: the rename/)
  assert.match(L.critiqueText, /git diff/)
  assert.ok(L.personas.terse && L.personas.teacher && L.personas.pair)
  assert.match(L.planText("do it"), /question tool[\s\S]*Approve and execute[\s\S]*- \[x\]/)
})
