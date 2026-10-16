import test from "node:test"
import assert from "node:assert/strict"
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import mod from "./index.mjs"
import { guidance } from "./workflow.mjs"

test("build guidance keeps delegation bounded and never grants permissions", () => {
  for (const phrase of ["nothing here grants tool access", "never two writers on the same file", "keep dependent steps sequential", "re-run the checks yourself", "a subagent's claim is not proof", "Ask before destructive"]) {
    assert.ok(guidance.build.includes(phrase), `Missing workflow guard: ${phrase}`)
  }
})

const root = path.resolve(import.meta.dirname, "../../.upstream")
async function apply(reducedMotion = false, files = new Map()) {
  await mod.setup({
    root,
    options: { reducedMotion },
    async patch(file, transform) {
      const original = files.get(file) ?? await readFile(path.join(root, file), "utf8")
      files.set(file, await transform(original))
    },
    async write(file, content) { files.set(file, content) },
  })
  return files
}

test("applies against local source, preserving all permission-rule code", async () => {
  const files = await apply()
  assert.equal(files.size, 40)
  assert.equal(files.get("packages/core/src/infiniteoc/background.ts"), await readFile(new URL("./background.ts", import.meta.url), "utf8"))
  const file = "packages/core/src/plugin/agent.ts"
  const original = await readFile(path.join(root, file), "utf8")
  const rules = (source) => source.split("\n").filter((line) => /\.permissions|action:|resource:|effect:|Permission\.merge/.test(line))
  // Upstream rules are untouched; the only new rules are the InfiniteOC subagents' own.
  const [before, rest] = files.get(file).split("      // InfiniteOC subagents;")
  const block = rest.split('      editor.update(Agent.ID.make("compaction")')[0]
  assert.deepEqual(rules(before + rest.slice(block.length)), rules(original))
  for (const line of rules(block).filter((line) => line.includes('effect: "allow"')))
    assert.match(line, /action: "(read|grep|glob|webfetch|websearch|skill)"/, line)
  assert.match(block, /Agent\.ID\.make\("reviewer"\)[\s\S]*action: "edit", resource: "\*", effect: "deny"/)
  assert.match(files.get(file), /Agent\.Name\.make\("InfiniteOC"\)/)
  assert.match(files.get(file), /editor\.update\(Agent\.defaultID/)
  for (const target of ["packages/core/src/plugin/plan.ts", "packages/core/src/config/plugin/agent.ts"]) {
    assert.deepEqual(rules(files.get(target)), rules(await readFile(path.join(root, target), "utf8")))
  }
  assert.match(files.get("packages/core/src/plugin/plan.ts"), /item\.hidden = true/)
  const config = files.get("packages/core/src/config/plugin/agent.ts")
  // Guidance never replaces the system prompt; it is appended per agent through session context.
  assert.doesNotMatch(config.split("// InfiniteOC finalizes presentation")[1], /\.system/)
  const guidanceFile = files.get("packages/core/src/infiniteoc/guidance.ts")
  assert.match(guidanceFile, /\/\/ infiniteoc:guidance-extensions\n$/)
  for (const agent of ["build", "general", "explore", "reviewer", "researcher"]) assert.ok(guidanceFile.includes(`"${agent}": [`), agent)
  const context = files.get("packages/core/src/session/context.ts")
  assert.match(context, /import \{ infiniteocGuidance \} from "\.\.\/infiniteoc\/guidance\.js"/)
  assert.match(context, /Instructions\.Key\.make\("infiniteoc\/guidance"\)[\s\S]*infiniteocGuidance\[agent\.id\]/)
  assert.match(files.get("packages/core/src/config/plugin/skill.ts"), /if \(process\.env\.INFINITEOC_SKILLS\) add\(Skill\.DirectorySource\.make/)
  assert.match(files.get("packages/core/src/plugin/internal.ts"), /import \* as InfiniteocGoal from "\.\/infiniteoc-goal\.js"[\s\S]*PlanPlugin\.Plugin,\n  InfiniteocGoal\.Plugin,\n  InfiniteocFrontend\.Plugin,\n  InfiniteocPonytail\.Plugin,/)
  assert.match(files.get("packages/core/src/config/plugin/instruction.ts"), /targets: \["AGENTS\.md", "CLAUDE\.md"\][\s\S]*!found\.includes\(join\(dirname\(file\), "AGENTS\.md"\)\)/)
  assert.match(files.get("packages/core/src/instructions/builtins.ts"), /OS: \$\{osType\(\)\} \$\{release\(\)\}/)
  assert.match(files.get("packages/core/src/tool/plugin/subagent.ts"), /agent\.id === "explore"[\s\S]*models\.small\(parent\.model\.providerID\)[\s\S]*const model = override \?\? agent\.model \?\? fast \?\? parent\.model/)
  assert.match(files.get("packages/core/src/plugin/agent.ts"), /Agent\.ID\.make\("explore"\), \(item\) => \{\n        item\.steps = 30/)
  assert.match(files.get("packages/tui/src/plugin/builtins.ts"), /  PromptBtw,\n  PromptGoal,/)
  assert.match(config, /agent\.hidden = true/)
  assert.match(config, /editor.default\(Agent.defaultID\)/)
  assert.match(config, /current.id !== Agent.defaultID && current.mode !== "subagent"/)
  // The agent color comes from the theme (readable in light mode) and user config is respected.
  assert.doesNotMatch(config, /Agent\.Color\.make\("#c084fc"\)/)
  assert.match(files.get("packages/tui/src/component/prompt/index.tsx"), /agentLabel: agent \? agent.name : undefined/)
  assert.match(files.get("packages/tui/src/component/dialog-agent.tsx"), /title: item.name/)
  assert.match(files.get("packages/tui/src/mini/footer.command.tsx"), /display: agent.name/)
  assert.match(files.get("packages/tui/src/context/theme.tsx"), /config.theme.name === "opencode" \? "infiniteoc" : config.theme.name/)
  const theme = JSON.parse(files.get("packages/tui/src/theme/assets/v2/infiniteoc.json"))
  assert.equal(theme.dark.hue.interactive, "$hue.purple")
  assert.equal(theme.light.hue.accent, "$hue.pink")
  assert.equal(theme.light.text.feedback.warning.base, "#a16207")
  const upstreamTheme = JSON.parse(await readFile(path.join(root, "packages/tui/src/theme/assets/v2/opencode.json"), "utf8"))
  for (const mode of ["light", "dark"]) {
    assert.deepEqual(theme[mode].hue.red, upstreamTheme[mode].hue.red)
    assert.deepEqual(theme[mode].hue.green, upstreamTheme[mode].hue.green)
  }
  const again = await apply(false, new Map(files))
  assert.deepEqual(again, files)
})

test("reduced motion disables animation and cleanup exists", async () => {
  const logo = (await apply(true)).get("packages/tui/src/component/logo.tsx")
  // reducedMotion only sets the default of the one runtime Animations switch.
  const files = await apply(true)
  assert.match(files.get("packages/tui/src/config/index.tsx"), /animations: input\.animations \?\? false,/)
  assert.match((await apply(false)).get("packages/tui/src/config/index.tsx"), /animations: input\.animations \?\? true,/)
  assert.match(logo, /motion=\{config\.animations \?\? true\}/)
  assert.match(logo, /Math\.min\(deltaTime, 50\)/)
  assert.match(logo, /wrapMode="none"/) // art must clip, never word-wrap into scrambled half-blocks
  assert.doesNotMatch(logo, /setTimeout|setInterval/) // one intro per process, an idle Home never animates
  assert.match(logo, /if \(value && !introPlayed\)/)
})

test("wordmark data and resume hints point at InfiniteOC", async () => {
  const files = await apply()
  const data = files.get("packages/tui/src/logo.ts")
  assert.match(data, /export const go = \{/) // short mark used by the mini splash is untouched
  const { logo } = await import(`data:text/javascript,${encodeURIComponent(data)}`)
  for (const word of [logo.left, logo.right]) {
    assert.equal(word.length, 4)
    assert.equal(new Set(word.map(line => [...line].length)).size, 1)
  }
  assert.ok([...logo.left[0]].length + 1 + [...logo.right[0]].length < 44, "fits the upstream wide-logo breakpoint")
  assert.match(files.get("packages/tui/src/util/presentation.ts"), /infiniteoc -s \$\{input\.sessionID\}/)
  assert.match(files.get("packages/tui/src/mini/splash.ts"), /`infiniteoc mini -s \$\{meta\.session_id\}`/)
  const toast = files.get("packages/tui/src/ui/toast.tsx")
  assert.equal(toast.match(/<FadeInText /g).length, 3)
  assert.match(toast, /<Show when=\{toast\.currentToast\} keyed>/)
  assert.match(toast, /toast=\{current\}/)
  // Solid store sets merge objects: clear first so a replacement cannot inherit title/action.
  assert.match(toast, /setStore\("currentToast", null\)\n      setStore\("currentToast", toastOptions\)/)
  assert.match(toast, /setStore\("currentToast", null\)\n    if \(next\) setStore\("currentToast", next\)/)
  assert.match(files.get("packages/tui/src/feature-plugins/system/stats.tsx"), /infiniteoc \/ stats/)
  const updater = files.get("packages/cli/src/services/updater.ts")
  assert.equal(updater.match(/if \(OPENCODE_CHANNEL === "infiniteoc"\)/g).length, 3) // inspect, check, upgrade
  assert.match(updater, /return yield\* Effect\.fail\(new Error\(INFINITEOC_PINNED\)\)/)
  assert.match(files.get("packages/cli/src/commands/handlers/uninstall.ts"), /if \(OPENCODE_CHANNEL === "infiniteoc"\) return yield\* Effect\.fail/)
  assert.equal(JSON.parse(files.get("packages/tui/src/theme/assets/v2/infiniteoc.json")).dark.categorical[0], "purple")
  assert.match(files.get("packages/tui/src/routes/session/index.tsx"), /\?\.name \?\? Locale\.titlecase\(props\.message\.agent\)/)
  assert.equal(files.get("packages/tui/src/app.tsx").match(/setTerminalTitle\("InfiniteOC"\)/g).length, 2)
  const dialog = files.get("packages/tui/src/ui/dialog.tsx")
  assert.match(dialog, /enabled: \(\) => config\.data\.animations \?\? true, transition: tween\(\{ duration: 0\.12 \}\)/)
  assert.match(dialog, /RGBA\.fromInts\(0, 0, 0, Math\.round\(dim\.value\(\)\.alpha\)\)/)
})

test("configured Quick default resolves to one visible InfiniteOC primary without changing permissions", async () => {
  const files = await apply()
  const source = files.get("packages/core/src/config/plugin/agent.ts")
  const block = source.split("// InfiniteOC finalizes presentation after config; never change permission rules.")[1].split("\n    })")[0]
  const agents = [
    { id: "build", name: "Build", mode: "primary", hidden: false, system: "Custom prompt", permissions: [{ action: "edit", effect: "ask" }] },
    { id: "quick", name: "Quick", mode: "primary", hidden: false, permissions: [{ action: "bash", effect: "deny" }] },
    { id: "plan", name: "Plan", mode: "primary", hidden: false, permissions: [{ action: "edit", effect: "deny" }] },
    { id: "explore", name: "Explore", mode: "subagent", hidden: false, permissions: [] },
  ]
  const before = structuredClone(agents.map(agent => agent.permissions))
  let selected = "quick"
  const editor = {
    get: id => agents.find(agent => agent.id === id),
    update: (id, transform) => transform(agents.find(agent => agent.id === id)),
    list: () => agents,
    default: id => { selected = id },
  }
  const Agent = { defaultID: "build", Name: { make: value => value }, ID: { make: value => value }, Color: { make: value => value } }
  const finalize = new Function("editor", "Agent", block)
  finalize(editor, Agent)
  assert.equal(selected, "build")
  assert.equal(agents[0].color, undefined)
  assert.deepEqual(agents.filter(agent => agent.mode !== "subagent" && !agent.hidden).map(agent => agent.name), ["InfiniteOC"])
  assert.equal(agents.find(agent => agent.id === "explore").hidden, false)
  assert.deepEqual(agents.map(agent => agent.permissions), before)
  // A user's custom prompt is left exactly as configured; none is added when absent.
  assert.equal(agents[0].system, "Custom prompt")
  finalize(editor, Agent)
  assert.equal(agents[0].system, "Custom prompt")
  assert.equal(agents[1].system, undefined)
})
test("/goal keeps going until verified, pauses (not kills) on interrupt, and auto-resumes on the next message", async (t) => {
  // decide() is pure; load it without the plugin runtime by dropping imports and the Plugin export.
  const source = await readFile(new URL("./goal.ts", import.meta.url), "utf8")
  const dir = await mkdtemp(path.join(tmpdir(), "goal-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "goal.ts"), source.split("export const Plugin")[0].replace(/^import .*$/gm, ""))
  const { decide, resumeDecision, startText, continueText, verifyText, MAX_CONTINUATIONS } = await import(path.join(dir, "goal.ts"))
  const user = (text) => ({ type: "user", text })
  const synthetic = (text) => ({ type: "synthetic", text })
  const reply = (text) => ({ type: "assistant", content: [{ type: "text", text }] })
  const idle = (outcome = "succeeded") => ({ type: "idle", outcome })
  const goal = "make tests pass"
  const start = user(startText(goal))

  assert.deepEqual(decide([user("hi"), reply("hello"), idle()]), { action: "none" })
  assert.deepEqual(decide([start]), { action: "none" }) // no reply yet
  assert.deepEqual(decide([start, reply("working"), idle()]), { action: "continue", goal, turn: 1 })
  assert.deepEqual(decide([start, reply("x"), idle(), synthetic(continueText(goal, 1))]), { action: "none" })
  assert.deepEqual(decide([start, reply("x"), idle(), synthetic(continueText(goal, 1)), reply("y"), idle()]), { action: "continue", goal, turn: 2 })
  assert.deepEqual(decide([start, reply("done\nGOAL COMPLETE: npm test passed"), idle()]), { action: "verify", goal, turn: 1 })
  assert.equal(decide([start, reply("GOAL COMPLETE"), idle(), synthetic(verifyText(goal)), reply("GOAL VERIFIED: reran"), idle()]).action, "finish")
  assert.equal(decide([start, reply("GOAL COMPLETE"), idle(), synthetic(verifyText(goal)), reply("fixed\nGOAL COMPLETE"), idle()]).action, "verify")
  const twice = [start, reply("GOAL COMPLETE"), idle(), synthetic(verifyText(goal)), reply("GOAL COMPLETE"), idle(), synthetic(verifyText(goal)), reply("GOAL COMPLETE"), idle()]
  assert.equal(decide(twice).action, "finish")
  assert.match(decide([start, reply("GOAL BLOCKED: need a token"), idle()]).note, /needs your input/)
  assert.deepEqual(decide([start, reply("GOAL BLOCKED: need a token"), idle()]).action, "pause")
  const interrupted = decide([start, reply("partial"), idle("interrupted")])
  assert.deepEqual(interrupted.action, "pause")
  assert.match(interrupted.note, /Esc stopped this turn/)
  assert.match(interrupted.note, /\/goal resume/)
  assert.match(decide([start, reply("partial"), idle("failed")]).note, /error/)
  assert.deepEqual(decide([start, reply("x"), idle(), synthetic("[InfiniteOC goal: stopped]\nGoal stopped."), reply("later"), idle()]), { action: "none" })
  const pausedNote = (note) => synthetic(`[InfiniteOC goal: paused]\n${note}\nGoal: ${goal}`)
  // A paused goal never auto-continues on its own; only /goal resume restarts it.
  assert.deepEqual(decide([start, reply("x"), idle("interrupted"), pausedNote("Esc stopped."), reply("later"), idle()]), { action: "none" })
  // ...but the user's next message unpauses it, through the normal flow.
  assert.deepEqual(decide([start, reply("x"), idle("interrupted"), pausedNote("Esc stopped."), user("actually use sqlite"), reply("ok"), idle()]), { action: "continue", goal, turn: 1 })
  assert.deepEqual(decide([start, reply("x"), idle("interrupted"), pausedNote("Esc stopped."), user("go on"), reply("done\nGOAL COMPLETE: tests pass"), idle()]), { action: "verify", goal, turn: 1 })
  assert.deepEqual(
    decide([start, reply("x"), idle("interrupted"), pausedNote("Esc stopped."), user("go on"), reply("half"), idle("interrupted")]).action,
    "pause",
  )
  // Raced order: the message typed during the interrupt lands before the
  // pause note, and still resumes at the next run end.
  assert.deepEqual(decide([start, reply("x"), idle(), user("oh wait"), pausedNote("Esc stopped."), reply("ok"), idle()]), { action: "continue", goal, turn: 1 })
  assert.deepEqual(resumeDecision([user("hi")]), undefined)
  assert.deepEqual(resumeDecision([start, reply("x"), idle()]), undefined)
  assert.deepEqual(resumeDecision([start, reply("x"), idle("interrupted"), pausedNote("Esc stopped.")]), { goal, turn: 1 })
  assert.deepEqual(
    resumeDecision([start, reply("x"), idle(), synthetic(continueText(goal, 1)), reply("y"), idle("interrupted"), pausedNote("Esc stopped.")]),
    { goal, turn: 2 },
  )
  assert.deepEqual(resumeDecision([start, reply("x"), idle(), synthetic("[InfiniteOC goal: stopped]\nGoal stopped.")]), undefined)
  assert.deepEqual(decide([start, reply("GOAL VERIFIED"), idle(), synthetic("[InfiniteOC goal: finished]\nGoal finished."), user("thanks"), reply("ok"), idle()]), { action: "none" })
  const capped = [start, reply("x"), idle()]
  for (let turn = 1; turn <= MAX_CONTINUATIONS; turn++) capped.push(synthetic(continueText(goal, turn)), reply("x"), idle())
  assert.match(decide(capped).note, /paused after/)
  // A new /goal resets the counters.
  assert.deepEqual(decide([...capped, user(startText("next")), reply("x"), idle()]), { action: "continue", goal: "next", turn: 1 })
  for (const text of [startText(goal), continueText(goal, 3), verifyText(goal)]) assert.match(text, /GOAL (COMPLETE|VERIFIED)/)
})

test("goal holds while background work runs instead of re-prompting, without burning turns", async (t) => {
  const source = await readFile(new URL("./goal.ts", import.meta.url), "utf8")
  const dir = await mkdtemp(path.join(tmpdir(), "goal-hold-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "goal.ts"), source.split("export const Plugin")[0].replace(/^import .*$/gm, ""))
  const { decide, holdStep, startText, continueText, HOLD_TIMEOUT_MS, HOLD_SETTLE_MS, MAX_CONTINUATIONS } = await import(path.join(dir, "goal.ts"))
  const user = (text) => ({ type: "user", text })
  const synthetic = (text) => ({ type: "synthetic", text })
  const reply = (text) => ({ type: "assistant", content: [{ type: "text", text }] })
  const idle = () => ({ type: "idle", outcome: "succeeded" })
  const goal = "ship it"
  const now = 1_000_000
  const hold = { goal, turn: 3, generation: 7, cursor: 10, deadline: now + HOLD_TIMEOUT_MS, work: ['workflow "w"'] }
  const tick = (over = {}) => holdStep(hold, { now: now + 2000, generation: 7, active: false, signals: [], work: ['workflow "w"'], ...over })

  // Nothing new: keep waiting, no prompt.
  assert.equal(tick().action, "wait")
  // A run started (the completion notice woke the session, or the user typed): that run's end decides.
  assert.deepEqual(tick({ generation: 8 }), { action: "drop" })
  assert.deepEqual(tick({ active: true }), { action: "drop" })
  // A message for main (or a per-step notification) wakes the goal right away.
  const woke = tick({ signals: [{ seq: 11, kind: "wake", reason: "workflow step a sent you a message (read_messages)" }] })
  assert.equal(woke.action, "resume")
  assert.match(woke.note, /step a sent you a message/)
  // Signals the hold already saw do not count again.
  assert.equal(tick({ signals: [{ seq: 10, kind: "wake", reason: "old" }] }).action, "wait")
  // Progress (a step finished) restarts the no-progress clock instead of waking.
  const later = now + HOLD_TIMEOUT_MS - 1000
  const progressed = holdStep(hold, { now: later, generation: 7, active: false, signals: [{ seq: 12, kind: "progress", reason: "step a completed" }], work: ['workflow "w"'] })
  assert.equal(progressed.action, "wait")
  assert.equal(progressed.hold.cursor, 12)
  assert.equal(progressed.hold.deadline, later + HOLD_TIMEOUT_MS)
  // Safety timeout: a stuck workflow cannot stall the goal forever.
  const timedOut = tick({ now: now + HOLD_TIMEOUT_MS })
  assert.equal(timedOut.action, "resume")
  assert.match(timedOut.note, /still running \(workflow "w"\) and nothing changed for 5 minutes/)
  assert.match(timedOut.note, /Check its status once/)
  // Work that ended without waking the session (a cancel notice is quiet) resumes after a short settle.
  const settling = tick({ work: [] })
  assert.equal(settling.action, "wait")
  assert.equal(settling.hold.settledAt, now + 2000)
  assert.equal(holdStep(settling.hold, { now: now + 2000 + HOLD_SETTLE_MS, generation: 7, active: false, signals: [], work: [] }).action, "resume")
  // Work that shows up again clears the settle mark.
  assert.equal(holdStep(settling.hold, { now: now + 3000, generation: 7, active: false, signals: [], work: ["x"] }).hold.settledAt, undefined)

  // Turn counting: a hold adds no control message, so the run the completion notice starts is the
  // same continuation the goal would have prompted, and a resumed hold counts exactly one turn.
  const start = user(startText(goal))
  const notice = synthetic('<workflow id="wf_1" name="w" state="completed">\n</workflow>')
  assert.deepEqual(decide([start, reply("started a workflow, waiting"), idle()]), { action: "continue", goal, turn: 1 })
  assert.deepEqual(decide([start, reply("started a workflow, waiting"), idle(), notice, reply("read the results"), idle()]), { action: "continue", goal, turn: 1 })
  const resumed = continueText(goal, 1, timedOut.note)
  assert.match(resumed, /^\[InfiniteOC goal: continue\]\nGoal: ship it\n\nContinuation 1 of 50\. Background work is still running/)
  assert.deepEqual(decide([start, reply("x"), idle(), synthetic(resumed), reply("checked once"), idle()]), { action: "continue", goal, turn: 2 })
  assert.equal(continueText(goal, 2), continueText(goal, 2, undefined))
  assert.equal(MAX_CONTINUATIONS, 50)
  // The protocol tells the agent that ending the turn is the way to wait.
  assert.match(startText(goal), /end your turn instead of checking on it: the goal waits/)
})

test("goal plugin: holds only plain continues, a run start or /goal stop ends a hold, upstream subagents count", async () => {
  const source = await readFile(new URL("./goal.ts", import.meta.url), "utf8")
  const plugin = source.slice(source.indexOf("export const Plugin"))
  assert.match(plugin, /if \(decision\.action === "verify"\) return prompt\n/)
  assert.match(plugin, /backgroundWork\(sessionID\)\.pipe\(\n\s+Effect\.flatMap\(\(pending\) => \(pending\.length \? startHold\(sessionID, decision, pending\) : prompt/)
  assert.match(plugin, /event\.type === "session\.execution\.started"\) \{\n\s+generations\.set[\s\S]{0,120}holds\.delete\(event\.data\.sessionID\)/)
  assert.match(plugin, /\/\^\(stop\|off\|cancel\)\$\/i\.test\(goal\)\) \{\n\s+holds\.delete\(input\.sessionID\)/)
  // Upstream background subagents: the stored record must belong to this session and its job still run.
  assert.match(plugin, /item\.recovery\.kind !== "subagent" \|\| item\.recovery\.parentSessionID !== sessionID/)
  assert.match(plugin, /\(yield\* jobs\.get\(item\.id\)\)\?\.status === "running"/)
  // The hold is a cheap in-process check; it never prompts the model while waiting.
  const watch = plugin.slice(plugin.indexOf("const watchHold"), plugin.indexOf("const startHold"))
  assert.match(watch, /Effect\.sleep\("2 seconds"\)/)
  assert.equal(watch.split("resumeHeld(").length, 2)
  // Every module the plugin imports exists in pinned upstream or is written by this mod.
  for (const [, rel] of source.matchAll(/from "(\.\.\/[^"]+)\.js"/g)) {
    const target = path.join(root, "packages/core/src/plugin", `${rel}.ts`)
    if (rel === "../infiniteoc/background") continue
    await access(target)
  }
})

test("background registry: sources per session, failing sources ignored, signals after a cursor", async () => {
  const B = await import("./background.ts")
  const remove = B.register((sessionID) => (sessionID === "ses_a" ? [{ label: 'workflow "w"' }] : []))
  const broken = B.register(() => {
    throw new Error("boom")
  })
  try {
    assert.deepEqual(B.running("ses_a"), [{ label: 'workflow "w"' }])
    assert.deepEqual(B.running("ses_b"), [])
    const cursor = B.cursor()
    B.signal("ses_a", "progress", "step a completed")
    B.signal("ses_b", "wake", "other session")
    B.signal("ses_a", "wake", "message")
    assert.deepEqual(B.since("ses_a", cursor).map((item) => [item.kind, item.reason]), [["progress", "step a completed"], ["wake", "message"]])
    assert.deepEqual(B.since("ses_a", B.cursor()), [])
    for (let i = 0; i < 50; i++) B.signal("ses_a", "progress", String(i))
    assert.equal(B.since("ses_a", 0).length, 20)
    B.forget("ses_a")
    assert.deepEqual(B.since("ses_a", 0), [])
  } finally {
    remove()
    broken()
  }
  assert.deepEqual(B.running("ses_a"), [])
})

test("goal footer shows paused goals instead of dropping them", async () => {
  const footer = await readFile(new URL("./tui/goal-status.tsx", import.meta.url), "utf8")
  assert.match(footer, /\[InfiniteOC goal: paused\]/)
  assert.match(footer, /"paused"/)
})

test("pausing is quiet: transcript note and footer only, no toast", async () => {
  const source = await readFile(new URL("./goal.ts", import.meta.url), "utf8")
  const pauseBranch = source.slice(source.indexOf('if (decision.action === "pause")'), source.indexOf('if (decision.action === "finish")'))
  assert.match(pauseBranch, /note\(sessionID, PAUSED/)
  assert.doesNotMatch(pauseBranch, /ToastShow/)
})

test("frontend gate covers UI files from edit, write and patch, and names the skill", async (t) => {
  const source = await readFile(new URL("./frontend.ts", import.meta.url), "utf8")
  const dir = await mkdtemp(path.join(tmpdir(), "frontend-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "frontend.ts"), source.split("export const Plugin")[0].replace(/^import .*$/gm, ""))
  const { targets, isUiFile, refusal, loaded, SKILL } = await import(path.join(dir, "frontend.ts"))
  assert.equal(SKILL, "frontend-design")
  await access(new URL(`../../skills/${SKILL}/SKILL.md`, import.meta.url))
  for (const file of ["a/index.html", "b.css", "c.module.scss", "App.tsx", "x.jsx", "Card.vue", "Page.svelte", "p.astro"]) assert.ok(isUiFile(file), file)
  for (const file of ["server.ts", "util.js", "README.md", "style.css.map", "data.json"]) assert.ok(!isUiFile(file), file)
  assert.deepEqual(targets("edit", { path: "src/App.tsx" }), ["src/App.tsx"])
  assert.deepEqual(targets("write", { path: "x.css", content: "" }), ["x.css"])
  assert.deepEqual(targets("read", { path: "x.css" }), [])
  assert.deepEqual(targets("edit", null), [])
  const patch = "*** Begin Patch\n*** Add File: web/a.html\n+<p>\n*** Update File: lib/b.ts\n*** Move to: web/b.tsx\n@@\n*** Delete File: old.css\n*** End Patch"
  assert.deepEqual(targets("patch", { patchText: patch }), ["web/a.html", "lib/b.ts", "web/b.tsx"])
  assert.match(refusal(["x.css"]), /skill tool with id "frontend-design"/)
  const tool = (id, status = "completed") => ({ type: "assistant", content: [{ type: "tool", name: "skill", state: { status, input: { id } } }] })
  assert.equal(loaded([{ type: "user", text: "make a page" }]), false)
  assert.equal(loaded([tool("impeccable")]), false)
  assert.equal(loaded([tool(SKILL, "error")]), false)
  assert.equal(loaded([tool(SKILL)]), true)
  assert.equal(loaded([{ type: "skill", skill: SKILL }]), true)
})

test("every agent's guidance requires the frontend-design skill for UI work", () => {
  assert.match(guidance.build, /\[Frontend\][\s\S]*loading the frontend-design skill[\s\S]*render and inspect/)
  assert.match(guidance.general, /load the frontend-design skill first/)
  assert.match(guidance.reviewer, /load the frontend-design skill and review/)
})

test("ponytail applies to coding turns only, honors levels and per-session stop", async (t) => {
  const source = await readFile(new URL("./ponytail.ts", import.meta.url), "utf8")
  const skill = await readFile(new URL("../../skills/ponytail/SKILL.md", import.meta.url), "utf8")
  const dir = await mkdtemp(path.join(tmpdir(), "ponytail-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "ponytail.ts"), `import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
` + source.split("export const Plugin")[0].replace(/^import .*$/gm, "").replace('"__PONYTAIL_SKILL__"', JSON.stringify(skill)))
  const { decide, rules, parseMode, DEFAULT_MODE, readMode } = await import(path.join(dir, "ponytail.ts"))
  assert.equal(DEFAULT_MODE, "off")
  // State file wins over env, env over the shipped default; isolate XDG_CONFIG_HOME first.
  const prevMode = process.env.PONYTAIL_DEFAULT_MODE
  const prevXdg = process.env.XDG_CONFIG_HOME
  try {
    process.env.XDG_CONFIG_HOME = path.join(dir, "home")
    const stateFile = path.join(process.env.XDG_CONFIG_HOME, "opencode", ".ponytail-active")
    await mkdir(path.dirname(stateFile), { recursive: true })
    delete process.env.PONYTAIL_DEFAULT_MODE
    assert.equal(readMode(), "off")
    process.env.PONYTAIL_DEFAULT_MODE = "auto"
    assert.equal(readMode(), "auto")
    await writeFile(stateFile, "full")
    assert.equal(readMode(), "full")
    await writeFile(stateFile, "bogus")
    assert.equal(readMode(), "auto")
    delete process.env.PONYTAIL_DEFAULT_MODE
    assert.equal(readMode(), "off")
  } finally {
    if (prevMode === undefined) delete process.env.PONYTAIL_DEFAULT_MODE
    else process.env.PONYTAIL_DEFAULT_MODE = prevMode
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
  }
  const user = (text) => ({ role: "user", content: [{ type: "text", text }] })
  const edit = { role: "assistant", content: [{ type: "tool-call", id: "1", name: "edit", input: {} }] }
  const read = { role: "assistant", content: [{ type: "tool-call", id: "2", name: "read", input: {} }] }
  assert.equal(decide("auto", "build", [user("add a retry to the fetch helper")]), "full")
  assert.equal(decide("auto", "build", [user("what does this function do?")]), undefined)
  assert.equal(decide("auto", "build", [user("explain how to fix the build")]), undefined)
  assert.equal(decide("auto", "build", [user("look into the flaky test"), read]), undefined)
  assert.equal(decide("auto", "build", [user("look into the flaky test"), edit]), "full")
  assert.equal(decide("auto", "build", [user("keep it simplest please")]), "full")
  assert.equal(decide("auto", "general", [user("anything")]), "full")
  for (const agent of ["explore", "researcher", "reviewer", "title"]) assert.equal(decide("full", agent, [user("add x")]), undefined)
  assert.equal(decide("ultra", "build", [user("hello")]), "ultra")
  assert.equal(decide("off", "build", [user("add x")]), undefined)
  assert.equal(decide("full", "build", [user("add x"), user("stop ponytail")]), undefined)
  assert.equal(decide("auto", "build", [user("normal mode."), user("add a flag")]), undefined)
  assert.equal(decide("auto", "build", [user("stop ponytail"), user("/ponytail"), user("add a flag")]), "full")
  assert.equal(parseMode(" Lite\n"), "lite")
  assert.equal(parseMode("bogus"), undefined)
  const lite = rules("lite")
  assert.match(lite, /^PONYTAIL MODE ACTIVE \(level: lite\)/)
  assert.match(lite, /\*\*lite\*\*/)
  assert.doesNotMatch(lite, /\*\*ultra\*\*|^name: ponytail/m)
  assert.match(lite, /Never cut: validation at trust boundaries/)
  assert.ok(lite.length < 5000)
})

test("goal indicator reads the active goal from the transcript", async (t) => {
  const source = await readFile(new URL("./tui/goal-status.tsx", import.meta.url), "utf8")
  const dir = await mkdtemp(path.join(tmpdir(), "goal-status-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "goal.ts"), source.split("export default")[0].replace(/^import .*$/gm, ""))
  const { goalState } = await import(path.join(dir, "goal.ts"))
  const user = (text) => ({ type: "user", text })
  const synthetic = (text, description) => ({ type: "synthetic", text, description })
  assert.equal(goalState([user("hi")]), undefined)
  assert.deepEqual(goalState([user("[InfiniteOC goal]\nGoal: ship it\n\nrules")]), { goal: "ship it", step: "on" })
  assert.deepEqual(goalState([user("[InfiniteOC goal]\nGoal: ship it"), synthetic("[InfiniteOC goal: continue]\nGoal: ship it\n\nContinuation 3 of 20.")]), { goal: "ship it", step: "3/20" })
  assert.deepEqual(goalState([user("[InfiniteOC goal]\nGoal: ship it"), synthetic("[InfiniteOC goal: verify]\nGoal: ship it")]), { goal: "ship it", step: "verify" })
  assert.equal(goalState([user("[InfiniteOC goal]\nGoal: ship it"), synthetic("[InfiniteOC goal: finished]\nGoal finished.")]), undefined)
  assert.equal(goalState([user("[InfiniteOC goal]\nGoal: ship it"), synthetic("[InfiniteOC goal: stopped]\nGoal stopped."), user("thanks")]), undefined)
})

test("the goal word animation matches only a leading /goal command", async () => {
  const source = await readFile(new URL("./tui/goal-word.ts", import.meta.url), "utf8")
  const pattern = new RegExp(/export const GOAL_WORD = \/(.+)\/\n/.exec(source)[1])
  for (const text of ["/goal", "/goal make it", "/goal\nnext"]) assert.ok(pattern.test(text), text)
  for (const text of ["/goals", " /goal", "my /goal", "/goalkeeper x"]) assert.ok(!pattern.test(text), text)
})

test("/goal: a turn that only announces the next step is caught and told to do it now", async (t) => {
  const source = await readFile(new URL("./goal.ts", import.meta.url), "utf8")
  const dir = await mkdtemp(path.join(tmpdir(), "goal-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "goal.ts"), source.split("export const Plugin")[0].replace(/^import .*$/gm, ""))
  const { decide, stallNote, stallText, startText } = await import(path.join(dir, "goal.ts"))
  for (const text of [
    "Implemented the parser.\n\nNext: wire it into the CLI and add tests.",
    "Done with step 1.\n**Next steps:**\n- add the API\n- write docs",
    "Created the schema.\n\n## Remaining\n1. migrations\n2. seed data",
    "The models are in place. Next, I'll implement the routes.",
    "I have set up the project. I will now implement the login flow.",
    "Phase one is complete. Shall I continue with phase two?",
    "Everything compiles. Would you like me to add the tests as well?",
  ]) assert.ok(stallNote(text), text)
  for (const text of [
    "All done.\nGOAL COMPLETE: npm test passed (42 tests), build ok",
    "GOAL BLOCKED: I need the Stripe test key",
    "Fixed the off-by-one in the pager and the test now passes.",
    "Next to the header there is a menu; I moved it.",
    "",
  ]) assert.equal(stallNote(text), undefined, text)
  const user = (text) => ({ type: "user", text })
  const reply = (text) => ({ type: "assistant", content: [{ type: "text", text }] })
  const idle = () => ({ type: "idle", outcome: "completed" })
  const decision = decide([user(startText("build the app")), reply("Scaffolded it.\nNext: add auth"), idle()])
  assert.equal(decision.action, "continue")
  assert.match(decision.stall, /Next: add auth/)
  assert.match(stallText(decision.stall), /Do it now, in this turn/)
  // The protocol no longer invites stopping after each turn.
  assert.doesNotMatch(startText("x"), /prompted to continue after each turn/)
  assert.match(startText("x"), /Never end your turn with a summary, a plan, a "Next: \.\.\." list/)
})

test("/goal survives compaction: the stored record stands in for controls the compaction hid", async (t) => {
  const source = await readFile(new URL("./goal.ts", import.meta.url), "utf8")
  const dir = await mkdtemp(path.join(tmpdir(), "goal-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "goal.ts"), source.split("export const Plugin")[0].replace(/^import .*$/gm, ""))
  const { decide, goalSystem, progressReply, continueText, MAX_CONTINUATIONS } = await import(path.join(dir, "goal.ts"))
  const reply = (text) => ({ type: "assistant", content: [{ type: "text", text }] })
  const idle = () => ({ type: "idle", outcome: "completed" })
  const compaction = { type: "compaction" }
  const record = { goal: "port the app", status: "active", continues: 7, verifies: 0, stalls: 0, plan: { done: ["models"], todo: ["routes", "tests"] }, updatedAt: 0 }
  // Before: a compaction hid the start, so the goal silently ended.
  assert.deepEqual(decide([compaction, reply("did routes"), idle()]), { action: "none" })
  assert.deepEqual(decide([compaction, reply("did routes"), idle()], record), { action: "continue", goal: "port the app", turn: 8 })
  // Stored counters win while the start is out of view, also after a post-compaction continue.
  assert.deepEqual(decide([compaction, { type: "synthetic", text: continueText("port the app", 8) }, reply("x"), idle()], { ...record, continues: 8 }), { action: "continue", goal: "port the app", turn: 9 })
  // A finished or paused record never revives anything; no compaction means no stand-in.
  assert.deepEqual(decide([compaction, reply("x"), idle()], { ...record, status: "done" }), { action: "none" })
  assert.deepEqual(decide([reply("x"), idle()], record), { action: "none" })
  assert.equal(decide([compaction, reply("x"), idle()], { ...record, continues: MAX_CONTINUATIONS }).action, "finish")
  // The block the model sees on every step: goal, turn, plan with the next step marked, the rules.
  const block = goalSystem(record)
  assert.match(block, /Goal: port the app/)
  assert.match(block, /Turn 8 of 50/)
  assert.match(block, /✓ models\n  → routes\n  · tests/)
  assert.match(block, /Do not stop to summarize, list next steps or ask whether to continue/)
  assert.match(goalSystem({ ...record, plan: { done: [], todo: [] } }), /No plan recorded yet/)
  assert.match(progressReply(record), /Do this now, without ending your turn: routes/)
  assert.match(progressReply({ ...record, plan: { done: ["a"], todo: [] } }), /Now verify/)
})

test("goal store: atomic per-session record, plan updates, safe ids", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-store-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const previous = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = dir
  t.after(() => { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous })
  const Store = await import(new URL("./goal-store.ts", import.meta.url))
  assert.equal(Store.readGoal("ses_1"), undefined)
  Store.writeGoal("ses_1", Store.fresh("ship it"))
  assert.equal(Store.readGoal("ses_1").status, "active")
  let record = Store.applyProgress(Store.readGoal("ses_1"), { plan: ["Models", "routes", "tests"] })
  assert.deepEqual(record.plan, { done: [], todo: ["Models", "routes", "tests"] })
  record = Store.applyProgress(record, { done: ["models"], note: " picked  sqlite " })
  assert.deepEqual(record.plan, { done: ["models"], todo: ["routes", "tests"] })
  assert.equal(record.note, "picked sqlite")
  record = Store.applyProgress(record, { done: ["models", "routes"], plan: ["routes", "tests", "docs"] })
  assert.deepEqual(record.plan, { done: ["models", "routes"], todo: ["tests", "docs"] })
  assert.deepEqual(Store.applyProgress(record, { plan: "nope", done: [3, null] }).plan.todo, [])
  Store.updateGoal("ses_1", (old) => ({ ...old, status: "done" }))
  assert.equal(Store.readGoal("ses_1").status, "done")
  assert.equal(Store.updateGoal("ses_missing", (old) => old), undefined)
  assert.throws(() => Store.writeGoal("../escape", Store.fresh("x")), /invalid session id/)
  assert.equal(Store.readGoal("../escape"), undefined)
})
