import test from "node:test"
import assert from "node:assert/strict"
import { readFile, writeFile, mkdtemp, rm, access } from "node:fs/promises"
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
  assert.equal(files.size, 38)
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
test("/goal keeps going until the goal is verified, and stops on interrupt, block or cap", async (t) => {
  // decide() is pure; load it without the plugin runtime by dropping imports and the Plugin export.
  const source = await readFile(new URL("./goal.ts", import.meta.url), "utf8")
  const dir = await mkdtemp(path.join(tmpdir(), "goal-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "goal.ts"), source.split("export const Plugin")[0].replace(/^import .*$/gm, ""))
  const { decide, startText, continueText, verifyText, MAX_CONTINUATIONS } = await import(path.join(dir, "goal.ts"))
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
  assert.match(decide([start, reply("partial"), idle("interrupted")]).note, /interrupted/)
  assert.match(decide([start, reply("partial"), idle("failed")]).note, /error/)
  assert.deepEqual(decide([start, reply("x"), idle(), synthetic("[InfiniteOC goal: stopped]\nGoal stopped."), reply("later"), idle()]), { action: "none" })
  assert.deepEqual(decide([start, reply("GOAL VERIFIED"), idle(), synthetic("[InfiniteOC goal: finished]\nGoal finished."), user("thanks"), reply("ok"), idle()]), { action: "none" })
  const capped = [start, reply("x"), idle()]
  for (let turn = 1; turn <= MAX_CONTINUATIONS; turn++) capped.push(synthetic(continueText(goal, turn)), reply("x"), idle())
  assert.match(decide(capped).note, /paused after/)
  // A new /goal resets the counters.
  assert.deepEqual(decide([...capped, user(startText("next")), reply("x"), idle()]), { action: "continue", goal: "next", turn: 1 })
  for (const text of [startText(goal), continueText(goal, 3), verifyText(goal)]) assert.match(text, /GOAL (COMPLETE|VERIFIED)/)
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
  await writeFile(path.join(dir, "ponytail.ts"), source.split("export const Plugin")[0].replace(/^import .*$/gm, "").replace('"__PONYTAIL_SKILL__"', JSON.stringify(skill)))
  const { decide, rules, parseMode } = await import(path.join(dir, "ponytail.ts"))
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
