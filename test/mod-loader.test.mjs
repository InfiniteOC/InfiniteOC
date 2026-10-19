import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { applyMods, loadMods } from "../src/mod-loader.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "infiniteoc-test-"))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, "source")
  await mkdir(root)
  return { base, root }
}

function mod(setup, id = "test") { return { id, setup } }

test("loadMods resolves paths against base and preserves configured ordering", async (t) => {
  const { base } = await fixture(t)
  await writeFile(join(base, "slow.mjs"), 'await new Promise(r => setTimeout(r, 20)); export default { id: "slow", version: "1", setup() {} }')
  await writeFile(join(base, "fast.mjs"), 'export default { id: "fast", setup() {} }')
  const mods = await loadMods(["./slow.mjs", "fast.mjs"], base)
  assert.deepEqual(mods.map(({ id }) => id), ["slow", "fast"])
  assert.equal(mods[0].filename, join(base, "slow.mjs"))
  assert.equal(mods[0].version, "1")
  assert.deepEqual(await loadMods([], base), [])
})

test("loadMods rejects duplicate IDs, including repeated paths", async (t) => {
  const { base } = await fixture(t)
  for (const name of ["one", "two"])
    await writeFile(join(base, `${name}.mjs`), 'export default { id: "same", setup() {} }')
  await assert.rejects(loadMods(["one.mjs", "two.mjs"], base), /Duplicate mod id: same/)
  await assert.rejects(loadMods(["one.mjs", "one.mjs"], base), /Duplicate mod id: same/)
})

test("loadMods rejects missing or malformed default exports", async (t) => {
  const { base } = await fixture(t)
  const sources = ['export const setup = () => {}', 'export default null', 'export default { id: "../bad", setup() {} }', 'export default { id: "valid", setup: 1 }']
  for (const [index, source] of sources.entries()) {
    const name = `invalid-${index}.mjs`
    await writeFile(join(base, name), source)
    await assert.rejects(loadMods([name], base), /Invalid mod/)
  }
  await assert.rejects(loadMods(["missing.mjs"], base), /Cannot find module/)
})

test("applyMods reads, creates nested files, awaits transforms, and records changes in order", async (t) => {
  const { root } = await fixture(t)
  const options = { reducedMotion: true }
  await writeFile(join(root, "seed.txt"), "original")
  const result = await applyMods([
    mod(async (api) => {
      assert.equal(api.root, root)
      assert.equal(api.options, options)
      assert.equal(await api.read("seed.txt"), "original")
      await api.write("nested/value.txt", "first")
      await api.patch("seed.txt", async (text) => `${text}-patched`)
    }, "first"),
    mod(async (api) => {
      assert.equal(await api.read("seed.txt"), "original-patched")
      await api.patch("nested/value.txt", (text) => `${text}-second`)
    }, "second"),
  ], root, options)
  assert.equal(await readFile(join(root, "nested/value.txt"), "utf8"), "first-second")
  assert.deepEqual(result.changes, [
    { mod: "first", path: "nested/value.txt", action: "write" },
    { mod: "first", path: "seed.txt", action: "patch" },
    { mod: "second", path: "nested/value.txt", action: "patch" },
  ])
})

test("patch fails closed on unchanged or non-string results without overwriting", async (t) => {
  const { root } = await fixture(t)
  await writeFile(join(root, "file.txt"), "original")
  for (const transform of [(text) => text, () => undefined, () => 42, () => ({})]) {
    await assert.rejects(applyMods([mod((api) => api.patch("file.txt", transform))], root), /patch did not change file.txt; upstream may be incompatible/)
    assert.equal(await readFile(join(root, "file.txt"), "utf8"), "original")
  }
})

test("all file APIs reject absolute, traversal, and source-root paths", async (t) => {
  const { base, root } = await fixture(t)
  const outside = join(base, "outside.txt")
  await writeFile(outside, "untouched")
  for (const path of [outside, "../outside.txt", "nested/../../outside.txt", ".", ""]) {
    for (const operation of ["read", "write", "patch"]) {
      await assert.rejects(applyMods([mod(async (api) => {
        if (operation === "read") await api.read(path)
        if (operation === "write") await api.write(path, "changed")
        if (operation === "patch") await api.patch(path, () => "changed")
      })], root), /Mod paths must be relative|Mod path escapes source tree/)
    }
  }
  assert.equal(await readFile(outside, "utf8"), "untouched")
})

test("all file APIs reject external file and directory symlinks, including new descendants", async (t) => {
  const { base, root } = await fixture(t)
  const outside = join(base, "outside")
  await mkdir(outside)
  await writeFile(join(outside, "file.txt"), "untouched")
  await symlink(join(outside, "file.txt"), join(root, "file-link"))
  await symlink(outside, join(root, "dir-link"))
  for (const path of ["file-link", "dir-link/file.txt", "dir-link/new/deep.txt"]) {
    for (const operation of ["read", "write", "patch"]) {
      await assert.rejects(applyMods([mod(async (api) => {
        if (operation === "read") await api.read(path)
        if (operation === "write") await api.write(path, "changed")
        if (operation === "patch") await api.patch(path, () => "changed")
      })], root), /Symlink escapes source tree/)
    }
  }
  assert.equal(await readFile(join(outside, "file.txt"), "utf8"), "untouched")
  await assert.rejects(access(join(outside, "new")))
})

