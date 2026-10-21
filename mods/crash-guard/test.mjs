import test from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyMods } from "../../src/mod-loader.mjs"
import mod from "./index.mjs"
import { collectRefs, fileTokens, planRepair, preflightFile, resolveFileRef, scanTextRefs } from "./preflight.mjs"

const dirs = []
const dir = async () => { const made = await mkdtemp(path.join(tmpdir(), "crash-guard-")); dirs.push(made); return made }
process.on("exit", () => { for (const made of dirs) rmSync(made, { recursive: true, force: true }) })

test("file tokens and upstream-compatible path resolution", () => {
  assert.deepEqual(fileTokens('a {file:/x.key} b {env:Y}'), ["{file:/x.key}"])
  assert.deepEqual(fileTokens("no refs"), [])
  assert.equal(resolveFileRef("{file:/abs/key}", "/cfg", "/home/u"), "/abs/key")
  assert.equal(resolveFileRef("{file:~/keys/k}", "/cfg", "/home/u"), "/home/u/keys/k")
  assert.equal(resolveFileRef("{file:rel/k}", "/cfg", "/home/u"), path.resolve("/cfg", "rel/k"))
})

test("comment lines are skipped when scanning raw text", () => {
  assert.deepEqual(scanTextRefs('// {file:/ghost}\n{"k": "{file:/real}"}'), ["{file:/real}"])
})

test("planRepair keeps healthy configs untouched", async () => {
  const config = { providers: { ok: { settings: { apiKey: "{file:/exists}" } } }, mcp: { servers: { s: { headers: { A: "{file:/exists}" } } } } }
  const plan = await planRepair(config, { configDir: "/cfg", homeDir: "/home/u", exists: async () => true })
  assert.deepEqual(plan.missing, [])
  assert.deepEqual(plan.next, config)
})

test("planRepair drops only entries with missing refs and preserves the rest", async () => {
  const config = {
    model: "m",
    providers: {
      good: { settings: { apiKey: "{file:/exists}" } },
      bad: { settings: { baseURL: "https://x", apiKey: "{file:/gone}" } },
    },
    mcp: {
      servers: { keep: { url: "https://k" }, drop: { headers: { Authorization: "Bearer {file:/gone}" } } },
      legacy: { command: ["{file:/gone}"] },
    },
  }
  const plan = await planRepair(config, { configDir: "/cfg", homeDir: "/home/u", exists: async (p) => p === "/exists" })
  assert.deepEqual(plan.dropProviders, ["bad"])
  assert.deepEqual(plan.dropServers.sort(), ["legacy", "servers.drop"])
  assert.deepEqual(Object.keys(plan.next.providers), ["good"])
  assert.deepEqual(Object.keys(plan.next.mcp.servers), ["keep"])
  assert.ok(!("legacy" in plan.next.mcp))
  assert.equal(plan.next.model, "m")
  assert.deepEqual(plan.unfixable, [])
})

test("planRepair marks refs outside providers/MCP servers unfixable without touching config", async () => {
  const config = { theme: "{file:/gone}" }
  const plan = await planRepair(config, { configDir: "/cfg", homeDir: "/home/u", exists: async () => false })
  assert.equal(plan.missing.length, 1)
  assert.equal(plan.unfixable.length, 1)
  assert.deepEqual(plan.next, config)
})

test("planRepair ignores {env:} refs, which upstream substitutes to empty", async () => {
  const plan = await planRepair({ providers: { p: { settings: { apiKey: "{env:MISSING_VAR}" } } } }, { configDir: "/cfg", homeDir: "/home/u", exists: async () => { throw new Error("must not stat env refs") } })
  assert.deepEqual(plan.missing, [])
})

test("preflightFile ignores a missing config file", async () => {
  const result = await preflightFile(path.join(await dir(), "opencode.json"))
  assert.deepEqual(result, { changed: false })
})

test("preflightFile quarantines a dangling provider with a 0600 backup", async () => {
  const home = await dir()
  const file = path.join(home, "opencode.json")
  const before = JSON.stringify({ model: "m", providers: { apikl: { settings: { apiKey: `{file:${home}/keys/k.key}` } } } })
  await writeFile(file, before)
  const result = await preflightFile(file, { homeDir: home })
  assert.equal(result.changed, true)
  assert.deepEqual(result.droppedProviders, ["apikl"])
  assert.match(result.backup, /crash-guard\.bak$/)
  assert.equal((await stat(result.backup)).mode & 0o777, 0o600)
  assert.equal(await readFile(result.backup, "utf8"), before)
  const next = JSON.parse(await readFile(file, "utf8"))
  assert.deepEqual(next, { model: "m", providers: {} })
})

test("preflightFile leaves JSONC and unparseable files alone with a warning", async () => {
  const home = await dir()
  const jsonc = path.join(home, "opencode.jsonc")
  const before = '{\n// comment\n"providers": { "p": { "settings": { "apiKey": "{file:/gone}" } } }\n}\n'
  await writeFile(jsonc, before)
  const result = await preflightFile(jsonc, { homeDir: home })
  assert.equal(result.changed, false)
  assert.match(result.warning, /JSONC|strict JSON/)
  assert.equal(await readFile(jsonc, "utf8"), before)
})

test("hook quarantines via OPENCODE_CONFIG and posts a startup notice", async () => {
  const home = await dir()
  const file = path.join(home, "opencode.json")
  await writeFile(file, JSON.stringify({ providers: { bad: { settings: { apiKey: "{file:/gone}" } } }, mcp: { servers: { ok: { url: "https://k" } } } }))
  const root = await dir()
  const { emit } = await applyMods([mod], root)
  const context = { args: [], env: { ...process.env, OPENCODE_CONFIG: file, HOME: home }, cwd: home }
  await emit("beforeLaunch", context)
  assert.match(context.env.INFINITEOC_NOTICE, /crash-guard quarantined provider bad/)
  const next = JSON.parse(await readFile(file, "utf8"))
  assert.deepEqual(next.providers, {})
  assert.deepEqual(Object.keys(next.mcp.servers), ["ok"])
})

test("hook registers in register-only mode and never blocks a launch", async () => {
  const root = await dir()
  const { emit } = await applyMods([mod], root, {}, true)
  const context = { args: [], env: { ...process.env, OPENCODE_CONFIG: path.join(await dir(), "absent.json") }, cwd: root }
  await emit("beforeLaunch", context)
  assert.equal(context.env.INFINITEOC_NOTICE, undefined)
})

test("mod self-check: hooks-only, no secrets in notices", async () => {
  assert.equal(mod.id, "crash-guard")
  const seen = []
  await mod.setup({ on: (event, callback) => seen.push([event, callback]) })
  assert.deepEqual(seen.map(([event]) => event), ["beforeLaunch"])
  assert.equal(typeof seen[0][1], "function")
  const home = await dir()
  const file = path.join(home, "opencode.json")
  const secret = `s3krit-${Date.now()}`
  const keyDir = path.join(home, "keys")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(keyDir, { recursive: true })
  const keyFile = path.join(keyDir, "k.key")
  await writeFile(keyFile, secret)
  await chmod(keyFile, 0o600)
  await writeFile(file, JSON.stringify({ providers: { p: { settings: { apiKey: `{file:${keyFile}}` } } } }))
  const context = { args: [], env: { OPENCODE_CONFIG: file, HOME: home }, cwd: home }
  await seen[0][1](context)
  assert.equal(context.env.INFINITEOC_NOTICE, undefined) // healthy config: silent
})
