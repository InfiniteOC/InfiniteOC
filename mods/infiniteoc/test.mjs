import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import mod from "./index.mjs"
import { workflowInstruction } from "./workflow.mjs"

test("workflow encourages bounded parallel delegation without granting permissions", () => {
  for (const phrase of ["at most two active workers", "non-overlapping regions", "Keep dependent actions sequential", "Integrate the combined changes", "never grant tool access", "do not claim that it ran concurrently", "existing auto-route skill"]) {
    assert.ok(workflowInstruction.includes(phrase), `Missing workflow guard: ${phrase}`)
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
  assert.equal(files.size, 14)
  const file = "packages/core/src/plugin/agent.ts"
  const original = await readFile(path.join(root, file), "utf8")
  const rules = (source) => source.split("\n").filter((line) => /\.permissions|action:|resource:|effect:|Permission\.merge/.test(line))
  assert.deepEqual(rules(files.get(file)), rules(original))
  assert.match(files.get(file), /Agent\.Name\.make\("InfiniteOC"\)/)
  assert.match(files.get(file), /editor\.update\(Agent\.defaultID/)
  for (const target of ["packages/core/src/plugin/plan.ts", "packages/core/src/config/plugin/agent.ts"]) {
    assert.deepEqual(rules(files.get(target)), rules(await readFile(path.join(root, target), "utf8")))
  }
  assert.match(files.get("packages/core/src/plugin/plan.ts"), /item\.hidden = true/)
  const config = files.get("packages/core/src/config/plugin/agent.ts")
  assert.match(config, /\[agent\.system, instruction\]/)
  assert.ok(config.includes("Efficient delegation and parallel execution"))
  assert.match(config, /agent\.hidden = true/)
  assert.match(config, /editor.default\(Agent.defaultID\)/)
  assert.match(config, /current.id !== Agent.defaultID && current.mode !== "subagent"/)
  assert.match(config, /agent.color = Agent.Color.make\("#c084fc"\)/)
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
  const files = await apply(true)
  const logo = files.get("packages/tui/src/component/logo.tsx")
  assert.match(logo, /if \(true\) return/)
  assert.match(logo, /onCleanup\(\(\) => clearInterval\(timer\)\)/)
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
  assert.equal(agents[0].color, "#c084fc")
  assert.deepEqual(agents.filter(agent => agent.mode !== "subagent" && !agent.hidden).map(agent => agent.name), ["InfiniteOC"])
  assert.equal(agents.find(agent => agent.id === "explore").hidden, false)
  assert.deepEqual(agents.map(agent => agent.permissions), before)
  assert.ok(agents[0].system.startsWith("Custom prompt"))
  const system = agents[0].system
  finalize(editor, Agent)
  assert.equal(agents[0].system, system)
})