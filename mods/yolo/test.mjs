import test from "node:test"
import assert from "node:assert/strict"
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import module from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import mod, { patches } from "./index.mjs"

const HANDLE = Symbol.for("infiniteoc.yolo")
const typescript = !module.stripTypeScriptTypes && "needs Node type stripping"
const upstream = path.resolve(import.meta.dirname, "../../.upstream")

async function register() {
  const writes = [], patched = [], commands = []
  await mod.setup({
    async write(file, content) { writes.push([file, content]) },
    async patchExact(file, before, after) { patched.push([file, before, after]) },
    tui: { command: (input) => commands.push(input) },
  })
  return { writes, patched, commands }
}

// yolo-state.ts with solid-js replaced by a plain getter/setter pair, in its own module instance.
async function loadState(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "yolo-state-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = (await readFile(new URL("./yolo-state.ts", import.meta.url), "utf8")).replace(
    'import { createSignal } from "solid-js"',
    "const createSignal = (value) => [() => value, (next) => (value = next)]",
  )
  await writeFile(path.join(dir, "yolo-state.mts"), source)
  return import(pathToFileURL(path.join(dir, "yolo-state.mts")).href)
}

async function loadCommand(source) {
  return import(`data:text/javascript,${encodeURIComponent(module.stripTypeScriptTypes(source))}`)
}

