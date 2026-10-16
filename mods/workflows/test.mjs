import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import mod, { buildDefault, relink, replace, settingsSource } from "./index.mjs"
import * as D from "./dag.ts"
import * as M from "./mailbox.ts"
import * as Models from "./models.ts"
import * as S from "./settings.ts"
import * as Store from "./store.ts"

const checkout = path.resolve(import.meta.dirname, "../..")
const upstream = path.join(checkout, ".upstream")
const config = JSON.parse(await readFile(path.join(checkout, "infiniteoc.json"), "utf8"))

// Pristine pinned files come from git objects, not the working tree: the shared .upstream checkout
// must stay read-only, and an in-progress edit by another process must not change these results.
let gitOK = false
try {
  execFileSync("git", ["-C", upstream, "cat-file", "-t", config.upstream], { stdio: "ignore" })
  gitOK = true
} catch {}
const pristine = (file) => execFileSync("git", ["-C", upstream, "show", `${config.upstream}:${file}`], { encoding: "utf8", maxBuffer: 64 << 20 })

/** An in-memory mod API over pristine upstream: writes and patches land in `files`. */
function memoryApi(options = config.options) {
  const files = new Map()
  const commands = []
  const read = async (file) => (files.has(file) ? files.get(file) : pristine(file))
  const api = {
    root: upstream,
    options,
    read,
    async write(file, content) {
      files.set(file, content)
    },
    async patch(file, transform) {
      const before = await read(file)
      const after = await transform(before)
      if (typeof after !== "string" || after === before) throw new Error(`patch left ${file} unchanged`)
      files.set(file, after)
    },
    async patchExact(file, before, after) {
      const source = await read(file)
      if (source.split(before).length !== 2) throw new Error(`patchExact: expected one anchor in ${file}`)
      files.set(file, source.replace(before, () => after))
    },
    tui: { command: (command) => commands.push(command) },
    on() {},
  }
  return { api, files, commands }
}

async function loadEnabled() {
  const mods = []
  for (const entry of config.mods) {
    if (entry.includes("/workflows/")) continue
    mods.push((await import(path.resolve(checkout, entry))).default)
  }
  return mods
}

const plan = (steps, name = "t") => D.validatePlan({ name, steps }, { maxSteps: 12 })

// ---- mod application ------------------------------------------------------------------------------

