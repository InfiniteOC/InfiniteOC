import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import mod from "./index.mjs"
import * as logic from "./tstat-logic.ts"

const root = path.resolve(import.meta.dirname, "../../.upstream")

test("applies every anchor against the pinned source", async () => {
  const files = new Map()
  await mod.setup({
    root,
    async patch(file, transform) {
      files.set(file, await transform(files.get(file) ?? (await readFile(path.join(root, file), "utf8"))))
    },
    async write(file, content) {
      files.set(file, content)
    },
  })
  assert.match(files.get("packages/tui/src/plugin/builtins.ts"), /import Tstat from[\s\S]*  Notifications,\n  Tstat,\n/)
  assert.match(files.get("packages/tui/src/app.tsx"), /tabsAvailable\(\) && !fullscreenPanel\(\) && !tstatZen\(\)/)
  assert.match(files.get("packages/tui/src/app.tsx"), /tstatDetectMode\(renderer\)/)
  assert.match(files.get("packages/tui/src/routes/session/permission.tsx"), /session: "Allow for session \(s\)"/)
  assert.match(files.get("packages/tui/src/routes/home.tsx"), /<TstatDashboard directory=/)
  assert.ok(files.has("packages/tui/src/feature-plugins/system/tstat.tsx"))
})

test("settings: bad saved values fall back to defaults", () => {
  assert.deepEqual(logic.sanitize(undefined), logic.defaults)
  assert.deepEqual(logic.sanitize({ notify: "yes", sound: true, budget: -3, nerd: "maybe" }), { ...logic.defaults, sound: true })
  assert.equal(logic.sanitize({ budget: 5, nerd: "on" }).budget, 5)
})

test("notifications: argv carries quotes safely; sounds differ per cue", () => {
  const mac = logic.notifyCommand("darwin", 'a "title"', "it's \\ done")
  assert.equal(mac.cmd, "osascript")
  assert.deepEqual(mac.args.slice(-2), ["it's \\ done", 'a "title"'])
  assert.equal(logic.notifyCommand("linux", "t", "m").cmd, "notify-send")
  assert.equal(logic.notifyCommand("win32", "t", "m"), undefined)
  const sounds = ["done", "error", "waiting"].map((cue) => logic.soundCommand("darwin", cue).args[0])
  assert.equal(new Set(sounds).size, 3)
  assert.equal(logic.soundCommand("win32", "done"), undefined)
  assert.equal(logic.shouldNotify("focused"), false)
  assert.equal(logic.shouldNotify("blurred"), true)
  assert.equal(logic.shouldNotify("unknown"), true)
})

test("usage meter and budget", () => {
  const tokens = (input, output, read = 0) => ({ input, output, reasoning: 0, cache: { read, write: 0 } })
  assert.deepEqual(logic.sumTokens([{ tokens: tokens(10, 5, 100) }, undefined, { tokens: tokens(1, 1) }]), { input: 111, output: 6 })
  assert.equal(logic.formatTokens(999), "999")
  assert.equal(logic.formatTokens(1500), "1.5K")
  assert.equal(logic.formatTokens(45_200), "45K")
  assert.equal(logic.formatTokens(2_500_000), "2.5M")
  assert.equal(logic.budgetState(1, 0), undefined)
  assert.deepEqual(logic.budgetState(0.5, 5), { percent: 10, level: "ok" })
  assert.equal(logic.budgetState(4, 5).level, "warn")
  assert.equal(logic.budgetState(5, 5).level, "over")
})

test("subagent fan-out and progress bar", () => {
  assert.deepEqual(logic.fanout(["running", "idle", "idle"]), { total: 3, running: 1, done: 2 })
  assert.equal(logic.progressBar(2, 4, 8), "▰▰▰▰▱▱▱▱")
  assert.equal(logic.progressBar(0, 0), "")
})

test("git status parsing", () => {
  const status = logic.parseGitStatus("## feat/x...origin/feat/x [ahead 2, behind 1]\n M a.ts\nA  b.ts\nAM c.ts\n?? d.ts\n")
  assert.deepEqual(status, { branch: "feat/x", ahead: 2, behind: 1, staged: 2, changed: 2, untracked: 1, clean: false })
  assert.equal(logic.parseGitStatus("## main\n").clean, true)
  assert.equal(logic.parseGitStatus("## No commits yet on main\n").branch, "No")
})

test("relative time", () => {
  const now = 1_000_000_000
  assert.equal(logic.relativeTime(now - 5_000, now), "just now")
  assert.equal(logic.relativeTime(now - 5 * 60_000, now), "5m ago")
  assert.equal(logic.relativeTime(now - 3 * 3_600_000, now), "3h ago")
  assert.equal(logic.relativeTime(now - 72 * 3_600_000, now), "3d ago")
})

test("session-wide permission key follows the patterns 'always' would save", () => {
  const a = { action: "shell", resources: ["git status -s"], save: ["git status *"] }
  const b = { action: "shell", resources: ["git status"], save: ["git status *"] }
  const c = { action: "shell", resources: ["rm -rf x"], save: ["rm *"] }
  assert.equal(logic.permissionKey(a), logic.permissionKey(b))
  assert.notEqual(logic.permissionKey(a), logic.permissionKey(c))
  assert.notEqual(logic.permissionKey({ ...a, action: "edit" }), logic.permissionKey(a))
})

test("nerd font detection and theme mode from background", () => {
  assert.equal(logic.nerdEnabled("on", {}), true)
  assert.equal(logic.nerdEnabled("off", { NERD_FONT: "1" }), false)
  assert.equal(logic.nerdEnabled("auto", {}), false)
  assert.equal(logic.nerdEnabled("auto", { TERM_PROGRAM: "WezTerm" }), true)
  assert.notEqual(logic.iconsFor(true).branch, logic.iconsFor(false).branch)
  assert.equal(logic.modeFromBackground("#fdf6e3"), "light")
  assert.equal(logic.modeFromBackground("#101010"), "dark")
  assert.equal(logic.modeFromBackground(undefined), undefined)
})
