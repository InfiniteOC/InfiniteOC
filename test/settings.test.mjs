import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, stat, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadSettings, saveSettings, settingsFile, validateTraffic, validateProvider, buildProvider, saveProvider } from "../mods/infiniteoc/settings/settings-store.mjs"
import { installSettings } from "../mods/infiniteoc/settings/index.mjs"

const lab = () => mkdtemp(path.join(os.tmpdir(), "infiniteoc-settings-"))
const input = { id: "custom", protocol: "anthropic", baseURL: "https://example.com/v1", models: "model-a,model-b" }
test("settings defaults, env override, atomic mode-600 roundtrip", async () => {
  const dir = await lab(), file = path.join(dir, "settings.json")
  assert.equal(settingsFile({ INFINITEOC_SETTINGS_FILE: file }), file)
  const defaults = await loadSettings(file)
  assert.equal(defaults.traffic.mode, "inherit")
  assert.equal(defaults.traffic.socksHost, "127.0.0.1")
  assert.equal(defaults.traffic.socksPort, 9050)
  await saveSettings({ ...defaults, traffic: { mode: "tor" }, extra: 42 }, file)
  assert.equal((await loadSettings(file)).extra, 42)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(dir), ["settings.json"])
})
test("traffic rejects invalid modes, URLs, ports, no-proxy injection without echoing values", () => {
  for (const traffic of [{ mode: "bad" }, { mode: "proxy", proxyURL: "secret-value" }, { mode: "proxy", proxyURL: "ftp://example.com" }, { socksPort: 0 }, { socksPort: 65536 }, { socksPort: 1.5 }, { noProxy: "localhost\nsecret-value" }]) {
    assert.throws(() => validateTraffic(traffic), (e) => !e.message.includes("secret-value"))
  }
  for (const scheme of ["http", "https", "socks5", "socks5h"]) assert.equal(validateTraffic({ mode: "proxy", proxyURL: `${scheme}://127.0.0.1:9050` }).mode, "proxy")
})
test("provider packages match upstream AISDKNative protocol selection, explicit models required", () => {
  for (const [protocol, pkg] of Object.entries({ anthropic: "@ai-sdk/anthropic", "openai-completions": "@ai-sdk/openai-compatible", "openai-responses": "@ai-sdk/openai" })) {
    const result = buildProvider({ ...input, protocol }, "{env:MY_API_KEY}")
    assert.equal(result.package, pkg)
    assert.deepEqual(result.models["model-a"], { name: "model-a", modelID: "model-a" })
    assert.equal(result.settings.apiKey, "{env:MY_API_KEY}")
  }
  for (const extra of [{ models: "" }, { id: "__proto__" }, { baseURL: "https://user:secret-value@example.com" }, { protocol: "invalid" }]) assert.throws(() => validateProvider({ ...input, ...extra }))
})
test("save provider preserves existing JSON, backs up mode600, isolates raw keys", async () => {
  const dir = await lab(), configFile = path.join(dir, "opencode.json"), file = path.join(dir, "settings.json")
  const original = JSON.stringify({ permissions: [{ tool: "bash", action: "deny" }], provider: { legacy: { npm: "whatever" } }, providers: { other: { settings: { x: true } } }, unknown: 42 })
  await writeFile(configFile, original)
  const result = await saveProvider({ ...input, apiKey: "secret-value" }, { configFile, settingsFile: file })
  const raw = await readFile(configFile, "utf8"), parsed = JSON.parse(raw)
  assert.equal(raw.includes("secret-value"), false)
  assert.equal(JSON.stringify(result).includes("secret-value"), false)
  assert.deepEqual(parsed.permissions, JSON.parse(original).permissions)
  assert.deepEqual(parsed.providers.other, { settings: { x: true } })
  assert.equal(parsed.unknown, 42)
  assert.equal(await readFile(result.backup, "utf8"), original)
  assert.equal((await stat(result.backup)).mode & 0o777, 0o600)
  assert.equal((await stat(configFile)).mode & 0o777, 0o600)
  const keyFile = parsed.providers.custom.settings.apiKey.slice(6, -1)
  assert.equal(await readFile(keyFile, "utf8"), "secret-value")
  assert.equal((await stat(keyFile)).mode & 0o777, 0o600)
  await assert.rejects(saveProvider(input, { configFile, settingsFile: file }), /already exists/)
})
test("environment API key references survive unchanged", async () => {
  const dir = await lab(), configFile = path.join(dir, "opencode.json")
  await saveProvider({ ...input, apiKey: "{env:MY_API_KEY}" }, { configFile })
  assert.equal(JSON.parse(await readFile(configFile, "utf8")).providers.custom.settings.apiKey, "{env:MY_API_KEY}")
  assert.deepEqual(await readdir(dir), ["opencode.json"])
})
test("malformed JSON/JSONC overlays rejected without modification", async () => {
  const dir = await lab(), configFile = path.join(dir, "opencode.json")
  for (const raw of ["//comment\n{}", '{"providers": {},}', '[]']) {
    await writeFile(configFile, raw)
    await assert.rejects(saveProvider(input, { configFile }))
    assert.equal(await readFile(configFile, "utf8"), raw)
  }
  await writeFile(configFile, "{}")
  await writeFile(`${configFile}c`, "{}")
  await assert.rejects(saveProvider(input, { configFile }), /JSONC overlay/)
  assert.equal(await readFile(configFile, "utf8"), "{}")
  await assert.rejects(saveProvider(input, { configFile: `${configFile}c` }), /JSONC/)
})
test("installer uses exact upstream anchors, is idempotent, fails closed", async () => {
  let source = await readFile(new URL("../.upstream/packages/tui/src/component/dialog-config.tsx", import.meta.url), "utf8")
  const files = new Map()
  const api = { write: async (name, contents) => files.set(name, contents), patch: async (_, fn) => { source = fn(source) } }
  await installSettings(api)
  const once = source
  await installSettings(api)
  assert.equal(source, once)
  assert.equal(files.size, 3)
  assert.match(source, /dialog\.replace\(\(\) => <DialogInfiniteOC/)
  await assert.rejects(installSettings({ ...api, patch: async (_, fn) => fn("incompatible") }), /incompatible upstream/)
})