test("applies after every enabled mod on pristine upstream: plugin, tool registration, TUI, settings, readonly", { skip: !gitOK && "no pinned upstream git objects" }, async () => {
  const { api, files, commands } = memoryApi()
  for (const other of await loadEnabled()) await other.setup(api)
  await mod.setup(api)

  const internal = files.get("packages/core/src/plugin/internal.ts")
  assert.match(internal, /import \{ SubagentTool \} from "\.\.\/tool\/plugin\/subagent\.js"\nimport \* as InfiniteocWorkflows from "\.\/infiniteoc-workflows\.js"\n/)
  assert.match(internal, /  SubagentTool\.Plugin,\n  InfiniteocWorkflows\.Plugin,\n/)
  // The classic subagent tool stays registered and untouched by this mod.
  assert.equal(internal.split("SubagentTool.Plugin,").length, 2)

  const plugin = files.get("packages/core/src/plugin/infiniteoc-workflows.ts")
  for (const name of ["dag", "mailbox", "models", "settings", "store"]) {
    assert.ok(files.has(`packages/core/src/plugin/infiniteoc-wf-${name}.ts`), name)
    assert.doesNotMatch(files.get(`packages/core/src/plugin/infiniteoc-wf-${name}.ts`), /from "\.\/[\w-]+\.ts"/)
  }
  assert.match(plugin, /from "\.\/infiniteoc-wf-dag\.js"/)
  assert.match(plugin, /options: \{ codemode: false, permission: "subagent" \}/)
  assert.doesNotMatch(plugin, /from "\.\/[\w-]+\.ts"/)
  // Every module the plugin imports exists in the pinned source or was written by an earlier mod.
  for (const [, rel] of plugin.matchAll(/from "(\.\.\/[^"]+)\.js"/g)) {
    const target = path.posix.join("packages/core/src/plugin", `${rel}.ts`)
    if (!files.has(target)) assert.doesNotThrow(() => pristine(target), target)
  }
  // /goal waits for workflows through mods/infiniteoc's background registry.
  assert.match(plugin, /import \* as Background from "\.\.\/infiniteoc\/background\.js"/)
  assert.ok(files.has("packages/core/src/infiniteoc/background.ts"))

  const builtins = files.get("packages/tui/src/plugin/builtins.ts")
  assert.match(builtins, /import InfiniteocWorkflows from "\.\.\/feature-plugins\/system\/infiniteoc-workflows"/)
  assert.match(builtins, /  Notifications,\n  InfiniteocWorkflows,\n/)
  assert.ok(files.has("packages/tui/src/feature-plugins/system/infiniteoc-workflows.tsx"))
  for (const name of ["settings", "dag", "store"]) assert.ok(files.has(`packages/tui/src/infiniteoc-features/workflows-${name}.ts`), name)
  assert.match(files.get("packages/tui/src/infiniteoc-features/workflows-store.ts"), /from "\.\/workflows-settings"/)

  const dialog = files.get("packages/tui/src/component/dialog-infiniteoc.tsx")
  assert.match(dialog, /import \{ applyChange as workflowsChange, normalize as workflowsNormalize \} from "\.\/workflows-settings"/)
  assert.match(dialog, /function workflowsSettings\(\)/)
  assert.match(dialog, /\{ title: "Workflows", value: "workflows"/)
  assert.match(dialog, /if \(option\.value === "workflows"\) workflowsSettings\(\)/)
  assert.ok(files.has("packages/tui/src/component/workflows-settings.ts"))

  // safe-guard is enabled before this mod: /readonly also refuses workflows with editing steps.
  const safety = files.get("packages/core/src/plugin/infiniteoc-safety.ts")
  assert.ok(safety, "safe-guard is enabled")
  assert.match(safety, /if \(event\.tool === "workflow"\) \{/)
  assert.match(safety, /readonlyRefusal\(`a workflow with the \$\{editing\} subagent \(it can edit\)`\)/)

  const command = commands.find((item) => item.slash === "workflows")
  assert.ok(command)
  assert.deepEqual(command.aliases, ["wf"])
  assert.match(command.source, /export async function run\(ctx: FeatureContext\)/)
  // Off unless infiniteoc.json turns it on (options.workflows.enabled).
  assert.ok(files.get("packages/core/src/plugin/infiniteoc-wf-settings.ts").includes(`  enabled: ${buildDefault(config.options)},\n  maxParallel`))
})

test("without safe-guard the readonly patch is skipped; a missing anchor fails closed", { skip: !gitOK && "no pinned upstream git objects" }, async () => {
  const { api, files } = memoryApi()
  const infiniteoc = (await import("../infiniteoc/index.mjs")).default
  await infiniteoc.setup(api)
  await mod.setup(api)
  assert.equal(files.has("packages/core/src/plugin/infiniteoc-safety.ts"), false)
  assert.ok(files.has("packages/core/src/plugin/infiniteoc-workflows.ts"))

  // The settings dialog (and the background registry) come from mods/infiniteoc; without it this mod refuses to guess.
  const bare = memoryApi()
  await assert.rejects(mod.setup(bare.api), /dialog-infiniteoc|ENOENT|exists|fatal|Command failed/i)
  // Applying twice cannot silently double-register the plugin.
  await assert.rejects(mod.setup(api), /already applied/)
})

test("build default: options.workflows.enabled bakes the default; settings.json still wins", async () => {
  assert.equal(buildDefault(undefined), false)
  assert.equal(buildDefault({ workflows: { enabled: true } }), true)
  assert.equal(buildDefault({ workflows: { enabled: "yes" } }), false)
  const source = await readFile(new URL("./settings.ts", import.meta.url), "utf8")
  const on = settingsSource(source, true)
  assert.match(on, /  enabled: true,\n  maxParallel/)
  assert.throws(() => settingsSource(on, false), /expected one source anchor/)
  assert.throws(() => replace("a\nb", "a\n", "a\nb"), /already applied/)
})

test("relink maps every sibling import and rejects unknown ones", () => {
  assert.equal(relink('import * as D from "./dag.ts"\nimport type { X } from "./settings.ts"', { dag: "a.js", settings: "b.js" }), 'import * as D from "./a.js"\nimport type { X } from "./b.js"')
  assert.throws(() => relink('import x from "./other.ts"', { dag: "a.js" }), /unmapped import/)
})

// ---- plan validation ------------------------------------------------------------------------------

test("plan validation: defaults, and clear errors for bad ids, dependencies, cycles and templates", () => {
  const result = plan([{ id: "a", prompt: " find x " }, { id: "b", prompt: "use {{steps.a}}", needs: ["a", "a"], agent: "reviewer", optional: true }], "  my flow ")
  assert.equal(result.name, "my flow")
  assert.deepEqual(result.steps[0], { id: "a", title: "a", agent: "general", prompt: "find x", needs: [], optional: false })
  assert.deepEqual(result.steps[1].needs, ["a"])
  assert.equal(result.steps[1].optional, true)

  const bad = (steps, pattern, limits = { maxSteps: 12 }) => assert.throws(() => D.validatePlan({ steps }, limits), pattern)
  bad([], /at least one step/)
  bad(undefined, /at least one step/)
  bad([{ id: "a", prompt: "x" }, { id: "b", prompt: "y" }], /limit is 1/, { maxSteps: 1 })
  bad([{ id: "has space", prompt: "x" }], /id must be/)
  bad([{ id: "main", prompt: "x" }], /reserved/)
  bad([{ id: "All", prompt: "x" }], /reserved/)
  bad([{ id: "a", prompt: "x" }, { id: "a", prompt: "y" }], /Duplicate step id "a"/)
  bad([{ id: "a", prompt: "  " }], /no prompt/)
  bad([{ id: "a", prompt: "x", needs: ["zz"] }], /unknown step "zz"/)
  bad([{ id: "a", prompt: "x", needs: ["a"] }], /cannot depend on itself/)
  bad([{ id: "a", prompt: "x", needs: "b" }], /needs must be a list/)
  bad([{ id: "a", prompt: "x {{steps.b}}" }, { id: "b", prompt: "y" }], /does not list "b" in needs/)
  bad(
    [
      { id: "a", prompt: "x", needs: ["c"] },
      { id: "b", prompt: "y", needs: ["a"] },
      { id: "c", prompt: "z", needs: ["b"] },
    ],
    /Dependency cycle: a -> c -> b -> a/,
  )
  bad([{ id: "a", prompt: "x".repeat(30) }], /longer than 20 characters/, { maxSteps: 4, maxPromptChars: 20 })
})

test("levels groups steps by dependency depth", () => {
  const { steps } = plan([
    { id: "plan", prompt: "p" },
    { id: "api", prompt: "a", needs: ["plan"] },
    { id: "ui", prompt: "u", needs: ["plan"] },
    { id: "review", prompt: "r", needs: ["api", "ui"] },
    { id: "docs", prompt: "d" },
  ])
  assert.deepEqual(D.levels(steps), [["plan", "docs"], ["api", "ui"], ["review"]])
})

// ---- scheduling -----------------------------------------------------------------------------------

/** Drives the state machine the way the plugin does: start what is ready, finish asynchronously, repeat. */
function simulate(steps, { outcomes = {}, delays = {}, maxParallel = 3, cancelAfter } = {}) {
  const wf = { id: "wf_test", name: "t", parentSessionID: "ses_x", status: "running", createdAt: 0, steps, state: D.initialState(steps), messages: [] }
  const log = []
  let peak = 0
  return new Promise((resolve) => {
    let resolved = false
    const finish = () => {
      if (resolved) return
      resolved = true
      wf.status = D.overall(wf)
      resolve({ wf, log, peak })
    }
    const pump = () => {
      if (resolved) return
      D.propagate(wf)
      if (wf.status === "running")
        for (const id of D.ready(wf, maxParallel)) {
          wf.state[id].status = "running"
          log.push(`start ${id}`)
          peak = Math.max(peak, steps.filter((step) => wf.state[step.id].status === "running").length)
          setTimeout(() => {
            if (wf.state[id].status !== "running") return
            wf.state[id].status = outcomes[id] ?? "completed"
            wf.state[id].output = `result of ${id}`
            log.push(`end ${id}`)
            pump()
          }, delays[id] ?? 2)
        }
      if (steps.every((step) => D.isFinished(wf.state[step.id].status))) finish()
    }
    if (cancelAfter !== undefined)
      setTimeout(() => {
        D.cancelAll(wf, Date.now(), "cancelled by the user")
        log.push("cancel")
        finish()
      }, cancelAfter)
    pump()
  })
}

test("independent steps run in parallel up to maxParallel; dependents wait for their needs", async () => {
  const { steps } = plan([
    { id: "a", prompt: "x" },
    { id: "b", prompt: "x" },
    { id: "c", prompt: "x" },
    { id: "d", prompt: "x" },
    { id: "join", prompt: "x", needs: ["a", "b", "c", "d"] },
  ])
  const { wf, log, peak } = await simulate(steps, { maxParallel: 2, delays: { a: 5, b: 1, c: 1, d: 1 } })
  assert.equal(wf.status, "completed")
  assert.equal(peak, 2)
  assert.deepEqual(log.slice(0, 2), ["start a", "start b"])
  assert.ok(log.indexOf("start join") > log.indexOf("end a"))
  assert.ok(log.indexOf("start join") > log.indexOf("end d"))
})

test("a failed required step skips its dependents transitively and fails the workflow", async () => {
  const { steps } = plan([
    { id: "a", prompt: "x" },
    { id: "b", prompt: "x", needs: ["a"] },
    { id: "c", prompt: "x", needs: ["b"] },
    { id: "side", prompt: "x" },
  ])
  const { wf, log } = await simulate(steps, { outcomes: { a: "failed" } })
  assert.equal(wf.status, "failed")
  assert.equal(wf.state.b.status, "skipped")
  assert.equal(wf.state.c.status, "skipped")
  assert.match(wf.state.b.error, /required step "a" failed/)
  assert.match(wf.state.c.error, /required step "b" skipped/)
  assert.equal(wf.state.side.status, "completed")
  assert.ok(!log.includes("start b"))
})

test("an optional step's failure neither blocks dependents nor fails the workflow", async () => {
  const { steps } = plan([
    { id: "maybe", prompt: "x", optional: true },
    { id: "after", prompt: "x", needs: ["maybe"] },
  ])
  const { wf } = await simulate(steps, { outcomes: { maybe: "failed" } })
  assert.equal(wf.state.after.status, "completed")
  assert.equal(wf.status, "completed")
})

test("cancel stops running and pending steps and keeps finished results", async () => {
  const { steps } = plan([
    { id: "fast", prompt: "x" },
    { id: "slow", prompt: "x" },
    { id: "later", prompt: "x", needs: ["slow"] },
  ])
  const { wf } = await simulate(steps, { delays: { fast: 1, slow: 200 }, cancelAfter: 30 })
  assert.equal(wf.status, "cancelled")
  assert.equal(wf.state.fast.status, "completed")
  assert.equal(wf.state.slow.status, "cancelled")
  assert.equal(wf.state.later.status, "cancelled")
  const running = { ...wf, status: "running", state: D.initialState(steps) }
  running.state.slow.status = "running"
  assert.deepEqual(D.cancelAll(running), ["slow"])
})

test("overall status: running until every step finished; cancelled required step wins over failed", () => {
  const { steps } = plan([{ id: "a", prompt: "x" }, { id: "b", prompt: "x" }])
  const wf = { status: "running", steps, state: D.initialState(steps) }
  assert.equal(D.overall(wf), "running")
  wf.state.a.status = "completed"
  wf.state.b.status = "cancelled"
  assert.equal(D.overall(wf), "cancelled")
  wf.state.b.status = "failed"
  assert.equal(D.overall(wf), "failed")
  assert.equal(D.overall({ ...wf, status: "interrupted" }), "interrupted")
})

// ---- prompts and summaries ------------------------------------------------------------------------

test("step prompts fill templates, pass other dependency results, queued messages and the team", () => {
  const { steps } = plan([
    { id: "find", prompt: "find the handlers", title: "Find handlers" },
    { id: "spec", prompt: "read the spec" },
    { id: "fix", prompt: "Fix these: {{steps.find}}", needs: ["find", "spec"] },
  ])
  const wf = { id: "wf_1", name: "fixer", parentSessionID: "ses_p", status: "running", createdAt: 0, steps, state: D.initialState(steps), messages: [] }
  wf.state.find = { id: "find", status: "completed", output: "src/a.ts:10" }
  wf.state.spec = { id: "spec", status: "completed", output: "x".repeat(50) }
  const text = D.stepPrompt({ workflow: wf, step: steps[2], inbox: [{ id: 1, from: "main", to: "fix", text: "keep the API", at: 0, readBy: [] }], messaging: true, maxOutputChars: 20 })
  assert.match(text, /^You are a subagent spawned by another session, working as step "fix"/)
  assert.match(text, /Fix these: src\/a\.ts:10/)
  assert.doesNotMatch(text, /<step id="find"/)
  assert.match(text, /<step id="spec" title="spec" status="completed">/)
  assert.match(text, /characters omitted; full text: workflow action "result" with workflowID wf_1, stepID spec/)
  assert.match(text, /- from main: keep the API/)
  assert.match(text, /Your team: main \(the agent that started this workflow\), find \(general: Find handlers\), spec/)
  assert.doesNotMatch(D.stepPrompt({ workflow: wf, step: steps[2], inbox: [], messaging: false, maxOutputChars: 20 }), /send_message/)
})

test("status and final texts show each step's model and tier; unread messages reach the starter", () => {
  const { steps } = plan([{ id: "s", prompt: "search", agent: "explore", title: 'a "quoted" <title>' }, { id: "r", prompt: "review", needs: ["s"] }])
  const wf = { id: "wf_2", name: "n", parentSessionID: "p", status: "failed", createdAt: 0, steps, state: D.initialState(steps), messages: [] }
  Object.assign(wf.state.s, { status: "completed", model: "anthropic/claude-haiku-4-5", tier: "fast", output: "found" })
  Object.assign(wf.state.r, { status: "failed", model: "anthropic/claude-opus-4-1", tier: "strong", error: "boom" })
  const status = D.statusText(wf)
  assert.match(status, /Workflow wf_2 "n": failed \(2\/2 steps finished\)/)
  assert.match(status, /- s: completed · explore · anthropic\/claude-haiku-4-5 \(fast\)/)
  assert.match(status, /- r: failed · general · anthropic\/claude-opus-4-1 \(strong\) · after s · boom/)
  const final = D.finalText(wf, 4000, [{ id: 3, from: "r", to: "main", text: "need input", at: 0, readBy: [] }])
  assert.match(final, /<workflow id="wf_2" name="n" state="failed">/)
  assert.match(final, /title="a &quot;quoted&quot; &lt;title&gt;"/)
  assert.match(final, /\(step failed: boom\)/)
  assert.match(final, /- from r: need input/)
  assert.equal(D.truncate("abc", 5), "abc")
})

// ---- mailbox --------------------------------------------------------------------------------------

/** Answers a status call the way the plugin does, on a fake clock: statusWait, then re-read every second. */
function statusCall({ checks, slot, look, wait, timeout, clock }) {
  let list = look()
  const live = () => list.some((workflow) => workflow.status === "running")
  const from = D.progressKey(list)
  let key = from
  const plan = D.statusWait({ previous: checks.get(slot), key, live: live(), wait, timeout, now: clock.now })
  let slept = 0
  if (plan)
    while (key === from && live() && clock.now < plan.deadline) {
      clock.now += 1000
      slept++
      list = look()
      key = D.progressKey(list)
    }
  checks.set(slot, { key, at: clock.now })
  const text = plan && key === from ? D.unchangedText(list, clock.now - plan.since, plan.waited) : list.map(D.statusText).join("\n\n")
  return { text, slept }
}

test("status: a repeated check with no change gets the short answer, and back-to-back repeats are slowed", () => {
  const { steps } = plan([{ id: "a", prompt: "x" }, { id: "b", prompt: "y", needs: ["a"] }])
  const wf = { id: "wf_s", name: "w", parentSessionID: "p", status: "running", createdAt: 0, steps, state: D.initialState(steps), messages: [] }
  Object.assign(wf.state.a, { status: "running", startedAt: 1 })
  const clock = { now: 100_000 }
  const checks = new Map()
  const call = (over = {}) => statusCall({ checks, slot: "p:wf_s", look: () => [wf], clock, ...over })
  // The clock is not progress: the same statuses compare equal even though running times grow.
  const key = D.progressKey([wf])
  assert.notEqual(D.stepLine(wf, steps[0]), D.stepLine({ ...wf, state: { ...wf.state, a: { ...wf.state.a, startedAt: 50_000 } } }, steps[0]))
  assert.equal(D.progressKey([{ ...wf, state: { ...wf.state, a: { ...wf.state.a, startedAt: 50_000 } } }]), key)

  const first = call()
  assert.match(first.text, /Workflow wf_s "w": running \(0\/2 steps finished\)/)
  assert.equal(first.slept, 0)
  // Called again right away: waits out the cooldown (10s from the last check), then says so briefly.
  const second = call()
  assert.equal(second.slept, D.STATUS_COOLDOWN_MS / 1000)
  assert.match(second.text, /^No change since your last check 10s ago; still running:\n- wf_s "w": 0\/2 steps finished, running a\n/)
  assert.match(second.text, /notified automatically when a workflow finishes[\s\S]*do not poll[\s\S]*wait: true/)
  assert.doesNotMatch(second.text, /- a: running/)
  // A repeat long after the last check answers at once, still short.
  clock.now += 60_000
  const third = call()
  assert.equal(third.slept, 0)
  assert.match(third.text, /^No change since your last check 60s ago/)
  // Something changed: the full view again.
  Object.assign(wf.state.a, { status: "completed", endedAt: clock.now })
  Object.assign(wf.state.b, { status: "running", startedAt: clock.now })
  assert.match(call().text, /- a: completed/)
  // A new message counts as a change too.
  wf.messages.push({ id: 1, from: "b", to: "main", text: "hi", at: clock.now, readBy: [] })
  assert.match(call().text, /^Workflow wf_s/)
  // Finished workflows never wait and always get the full view.
  wf.status = "completed"
  for (const id of ["b"]) Object.assign(wf.state[id], { status: "completed" })
  const done = call()
  assert.equal(done.slept, 0)
  assert.match(done.text, /^Workflow wf_s "w": completed/)
  assert.match(call().text, /^Workflow wf_s "w": completed/)
})

test("status wait: returns as soon as something changes, or after the timeout with the short answer", () => {
  const { steps } = plan([{ id: "a", prompt: "x" }])
  const make = () => ({ id: "wf_w", name: "w", parentSessionID: "p", status: "running", createdAt: 0, steps, state: D.initialState(steps), messages: [] })
  const clock = { now: 0 }
  // The step finishes on the fourth re-read: the wait returns then, with the full view.
  let wf = make()
  let reads = 0
  const changed = statusCall({ checks: new Map(), slot: "p:wf_w", wait: true, timeout: 60, clock, look: () => {
    if (++reads === 4) Object.assign(wf.state.a, { status: "completed" }), (wf.status = "completed")
    return [wf]
  } })
  assert.equal(changed.slept, 3)
  assert.match(changed.text, /^Workflow wf_w "w": completed/)
  // Nothing changes: it gives up at the timeout and says how long it waited.
  wf = make()
  const quiet = statusCall({ checks: new Map(), slot: "p:wf_w", wait: true, timeout: 5, clock, look: () => [wf] })
  assert.equal(quiet.slept, 5)
  assert.match(quiet.text, /^No change after waiting 5s; still running:/)
  // Limits: default, at most MAX_STATUS_WAIT_SECONDS, at least 1, garbage falls back to the default.
  const wait = (timeout) => D.statusWait({ key: "k", live: true, wait: true, timeout, now: 0 }).deadline / 1000
  assert.equal(wait(undefined), D.DEFAULT_STATUS_WAIT_SECONDS)
  assert.equal(wait(10_000), D.MAX_STATUS_WAIT_SECONDS)
  assert.equal(wait(0), 1)
  assert.equal(wait(Number.NaN), D.DEFAULT_STATUS_WAIT_SECONDS)
  // A finished workflow never blocks, even with wait: true.
  assert.equal(D.statusWait({ key: "k", live: false, wait: true, now: 0 }), undefined)
  assert.equal(D.statusWait({ previous: { key: "k", at: 0 }, key: "k", live: false, now: 0 }), undefined)
  assert.equal(D.statusWait({ previous: { key: "old", at: 0 }, key: "k", live: true, now: 0 }), undefined)
})

test("plugin: /goal sees running workflows, step ends and messages for main; status discourages polling", async () => {
  const source = await readFile(new URL("./plugin.ts", import.meta.url), "utf8")
  // The registry source: this session's background workflows (a waiting start blocks its own turn).
  assert.match(source, /Background\.register\(\(sessionID\) =>\n\s+\[\.\.\.runs\.values\(\)\]\n\s+\.filter\(\(run\) => run\.wf\.parentSessionID === sessionID && !run\.finalized && !run\.waiter\)/)
  // A message for an idle main is kept unread (unchanged) and wakes a holding goal.
  assert.match(source, /if \(recipient === M\.MAIN\)\n\s+Background\.signal\(run\.wf\.parentSessionID, "wake", `workflow step \$\{sent\.from\} sent you a message \(read_messages\)`\)\n\s+continue/)
  // A step end is progress, or a wake when the user asked for per-step notifications.
  assert.match(source, /\} else \{\n\s+\/\/ .*\n\s+Background\.signal\(\n\s+run\.wf\.parentSessionID,\n\s+run\.settings\.notify === "each" \? "wake" : "progress",/)
  // status and list go through the polling-aware answer; start counts as the first check.
  assert.match(source, /if \(input\.action === "list" \|\| input\.action === "status"\) return yield\* status\(sessionID, input\)/)
  assert.match(source, /const plan = D\.statusWait\(\{ previous: checks\.get\(slot\), key, live: live\(\), wait: input\.action === "status" && input\.wait === true, timeout: input\.timeout, now: Date\.now\(\) \}\)/)
  assert.match(source, /if \(plan && key === from\) return D\.unchangedText\(list, Date\.now\(\) - plan\.since, plan\.waited\)/)
  assert.match(source, /checks\.set\(`\$\{context\.sessionID\}:\$\{workflow\.id\}`, \{ key: D\.progressKey\(\[workflow\]\), at: Date\.now\(\) \}\)/)
  assert.match(source, /timeout: Schema\.optionalKey\(Schema\.Number\)/)
  // The guidance: start, keep working or end the turn, check only for a reason.
  const guidance = source.slice(source.indexOf("export const GUIDANCE"), source.indexOf("const Step ="))
  assert.match(guidance, /end your turn/)
  assert.match(guidance, /that notification wakes you, also under \/goal/)
  assert.match(guidance, /Do not poll/)
  assert.match(guidance, /Check status only for a reason: the user asks, it has been silent far longer than its steps should take, or you need one step's result early/)
  assert.match(guidance, /wait: true blocks once until something changes/)
})

test("mailbox: scoped to members, direct and broadcast delivery, read tracking and limits", () => {
  const box = { messages: [] }
  const members = ["main", "a", "b", "c"]
  const first = M.send(box, { from: "a", to: "b", text: " hello ", members, now: 5 })
  assert.deepEqual(first, { id: 1, from: "a", to: "b", text: "hello", at: 5, readBy: [] })
  M.send(box, { from: "main", to: "all", text: "status?", members })
  assert.deepEqual(M.recipients(box.messages[1], members), ["a", "b", "c"])
  assert.deepEqual(M.unread(box, "b", members).map((m) => m.id), [1, 2])
  assert.deepEqual(M.take(box, "b", members).map((m) => m.id), [1, 2])
  assert.deepEqual(M.take(box, "b", members), [])
  assert.deepEqual(M.unread(box, "a", members).map((m) => m.id), [2])
  assert.deepEqual(M.unread(box, "main", members), [])
  assert.deepEqual(M.conversation(box, "a", members).map((m) => m.id), [1, 2])
  assert.match(M.format(box.messages.slice(0, 1)), /^#1 from a to b: hello$/)

  assert.throws(() => M.send(box, { from: "x", to: "a", text: "t", members }), /not a member/)
  assert.throws(() => M.send(box, { from: "a", to: "outsider", text: "t", members }), /Unknown recipient "outsider"/)
  assert.throws(() => M.send(box, { from: "a", to: "a", text: "t", members }), /yourself/)
  assert.throws(() => M.send(box, { from: "a", to: "b", text: "  ", members }), /empty/)
  assert.throws(() => M.send(box, { from: "a", to: "b", text: "toolong", members }, { maxMessages: 9, maxChars: 3 }), /longer than 3/)
  assert.throws(() => M.send(box, { from: "a", to: "b", text: "x", members }, { maxMessages: 2, maxChars: 100 }), /limit of 2 messages/)
})

// ---- model choice ---------------------------------------------------------------------------------

const policy = S.normalize({})
const model = (providerID, id, outputCost, extra = {}) => ({ providerID, id, family: extra.family, status: "active", released: extra.released ?? 0, outputCost, tools: true, text: true, variants: extra.variants ?? [], ...extra })
const available = [
  model("anthropic", "claude-haiku-4-5", 5, { family: "claude-haiku", released: 3, variants: ["low", "high"] }),
  model("anthropic", "claude-sonnet-4-5", 15, { family: "claude-sonnet", released: 3, variants: ["high"] }),
  model("anthropic", "claude-opus-4-1", 75, { family: "claude-opus", released: 2 }),
  model("anthropic", "claude-opus-4-5", 25, { family: "claude-opus", released: 4 }),
  model("anthropic", "claude-3-opus", 75, { family: "claude-3-opus", released: 1, status: "deprecated" }),
  model("anthropic", "embed", 0, { tools: false }),
  model("openai", "gpt-5", 10, { family: "gpt" }),
]
const parent = { providerID: "anthropic", id: "claude-sonnet-4-5" }
const small = available[0]
const choose = (step, extra = {}) => Models.chooseModel({ step: { title: step.title ?? step.id ?? "", prompt: step.prompt ?? "", agent: step.agent ?? "general", kind: step.kind, model: step.model }, policy, parent, available, small, ...extra })

test("classify: explicit kind, then the agent's tier, then keywords in the title before the prompt", () => {
  assert.deepEqual(Models.classify({ title: "x", prompt: "y", agent: "general", kind: "review" }, policy), { kind: "review", tier: "strong", source: "kind" })
  assert.equal(Models.classify({ title: "find bugs", prompt: "", agent: "reviewer" }, policy).tier, "strong")
  assert.equal(Models.classify({ title: "Review the diff", prompt: "", agent: "explore" }, policy).tier, "fast")
  assert.deepEqual(Models.classify({ title: "Search usages", prompt: "implement nothing", agent: "general" }, policy), { kind: "search", tier: "fast", source: "keywords" })
  assert.equal(Models.classify({ title: "Plan the migration", prompt: "", agent: "general" }, policy).tier, "strong")
  assert.equal(Models.classify({ title: "step-3", prompt: "Summarize the logs", agent: "general" }, policy).kind, "summarize")
  assert.equal(Models.classify({ title: "Implement login", prompt: "plan carefully", agent: "general" }, policy).tier, "default")
  assert.deepEqual(Models.classify({ title: "xyz", prompt: "qq", agent: "custom" }, policy), { kind: "other", tier: "default", source: "default" })
})

test("chooseModel: fast uses the provider's small model at its lowest reasoning variant", () => {
  const choice = choose({ id: "s", agent: "explore", prompt: "find the config loader" })
  assert.deepEqual(choice.ref, { providerID: "anthropic", id: "claude-haiku-4-5", variant: "low" })
  assert.equal(choice.tier, "fast")
  assert.match(choice.reason, /fast \(agent explore\): anthropic's small model/)
  assert.deepEqual(choose({ id: "s", agent: "explore" }, { small: undefined }).ref, parent)
})

test("chooseModel: strong picks the newest top model of the caller's provider within the price ceiling", () => {
  const choice = choose({ id: "r", agent: "reviewer", prompt: "review" })
  // claude-opus-4-1 (75) is older than claude-opus-4-5 in the same family; the deprecated and tool-less ones never count.
  assert.deepEqual(choice.ref, { providerID: "anthropic", id: "claude-opus-4-5" })
  assert.match(choice.reason, /strongest available anthropic model/)
  // A ceiling of 1x the caller's price keeps the caller's model.
  const capped = Models.chooseModel({ step: { title: "plan", prompt: "", agent: "general" }, policy: S.normalize({ models: { strongMaxCostRatio: 1 } }), parent, available, small })
  assert.deepEqual(capped.ref, parent)
  assert.match(capped.reason, /already the strongest/)
  // No pricing for the caller: never pick a pricier model blindly.
  assert.deepEqual(Models.strongest(available, { providerID: "anthropic", id: "unknown" }, 4).ref, { providerID: "anthropic", id: "unknown" })
  assert.deepEqual(Models.strongest(available, { providerID: "anthropic", id: "claude-opus-4-5" }, 4).ref, { providerID: "anthropic", id: "claude-opus-4-5" })
})

test("chooseModel: default inherits; explicit models and tiers win; the agent's configured model beats automatic", () => {
  assert.deepEqual(choose({ id: "i", prompt: "implement the endpoint" }).ref, parent)
  assert.deepEqual(choose({ id: "x", model: "openai/gpt-5" }), { ref: { providerID: "openai", id: "gpt-5" }, tier: "default", kind: "other", reason: "requested model" })
  assert.deepEqual(choose({ id: "x", model: "anthropic/claude-sonnet-4-5#high" }).ref, { providerID: "anthropic", id: "claude-sonnet-4-5", variant: "high" })
  assert.match(choose({ id: "x", model: "anthropic/nope" }).error, /not available/)
  assert.match(choose({ id: "x", model: "anthropic/claude-opus-4-5#max" }).error, /has no variants/)
  assert.match(choose({ id: "x", model: "anthropic/claude-sonnet-4-5#max" }).error, /Available: high/)
  assert.match(choose({ id: "x", model: "nonsense" }).error, /Or use a tier/)
  assert.equal(choose({ id: "x", model: "strong", agent: "explore" }).ref.id, "claude-opus-4-5")
  assert.equal(choose({ id: "x", model: "fast", agent: "reviewer" }).ref.id, "claude-haiku-4-5")
  const agentModel = { providerID: "openai", id: "gpt-5" }
  assert.deepEqual(choose({ id: "r", agent: "reviewer" }, { agentModel }).ref, agentModel)
  // An explicit request still wins over the agent's model.
  assert.equal(choose({ id: "r", agent: "reviewer", model: "fast" }, { agentModel }).ref.id, "claude-haiku-4-5")
})

test("chooseModel: configured tier models are used when available and fall back when they are not", () => {
  const pinned = S.normalize({ models: { fast: "openai/gpt-5", strong: "anthropic/gone", default: "openai/gpt-5" } })
  const run = (step) => Models.chooseModel({ step: { title: "", prompt: "", agent: "general", ...step }, policy: pinned, parent, available, small })
  assert.deepEqual(run({ kind: "search" }).ref, { providerID: "openai", id: "gpt-5" })
  assert.equal(run({ kind: "review" }).ref.id, "claude-opus-4-5")
  assert.deepEqual(run({ kind: "implement" }).ref, { providerID: "openai", id: "gpt-5" })
  const inherit = S.normalize({ models: { fast: "inherit", strong: "inherit" } })
  assert.deepEqual(Models.chooseModel({ step: { title: "", prompt: "", agent: "explore" }, policy: inherit, parent, available, small }).ref, parent)
  // No caller model at all: the session default.
  const none = Models.chooseModel({ step: { title: "", prompt: "", agent: "reviewer" }, policy, available, small })
  assert.equal(none.ref, undefined)
  assert.match(none.reason, /session default/)
})

test("parseRef and formatRef round-trip and reject malformed references", () => {
  assert.deepEqual(Models.parseRef("p/m#v"), { providerID: "p", id: "m", variant: "v" })
  assert.equal(Models.formatRef(Models.parseRef("p/a/b")), "p/a/b")
  for (const bad of ["nomodel", "/m", "p/", "p/m#", "p#x/m", "p/m#a#b"]) assert.throws(() => Models.parseRef(bad), /Invalid model/, bad)
})

// ---- settings and store ---------------------------------------------------------------------------

test("settings: defaults, field-by-field fallback, build default, explicit file value wins", () => {
  assert.equal(S.normalize(undefined).enabled, false)
  assert.equal(S.normalize(undefined, true).enabled, true)
  assert.equal(S.normalize({ enabled: false }, true).enabled, false)
  const odd = S.normalize({ enabled: "yes", maxParallel: 99, notify: "x", models: { fast: "bad model", strong: "anthropic/x", default: "auto", strongMaxCostRatio: 0 }, agents: { custom: "strong", explore: "bogus" }, kinds: { review: "fast", search: "nope" } })
  assert.equal(odd.enabled, false)
  assert.equal(odd.maxParallel, S.DEFAULTS.maxParallel)
  assert.equal(odd.notify, "end")
  assert.deepEqual(odd.models, { fast: "auto", strong: "anthropic/x", default: "inherit", strongMaxCostRatio: 4 })
  assert.equal(odd.agents.custom, "strong")
  assert.equal(odd.agents.explore, "fast")
  assert.equal(odd.kinds.review, "fast")
  assert.equal(odd.kinds.search, "fast")
  assert.match(S.summary(S.normalize({ enabled: true })), /^on · fast auto · strong auto · 5 parallel$/)
})

test("settings changes keep other keys and validate input", () => {
  assert.deepEqual(S.applyChange({ x: 1 }, "enabled", "on"), { next: { x: 1, enabled: true } })
  assert.deepEqual(S.applyChange(undefined, "models.fast", "openai/gpt-5-mini"), { next: { models: { fast: "openai/gpt-5-mini" } } })
  assert.deepEqual(S.applyChange({ models: { fast: "auto" } }, "models.strong", "inherit"), { next: { models: { fast: "auto", strong: "inherit" } } })
  assert.match(S.applyChange({}, "models.default", "auto").error, /inherit or provider\/model/)
  assert.match(S.applyChange({}, "maxParallel", "0").error, /1–8/)
  assert.match(S.applyChange({}, "enabled", "maybe").error, /on or off/)
  assert.match(S.applyChange({}, "nope", "1").error, /Unknown/)
})

test("store: workflow files, cancel markers, settings file and the startup sweep", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "infiniteoc-workflows-"))
  const saved = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, INFINITEOC_SETTINGS_FILE: process.env.INFINITEOC_SETTINGS_FILE }
  process.env.XDG_DATA_HOME = path.join(dir, "data")
  process.env.INFINITEOC_SETTINGS_FILE = path.join(dir, "settings.json")
  try {
    assert.equal(Store.readSettings().enabled, false)
    await writeFile(process.env.INFINITEOC_SETTINGS_FILE, JSON.stringify({ traffic: { mode: "tor" }, providers: { p: {} }, workflows: { maxParallel: 2 } }))
    const changed = Store.changeSetting("enabled", "on")
    assert.equal(changed.settings.enabled, true)
    const file = JSON.parse(await readFile(process.env.INFINITEOC_SETTINGS_FILE, "utf8"))
    assert.deepEqual(file, { traffic: { mode: "tor" }, providers: { p: {} }, workflows: { maxParallel: 2, enabled: true } })
    assert.equal(Store.readSettings().maxParallel, 2)
    assert.match(Store.changeSetting("maxParallel", "x").error, /1–8/)
    await writeFile(process.env.INFINITEOC_SETTINGS_FILE, "{ // jsonc\n}")
    assert.match(Store.changeSetting("enabled", "off").error, /not strict JSON/)
    assert.equal(await readFile(process.env.INFINITEOC_SETTINGS_FILE, "utf8"), "{ // jsonc\n}")

    const { steps } = plan([{ id: "a", prompt: "x" }])
    const base = { name: "n", status: "running", steps, state: D.initialState(steps), messages: [] }
    Store.saveWorkflow({ ...base, id: "wf_live", parentSessionID: "ses_1", createdAt: 3, pid: process.pid })
    Store.saveWorkflow({ ...base, id: "wf_dead", parentSessionID: "ses_1", createdAt: 2, pid: 2 ** 22 + 12345, state: { a: { id: "a", status: "running" } } })
    Store.saveWorkflow({ ...base, id: "wf_old", parentSessionID: "ses_2", createdAt: 1, status: "completed", endedAt: 1 })
    assert.deepEqual(Store.listWorkflows("ses_1").map((w) => w.id), ["wf_live", "wf_dead"])
    assert.deepEqual(Store.listWorkflows().map((w) => w.id), ["wf_live", "wf_dead", "wf_old"])
    assert.equal(Store.loadWorkflow("ses_2", "wf_old").status, "completed")
    assert.throws(() => Store.workflowFile("../x", "wf"), /Invalid id/)

    assert.equal(Store.cancelRequested("ses_1", "wf_live"), false)
    Store.requestCancel("ses_1", "wf_live")
    assert.equal(Store.cancelRequested("ses_1", "wf_live"), true)
    Store.clearCancel("ses_1", "wf_live")
    assert.equal(Store.cancelRequested("ses_1", "wf_live"), false)

    Store.sweep(1000, 10_000)
    assert.equal(Store.loadWorkflow("ses_1", "wf_live").status, "running")
    const dead = Store.loadWorkflow("ses_1", "wf_dead")
    assert.equal(dead.status, "interrupted")
    assert.equal(dead.state.a.status, "cancelled")
    assert.equal(Store.loadWorkflow("ses_2", "wf_old"), undefined)
    assert.equal(existsSync(path.join(process.env.XDG_DATA_HOME, "infiniteoc", "workflows", "ses_2")), false)
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value)
    await rm(dir, { recursive: true, force: true })
  }
})

test("plugin keeps upstream's permission model: same check and visibility as subagent, no widened session rules", async () => {
  const source = await readFile(new URL("./plugin.ts", import.meta.url), "utf8")
  // Hidden from agents whose rules deny spawning subagents (general, explore, reviewer, researcher).
  assert.match(source, /name: TOOL,\n\s+\/\/ .*\n\s+options: \{ codemode: false, permission: "subagent" \}/)
  // Every step's agent passes the subagent permission check from the calling session before anything runs.
  assert.match(source, /permission\s*\n?\s*\.assert\(\{\s*action: "subagent",\s*resources: \[agent\.id\]/)
  assert.match(source, /if \(agent\.mode === "primary"\) return yield\* failure/)
  assert.match(source, /subagent_depth \?\? 1/)
  // Child sessions get the step's agent and never extra permission rules.
  const create = source.slice(source.indexOf("sessions.create({"), source.indexOf("state.sessionID = child.id"))
  assert.match(create, /agent: Agent\.ID\.make\(step\.agent\)/)
  assert.doesNotMatch(create, /permissions/)
  assert.doesNotMatch(source, /setPermissions/)
  // The flag gates the tool and its guidance on every request; messaging stays inside one workflow.
  assert.match(source, /if \(!current\.enabled\) delete event\.tools\[TOOL\]/)
  assert.match(source, /if \(!current\.enabled\)\n\s+return yield\* failure\('Workflows are turned off/)
  assert.match(source, /event\.system\.push\(SystemPart\.make\(GUIDANCE\)\)/)
  assert.match(source, /run\.wf\.parentSessionID === sessionID && !run\.finalized/)
  // Steering into a session never wakes it; only the final notification does (like a background subagent).
  assert.match(source, /metadata: \{ source: "workflow" \}, resume: false \}/)
  // Interruptions stop the steps (they run as process-wide jobs) instead of orphaning them.
  assert.match(source, /Effect\.onInterrupt\(\(\) => cancel\(run, "the starting agent was interrupted"\)\)/)
  assert.match(source, /const running = D\.cancelAll\(run\.wf, Date\.now\(\), "interrupted"\)\n\s+run\.wf\.status = "interrupted"\n\s+for \(const other of running\) yield\* stopSession/)
  assert.match(source, /if \(state\.status !== "pending"\) continue/)
  // Compaction and side generations get the same guidance, so their prompt prefix (and cache) matches.
  assert.doesNotMatch(source, /kind === "context"/)
  for (const kind of ["context", "compaction", "generate"]) assert.match(source, new RegExp(`ctx\\.session\\.hook\\("${kind}", hook\\)`))
})

test("flag.mjs: other mods read and flip workflows.enabled without touching other keys", async () => {
  const { readWorkflowsEnabled, setWorkflowsEnabled } = await import("./flag.mjs")
  const dir = await mkdtemp(path.join(tmpdir(), "infiniteoc-wf-flag-"))
  const env = { INFINITEOC_SETTINGS_FILE: path.join(dir, "nested", "settings.json") }
  const previous = process.env.INFINITEOC_SETTINGS_FILE
  try {
    assert.equal(readWorkflowsEnabled(env), undefined)
    assert.equal(setWorkflowsEnabled(true, env), true)
    assert.equal(readWorkflowsEnabled(env), true)
    await writeFile(env.INFINITEOC_SETTINGS_FILE, JSON.stringify({ updates: { mode: "ask" }, workflows: { enabled: true, maxParallel: 2 } }))
    setWorkflowsEnabled(false, env)
    assert.deepEqual(JSON.parse(await readFile(env.INFINITEOC_SETTINGS_FILE, "utf8")), { updates: { mode: "ask" }, workflows: { enabled: false, maxParallel: 2 } })
    // The TypeScript reader sees the same value.
    process.env.INFINITEOC_SETTINGS_FILE = env.INFINITEOC_SETTINGS_FILE
    assert.equal(Store.readSettings(true).enabled, false)
    assert.throws(() => setWorkflowsEnabled("on", env), /boolean/)
    await writeFile(env.INFINITEOC_SETTINGS_FILE, "// jsonc\n{}")
    assert.throws(() => setWorkflowsEnabled(true, env), /not strict JSON/)
    assert.equal(readWorkflowsEnabled(env), undefined)
  } finally {
    previous === undefined ? delete process.env.INFINITEOC_SETTINGS_FILE : (process.env.INFINITEOC_SETTINGS_FILE = previous)
    await rm(dir, { recursive: true, force: true })
  }
})

test("a second subagent call in one message gets a workflow nudge, at most twice per session", () => {
  const seen = new Map()
  assert.equal(D.subagentNudge(seen, "s1", "m1"), undefined)
  assert.match(D.subagentNudge(seen, "s1", "m1"), /one workflow call/)
  // A third call in the same message is not nudged again.
  assert.equal(D.subagentNudge(seen, "s1", "m1"), undefined)
  // One subagent per message is fine.
  assert.equal(D.subagentNudge(seen, "s1", "m2"), undefined)
  // Another session counts on its own.
  assert.equal(D.subagentNudge(seen, "s2", "m1"), undefined)
  assert.match(D.subagentNudge(seen, "s2", "m1"), /workflow/)
  // The second nudge in s1 is the last one.
  D.subagentNudge(seen, "s1", "m3")
  assert.match(D.subagentNudge(seen, "s1", "m3"), /workflow/)
  D.subagentNudge(seen, "s1", "m4")
  assert.equal(D.subagentNudge(seen, "s1", "m4"), undefined)
  assert.equal(D.NUDGE_LIMIT, 2)
  // The map stays bounded.
  for (let i = 0; i < 600; i++) D.subagentNudge(seen, `x${i}`, "m")
  assert.ok(seen.size <= 500)
})

test("the plugin wires the nudge to completed subagent calls and the guidance routes 2+ tasks to workflows", async () => {
  const source = await readFile(new URL("./plugin.ts", import.meta.url), "utf8")
  assert.match(source, /ctx\.tool\.hook\("execute\.after"[\s\S]*event\.tool !== "subagent" \|\| event\.status !== "completed" \|\| !settings\(\)\.enabled/)
  assert.match(source, /D\.subagentNudge\(nudges, event\.sessionID, event\.messageID\)/)
  const guidance = source.slice(source.indexOf("export const GUIDANCE"), source.indexOf("const Step ="))
  assert.match(guidance, /two or more subagent calls/)
  assert.match(guidance, /wait: true: the results come back in that call/)
  const { guidance: main } = await import("../infiniteoc/workflow.mjs")
  assert.match(main.build.split("[Subagents]")[1], /Two or more tasks, or a task plus its review: one workflow call/)
})
