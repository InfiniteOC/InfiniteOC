import test from "node:test"
import assert from "node:assert/strict"
import { readFile, mkdtemp, readFile as read, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import module from "node:module"
import infiniteoc from "../infiniteoc/index.mjs"
import mod from "./index.mjs"

const skip = !module.stripTypeScriptTypes && "needs Node type stripping"
const lib = await import("./lib.ts").catch(() => ({}))

test("budget notes round-trip and the latest note wins", { skip }, () => {
  assert.equal(lib.parseAmount("5"), 5)
  assert.equal(lib.parseAmount("$2.50"), 2.5)
  for (const bad of ["", "0", "-1", "abc", "1e3", "5 dollars"]) assert.equal(lib.parseAmount(bad), undefined, bad)
  const note = (limit) => ({ type: "synthetic", text: lib.budgetNote(limit) })
  assert.equal(lib.budgetLimit([note(5)]), 5)
  assert.equal(lib.budgetLimit([note(5), { type: "user", text: "hi" }, note(7.5)]), 7.5)
  assert.equal(lib.budgetLimit([note(5), note(undefined)]), undefined)
  assert.equal(lib.budgetLimit([{ type: "user", text: "hi" }]), undefined)
  assert.ok(lib.overBudget(5, 5) && lib.overBudget(5, 5.01) && !lib.overBudget(5, 4.99) && !lib.overBudget(undefined, 100))
  assert.match(lib.budgetRefusal(5, 5.2), /\/budget <amount>/)
})

test("goalActive follows the last goal control note", { skip }, () => {
  const note = (text) => ({ type: "synthetic", text })
  assert.equal(lib.goalActive([]), false)
  assert.equal(lib.goalActive([{ type: "user", text: "[InfiniteOC goal]\nGoal: x" }]), true)
  assert.equal(lib.goalActive([{ type: "user", text: "[InfiniteOC goal]\nGoal: x" }, note("[InfiniteOC goal: continue]\nGoal: x")]), true)
  assert.equal(lib.goalActive([{ type: "user", text: "[InfiniteOC goal]\nGoal: x" }, note(lib.stopGoalNote(5, 5.1))]), false)
  assert.equal(lib.goalActive([note("[InfiniteOC goal: finished]\nx")]), false)
})

test("fallback also takes over quota 429s that the runner would not retry", async () => {
  const source = await readFile(new URL("./plugin.ts", import.meta.url), "utf8")
  const hook = source.slice(source.indexOf('ctx.session.hook("retry"'), source.indexOf("// Offline with a local model configured"))
  assert.match(hook, /if \(!backup \|\| !lib\.failsOver\(event\.error\)\) return/)
  assert.doesNotMatch(hook, /event\.decision\.retry \|\|/)
  assert.match(hook, /event\.decision = \{ retry: true, delay: 500 \}/)
})

test("fallback only for rate limits and server errors", { skip }, () => {
  for (const error of [{ status: 429 }, { status: 500 }, { status: 503 }, { type: "rate_limit_exceeded" }, { type: "overloaded_error" }, { type: "provider.free-limit" }]) assert.ok(lib.failsOver(error), JSON.stringify(error))
  for (const error of [{ status: 401 }, { status: 400 }, { status: 404 }, { type: "invalid_request" }, {}]) assert.ok(!lib.failsOver(error), JSON.stringify(error))
})

test("offline and battery detection", { skip }, () => {
  const lan = { en0: [{ address: "192.168.1.5", internal: false, family: "IPv4" }], lo0: [{ address: "127.0.0.1", internal: true, family: "IPv4" }] }
  const down = { lo0: lan.lo0, en0: [{ address: "169.254.3.4", internal: false, family: "IPv4" }, { address: "fe80::1", internal: false, family: "IPv6" }] }
  assert.equal(lib.offline(lan, {}), false)
  assert.equal(lib.offline(down, {}), true)
  assert.equal(lib.offline({}, {}), true)
  assert.equal(lib.offline(lan, { INFINITEOC_OFFLINE: "1" }), true)
  assert.equal(lib.offline(down, { INFINITEOC_OFFLINE: "0" }), false)
  assert.ok(lib.onBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 80%"))
  assert.ok(!lib.onBattery("Now drawing from 'AC Power'"))
})

test("env diff reports names only, never values", { skip }, () => {
  const example = "# comment\nDATABASE_URL=\nexport API_KEY=changeme\nPORT=3000\nEMPTY_OK=\n\nQUOTED=\"x\"\n"
  const env = "DATABASE_URL=postgres://user:hunter2@db/app\nAPI_KEY=\nPORT=8080\nEXTRA_TOKEN=secret-value\nQUOTED=''\n"
  const diff = lib.envDiff(example, env)
  assert.deepEqual(diff, { missing: ["EMPTY_OK"], empty: ["API_KEY", "QUOTED"], extra: ["EXTRA_TOKEN"] })
  const text = lib.formatEnvDiff(diff, { example: ".env.example", env: ".env" })
  for (const secret of ["hunter2", "secret-value", "postgres", "changeme", "8080"]) assert.ok(!text.includes(secret), secret)
  assert.match(lib.formatEnvDiff({ missing: [], empty: [], extra: [] }, { example: "a", env: "b" }), /has every key/)
})

test("compose services parse from JSON lines and arrays; only running ones produce a note", { skip }, () => {
  const web = { Service: "web", Name: "app-web-1", State: "running" }
  const db = { Service: "db", Name: "app-db-1", State: "exited" }
  assert.deepEqual(lib.composeServices([web, db].map((row) => JSON.stringify(row)).join("\n")).map((item) => item.service), ["web", "db"])
  assert.equal(lib.composeServices(JSON.stringify([web])).length, 1)
  assert.deepEqual(lib.composeServices("not json\n"), [])
  assert.match(lib.dockerNote(lib.composeServices(JSON.stringify([web, db]))), /web\b.*docker compose exec/)
  assert.doesNotMatch(lib.dockerNote(lib.composeServices(JSON.stringify([web, db]))), /\bdb\b/)
  assert.equal(lib.dockerNote(lib.composeServices(JSON.stringify([db]))), undefined)
})

test("usage aggregates by day, project and provider", { skip }, () => {
  const rows = [
    { day: "2026-10-10", project: "/h/a", provider: "anthropic", cost: 1.5 },
    { day: "2026-10-10", project: "/h/b", provider: "openai", cost: 0.5 },
    { day: "2026-10-11", project: "/h/a", provider: "anthropic", cost: 2 },
    { day: "2026-10-11", project: "/h/a", provider: "anthropic", cost: 0 },
  ]
  const usage = lib.aggregateUsage(rows)
  assert.equal(usage.total, 4)
  assert.deepEqual(usage.days, [["2026-10-11", 2], ["2026-10-10", 2]])
  assert.deepEqual(usage.projects, [["/h/a", 3.5], ["/h/b", 0.5]])
  assert.deepEqual(usage.providers, [["anthropic", 3.5], ["openai", 0.5]])
  assert.match(lib.formatUsage(usage, "/h"), /Total \$4\.00[\s\S]*By day[\s\S]*~\/a[\s\S]*By provider/)
  assert.match(lib.formatUsage(lib.aggregateUsage([])), /No priced usage/)
})

test("local runtime model lists", { skip }, () => {
  assert.deepEqual(lib.parseLocalModels("ollama", { models: [{ name: "llama3.2:latest" }, { name: "nomic-embed-text:latest" }, { name: "llama3.2:latest" }] }), ["llama3.2:latest"])
  assert.deepEqual(lib.parseLocalModels("lmstudio", { data: [{ id: "qwen2.5-7b" }, { id: "text-embedding-nomic" }] }), ["qwen2.5-7b"])
  assert.deepEqual(lib.parseLocalModels("ollama", null), [])
})

test("free_port returns a port that can be bound", { skip }, async () => {
  const { createServer } = await import("node:net")
  const port = await lib.freePort()
  assert.ok(port > 0 && port < 65536)
  await new Promise((resolve, reject) => createServer().once("error", reject).listen(port, "127.0.0.1", function () { this.close(resolve) }))
})

test("free_port honors INFINITEOC_PORT_RANGE and reports a full range", { skip }, async () => {
  const { createServer } = await import("node:net")
  const range = "19138-19139"
  const first = await lib.freePort(range)
  assert.ok(first >= 19138 && first <= 19139, String(first))
  const held = []
  for (const port of [19138, 19139]) held.push(await new Promise((resolve, reject) => { const server = createServer().once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)) }))
  try {
    await assert.rejects(lib.freePort(range), /No free port in 19138-19139/)
  } finally {
    for (const server of held) server.close()
  }
})