test("file APIs allow symlinks whose targets stay inside the source tree", async (t) => {
  const { root } = await fixture(t)
  await writeFile(join(root, "file.txt"), "original")
  await symlink("file.txt", join(root, "alias.txt"))
  await applyMods([mod(async (api) => {
    assert.equal(await api.read("alias.txt"), "original")
    await api.patch("alias.txt", (text) => `${text}-patched`)
  })], root)
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "original-patched")
})

test("api.on hooks emit sequentially in registration order with the supplied context", async (t) => {
  const { root } = await fixture(t)
  const calls = []
  const result = await applyMods([
    mod((api) => {
      api.on("beforeLaunch", async (context) => { await new Promise(r => setTimeout(r, 10)); calls.push(["first", context]) })
      api.on("beforeLaunch", (context) => calls.push(["second", context]))
      api.on("afterExit", (context) => calls.push(["exit", context]))
    }, "one"),
    mod((api) => api.on("beforeLaunch", (context) => calls.push(["third", context])), "two"),
  ], root)
  assert.deepEqual(calls, [])
  const context = { args: [], env: {}, cwd: root }
  await result.emit("beforeLaunch", context)
  assert.deepEqual(calls.map(([name]) => name), ["first", "second", "third"])
  for (const [, value] of calls) assert.equal(value, context)
  const exit = { ...context, code: 7 }
  await result.emit("afterExit", exit)
  assert.equal(calls.at(-1)[1], exit)
  await result.emit("unregistered", context)
  assert.equal(calls.length, 4)
})

test("invalid hooks and hook failures propagate", async (t) => {
  const { root } = await fixture(t)
  await assert.rejects(applyMods([mod((api) => api.on("unknown", () => {}))], root), /Invalid lifecycle hook/)
  await assert.rejects(applyMods([mod((api) => api.on("beforeLaunch", null))], root), /Invalid lifecycle hook/)
  let later = false
  const result = await applyMods([mod((api) => {
    api.on("beforeLaunch", () => { throw new Error("hook failed") })
    api.on("beforeLaunch", () => { later = true })
  })], root)
  await assert.rejects(result.emit("beforeLaunch", {}), /hook failed/)
  assert.equal(later, false)
})

test("register-only setup restores hooks without rewriting cached source or executing transforms", async (t) => {
  const { root } = await fixture(t)
  await writeFile(join(root, "file.txt"), "cached")
  let emitted = false
  const result = await applyMods([mod(async (api) => {
    assert.equal(await api.read("file.txt"), "cached")
    await api.write("file.txt", "overwritten")
    await api.patch("file.txt", () => { throw new Error("must not execute") })
    api.on("beforeLaunch", () => { emitted = true })
  })], root, {}, true)
  assert.deepEqual(result.changes, [])
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "cached")
  await result.emit("beforeLaunch", {})
  assert.equal(emitted, true)
})