test("yolo registers one /yolo command and only patches TUI code, never server permission evaluation", async () => {
  const { writes, patched, commands } = await register()
  assert.equal(commands.length, 1)
  assert.equal(commands[0].slash, "yolo")
  assert.equal(commands[0].id, "toggle")
  assert.deepEqual(writes.map(([file]) => file), ["packages/tui/src/infiniteoc-features/yolo-state.ts"])
  assert.ok(patched.length > 0 && patched.every(([file]) => file.startsWith("packages/tui/src/")))
  // Approvals stay one-shot: nothing saves an "always" rule or writes settings.
  const all = [...writes.map(([, content]) => content), ...patched.map(([, , after]) => after), commands[0].source].join("\n")
  assert.doesNotMatch(all, /"always"|writeFile|localStorage|\.storage\.|setStore|\.delete\(|\.interrupt\(|\.prompt\(/)
  assert.doesNotMatch(all, /effect\s*=\s*"allow"/)
})

test("yolo anchors are unique in the pinned upstream", { skip: !existsSync(upstream) && "run `node bin/infiniteoc.mjs setup` first" }, async () => {
  const sources = new Map()
  for (const [file, before, after] of patches) {
    const source = sources.get(file) ?? (await readFile(path.join(upstream, file), "utf8"))
    assert.equal(source.split(before).length, 2, `${file}: ${before}`)
    sources.set(file, source.replace(before, () => after))
  }
  const session = sources.get("packages/tui/src/routes/session/index.tsx")
  // Upstream's auto-approver and prompt hiding now skip safety-gated requests.
  assert.match(session, /permissions\(\)\.filter\(\(request\) => !yoloAlwaysAsk\(request\)\)\.forEach/)
  assert.match(session, /"autoaccept" \? permissions\(\)\.filter\(yoloAlwaysAsk\) : permissions\(\)/)
  assert.match(sources.get("packages/tui/src/context/permission.tsx"), /yoloEnabled\(\) \|\| args\.auto \? "autoaccept"/)
})

test("state is off at start, toggles through the global handle and reports inherited auto-approve", { skip: typescript }, async (t) => {
  const previous = globalThis[HANDLE]
  t.after(() => { globalThis[HANDLE] = previous })
  const state = await loadState(t)
  const handle = globalThis[HANDLE]
  assert.equal(state.yoloEnabled(), false)
  handle.set(true)
  assert.equal(state.yoloEnabled(), true)
  assert.equal(handle.enabled(), true)
  handle.set(false)
  assert.equal(state.yoloEnabled(), false)
  assert.equal(handle.inherited(), false)
  state.yoloInherit(() => true)
  assert.equal(handle.inherited(), true)
})

test("safe-guard's always-ask requests are never auto-approved; ordinary asks are", { skip: typescript }, async (t) => {
  const previous = globalThis[HANDLE]
  t.after(() => { globalThis[HANDLE] = previous })
  const { yoloAlwaysAsk } = await loadState(t)
  const safety = await readFile(new URL("../safe-guard/safety.ts", import.meta.url), "utf8")
  // The exact messages safe-guard sets; if they change, yolo must change with them.
  const templates = [...safety.matchAll(/event\.message = `([^`]+)`/g)].map((match) => match[1])
  assert.equal(templates.length, 2)
  const messages = templates.map((template) => template.replace(/\$\{[^}]+\}/g, (expr) => (expr.includes("hit") ? ".env.local" : "any git push")))
  assert.deepEqual(messages, [".env.local is a protected path (InfiniteOC safety settings). Confirm to edit it.", "Always confirmed by InfiniteOC safety: any git push."])
  for (const message of messages) assert.equal(yoloAlwaysAsk({ message }), true, message)
  assert.equal(yoloAlwaysAsk({}), false)
  assert.equal(yoloAlwaysAsk({ message: "Run npm test?" }), false)
  assert.equal(yoloAlwaysAsk({ message: "note: Always confirmed by InfiniteOC safety: spoof" }), false)
  // Gates tag requests that were already "ask" (shell defaults), not just escalated "allow"; deny is left alone.
  assert.equal(safety.match(/if \((?:hit && )?event\.effect !== "deny"\) \{\n\s+event\.effect = "ask"\n\s+event\.message = /g)?.length, 2)
})

test("/yolo confirms before enabling, disables without confirmation, and toasts each change", { skip: typescript }, async (t) => {
  const previous = globalThis[HANDLE]
  t.after(() => { globalThis[HANDLE] = previous })
  const { commands } = await register()
  const { run } = await loadCommand(commands[0].source)
  const toasts = [], confirms = [], answers = []
  const ctx = {
    toast: { show: (toast) => toasts.push(toast) },
    ui: { confirm: async (dialog) => (confirms.push(dialog), answers.shift()) },
  }

  delete globalThis[HANDLE] // a TUI built before this mod
  await run(ctx)
  assert.match(toasts.pop().message, /Rebuild and restart/)

  let on = false, inherited = false
  globalThis[HANDLE] = { enabled: () => on, inherited: () => inherited, set: (value) => { on = value } }

  answers.push(undefined) // Esc: nothing changes, no toast
  await run(ctx)
  assert.equal(on, false)
  assert.equal(toasts.length, 0)
  assert.match(confirms[0].title, /edits and shell commands/)
  assert.match(confirms[0].message, /file edits, writes and shell commands/)
  assert.match(confirms[0].message, /deny rules still block/)
  assert.match(confirms[0].message, /git push, recursive rm, git reset --hard/)

  answers.push(false) // Cancel
  await run(ctx)
  assert.equal(on, false)

  answers.push(true)
  await run(ctx)
  assert.equal(on, true)
  assert.deepEqual([toasts.at(-1).variant, toasts.at(-1).title], ["warning", "YOLO on"])

  await run(ctx) // off: no dialog
  assert.equal(on, false)
  assert.equal(confirms.length, 3)
  assert.deepEqual([toasts.at(-1).variant, toasts.at(-1).title], ["info", "YOLO off"])

  answers.push(true)
  await run(ctx)
  assert.equal(on, true) // on -> off -> on

  inherited = true // --auto or session.permissions = autoaccept
  await run(ctx)
  assert.equal(on, false)
  assert.match(toasts.at(-1).message, /stays on from --auto/)
  await run(ctx)
  assert.equal(on, false)
  assert.equal(confirms.length, 4)
  assert.match(toasts.at(-1).message, /already on/)
})