test("long project paths are shortened in the usage table", { skip }, () => {
  const long = "/Users/someone/Documents/Projects/a-very-long-directory-name/with/many/nested/segments/app"
  const text = lib.formatUsage(lib.aggregateUsage([{ day: "2026-10-12", project: long, provider: "p", cost: 1 }]), "/nowhere")
  const row = text.split("\n").find((line) => line.includes("segments/app"))
  assert.ok(row.trim().split(/\s+/)[1].length <= 44, row)
  assert.match(row, /\.\.\./)
})

test("model settings are written atomically, validated, and keep other keys", { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prov-"))
  const file = path.join(dir, "settings.json")
  try {
    await writeFile(file, JSON.stringify({ traffic: { mode: "tor" }, updates: { mode: "off" } }))
    lib.writeModelSetting("cheap", "lab/haiku", file)
    lib.writeModelSetting("fallback", "lab/backup", file)
    let saved = JSON.parse(await read(file, "utf8"))
    assert.deepEqual(saved, { traffic: { mode: "tor" }, updates: { mode: "off" }, routing: { cheap: "lab/haiku" }, fallback: { model: "lab/backup" } })
    assert.equal(lib.configuredModel(saved, "cheap"), "lab/haiku")
    assert.equal(lib.configuredModel(saved, "strong"), undefined)
    lib.writeModelSetting("cheap", undefined, file)
    saved = JSON.parse(await read(file, "utf8"))
    assert.deepEqual(saved.routing, {})
    assert.ok(!lib.isModelRef("nomodel") && !lib.isModelRef("a/") && lib.isModelRef("p/m#high"))
    await writeFile(file, "{ not json")
    assert.throws(() => lib.writeModelSetting("local", "x/y", file), /not strict JSON/)
    assert.equal(await read(file, "utf8"), "{ not json")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const root = path.resolve(import.meta.dirname, "../../.upstream")
async function apply() {
  const files = new Map()
  const api = (options) => ({
    root,
    options,
    tui: { command() {} },
    on() {},
    async read(file) { return files.get(file) ?? read(path.join(root, file), "utf8") },
    async patch(file, transform) { files.set(file, await transform(files.get(file) ?? await read(path.join(root, file), "utf8"))) },
    async write(file, content) { files.set(file, content) },
  })
  await infiniteoc.setup(api({ reducedMotion: false }))
  const commands = []
  const hooks = []
  await mod.setup({ ...api({}), tui: { command: (input) => commands.push(input) }, on: (event, handler) => hooks.push([event, handler]) })
  return { files, commands, hooks }
}

test("applies after mods/infiniteoc: plugin before /goal, guidance, battery default, four commands", async () => {
  const { files, commands, hooks } = await apply()
  const internal = files.get("packages/core/src/plugin/internal.ts")
  assert.match(internal, /import \* as InfiniteocProv from "\.\/infiniteoc-prov\.js"\nimport \* as InfiniteocGoal/)
  assert.match(internal, /  InfiniteocProv\.Plugin,\n  InfiniteocGoal\.Plugin,\n  InfiniteocFrontend\.Plugin,/)
  assert.match(files.get("packages/core/src/infiniteoc/guidance.ts"), /infiniteocGuidance\.build\.push\(.*free_port[\s\S]*\/\/ infiniteoc:guidance-extensions\n$/)
  assert.match(files.get("packages/tui/src/config/index.tsx"), /animations: input\.animations \?\? \(process\.env\.INFINITEOC_BATTERY === "1" \? false : undefined\) \?\? true,/)
  assert.deepEqual(commands.map((command) => command.slash).sort(), ["envdiff", "local", "serve", "usage"])
  for (const command of commands) assert.match(command.source, /export (async )?function run\(/)
  assert.equal(files.get("packages/tui/src/infiniteoc-features/prov-lib.ts"), files.get("packages/core/src/plugin/infiniteoc-prov-lib.ts"))
  const [, beforeLaunch] = hooks.find(([event]) => event === "beforeLaunch")
  const env = process.env.INFINITEOC_BATTERY
  try {
    for (const [value, expected] of [["1", "1"], ["0", undefined]]) {
      process.env.INFINITEOC_BATTERY = value
      const context = { env: {} }
      beforeLaunch(context)
      assert.equal(context.env.INFINITEOC_BATTERY, expected)
    }
  } finally {
    if (env === undefined) delete process.env.INFINITEOC_BATTERY
    else process.env.INFINITEOC_BATTERY = env
  }
})

test("anchors fail closed when /goal's registration is missing", async () => {
  const files = new Map()
  const api = {
    root, options: {}, tui: { command() {} }, on() {},
    async read(file) { return read(path.join(root, file), "utf8") },
    async patch(file, transform) { files.set(file, await transform(await read(path.join(root, file), "utf8"))) },
    async write() {},
  }
  await assert.rejects(mod.setup(api), /expected one source anchor/)
})

test("the server plugin only refuses tools for the budget and never touches provider secrets", async () => {
  const plugin = await readFile(new URL("./plugin.ts", import.meta.url), "utf8")
  assert.match(plugin, /ctx\.tool\.hook\("execute\.before"/)
  assert.doesNotMatch(plugin, /apiKey|\.key\b|process\.env\.[A-Z_]*KEY/)
  // env_diff must only ever return names.
  assert.match(plugin, /formatEnvDiff/)
})