test("bundled mod applies through the real loader to a minimal copy of pinned upstream", async (t) => {
  const upstream = join(repository, ".upstream")
  try { await access(join(upstream, "package.json")) } catch { t.skip("Local .upstream is absent; run setup/doctor to fetch pinned source"); return }
  const { root } = await fixture(t)
  const targets = [
    "packages/tui/src/theme/assets/v2/opencode.json",
    "packages/tui/src/theme/index.ts",
    "packages/tui/src/context/theme.tsx",
    "packages/tui/src/component/logo.tsx",
    "packages/core/src/plugin/agent.ts",
    "packages/core/src/plugin/plan.ts",
    "packages/core/src/config/plugin/agent.ts",
    "packages/tui/src/component/prompt/index.tsx",
    "packages/tui/src/component/dialog-agent.tsx",
    "packages/tui/src/mini/footer.command.tsx",
    "packages/tui/src/component/dialog-config.tsx",
    "packages/tui/src/logo.ts",
    "packages/tui/src/util/presentation.ts",
    "packages/tui/src/mini/splash.ts",
    "packages/tui/src/ui/toast.tsx",
    "packages/tui/src/feature-plugins/system/stats.tsx",
    "packages/cli/src/services/updater.ts",
    "packages/cli/src/commands/handlers/uninstall.ts",
    "packages/tui/src/config/index.tsx",
    "packages/tui/src/routes/session/index.tsx",
    "packages/tui/src/app.tsx",
    "packages/tui/src/ui/dialog.tsx",
    "packages/core/src/session/context.ts",
    "packages/core/src/config/plugin/skill.ts",
    "packages/core/src/plugin/internal.ts",
    "packages/tui/src/plugin/builtins.ts",
    "packages/core/src/tool/plugin/subagent.ts",
    "packages/core/src/config/plugin/instruction.ts",
    "packages/core/src/instructions/builtins.ts",
  ]
  const originals = new Map()
  for (const path of targets) {
    originals.set(path, await readFile(join(upstream, path), "utf8"))
    await mkdir(dirname(join(root, path)), { recursive: true })
    await cp(join(upstream, path), join(root, path))
  }
  const mods = await loadMods(["mods/infiniteoc/index.mjs"], repository)
  const { changes } = await applyMods(mods, root, { reducedMotion: true })
  assert.equal(changes.length, 43)
  assert.ok(changes.every(({ mod }) => mod === "infiniteoc"))
  const read = (path) => readFile(join(root, path), "utf8")
  const theme = JSON.parse(await read("packages/tui/src/theme/assets/v2/infiniteoc.json"))
  const originalTheme = JSON.parse(originals.get(targets[0]))
  for (const mode of ["dark", "light"]) {
    assert.equal(theme[mode].hue.interactive, "$hue.purple")
    assert.equal(theme[mode].hue.accent, "$hue.pink")
    assert.notDeepEqual(theme[mode].hue.gray, originalTheme[mode].hue.gray)
    for (const hue of ["red", "green", "yellow"]) assert.deepEqual(theme[mode].hue[hue], originalTheme[mode].hue[hue])
  }
  assert.match(await read(targets[1]), /infiniteoc,/)
  const context = await read(targets[2])
  assert.match(context, /active: "infiniteoc"/)
  assert.match(context, /config.theme.name === "opencode" \? "infiniteoc" : config.theme.name/)
  const logo = await read(targets[3])
  assert.match(logo, /InfiniteOC/)
  assert.match(await read("packages/tui/src/config/index.tsx"), /animations: input\.animations \?\? false,/)
  assert.match(logo, /wrapMode="none"/)
  assert.match(await read("packages/tui/src/logo.ts"), /█ █▀▀▄ ▀█▀/)
  const agent = await read(targets[4])
  assert.match(agent, /Agent\.Name\.make\("InfiniteOC"\)/)
  assert.match(agent, /Unified primary agent for reasoning, planning, and implementation/)
  // Beyond branding and descriptions, only the added InfiniteOC subagent block may differ.
  const normalized = agent
    .replace('item.name = Agent.Name.make("InfiniteOC")', 'item.name = Agent.Name.make("Build")')
    .replace(/item.description = "Unified primary agent[^\n]+/, 'item.description = "The default agent. Executes tools based on configured permissions."')
    .replace(/"Implementation worker for a bounded[^"]+"/, '"General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel."')
    .replace(/      \/\/ InfiniteOC subagents;[\s\S]*?(?=      editor\.update\(Agent\.ID\.make\("compaction"\))/, "")
    // The subagent block needs Permission, which upstream v2.0.32 no longer imports here.
    .replace('import { Agent } from "../agent.js"\nimport { Permission } from "../permission.js"\n', 'import { Agent } from "../agent.js"\n')
  assert.equal(normalized, originals.get(targets[4]))
  const plan = await read(targets[5])
  assert.match(plan, /item.hidden = true/)
  assert.equal(plan.replace('\n        item.hidden = true // InfiniteOC: retain legacy Plan restrictions, omit selector', ""), originals.get(targets[5]))
  const configuredAgent = await read(targets[6])
  assert.match(await read("packages/core/src/infiniteoc/guidance.ts"), /Configured permissions and approvals always apply/)
  assert.match(await read("packages/core/src/session/context.ts"), /infiniteocGuidance\[agent\.id\]/)
  assert.match(await read("packages/core/src/plugin/internal.ts"), /PlanPlugin\.Plugin,\n  InfiniteocGoal\.Plugin,\n  InfiniteocFrontend\.Plugin,\n  InfiniteocPonytail\.Plugin,/)
  assert.match(await read("packages/core/src/plugin/infiniteoc-goal.ts"), /name: "goal"/)
  assert.match(configuredAgent, /editor.default\(Agent.defaultID\)/)
  assert.match(configuredAgent, /current.id !== Agent.defaultID && current.mode !== "subagent"/)
  assert.match(await read(targets[7]), /agentLabel: agent \? agent.name : undefined/)
  assert.match(await read(targets[8]), /title: item.name/)
  assert.match(await read(targets[9]), /display: agent.name/)
  assert.match(configuredAgent, /agent.hidden = true/)
  assert.equal(configuredAgent.replace(/\n      \/\/ InfiniteOC finalizes presentation[\s\S]*?(?=\n    \}\))/, ""), originals.get(targets[6]))
  for (const [path, original] of originals) assert.equal(await readFile(join(upstream, path), "utf8"), original)
})