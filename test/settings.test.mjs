import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, stat, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadSettings, saveSettings, settingsFile, validateTraffic, validateProvider, buildProvider, saveProvider, discoverModels } from "../mods/infiniteoc/settings/settings-store.mjs"
import { installSettings } from "../mods/infiniteoc/settings/index.mjs"
import { applyTraffic } from "../src/traffic.mjs"

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
test("Tor SOCKS host follows the launcher, so a saved host never blocks the next launch", async () => {
  for (const socksHost of ["tor_proxy", "host!", "127.0.0.1:9050", "localhost:9050", "[::1", "user:secret-value@host"]) {
    assert.throws(() => validateTraffic({ mode: "tor", socksHost }), (e) => !e.message.includes(socksHost))
    await assert.rejects(applyTraffic({ mode: "tor", socksHost }, {}))
  }
  for (const socksHost of ["127.0.0.1", "localhost", "tor-host.local", "::1", "[::1]"]) await (await applyTraffic(validateTraffic({ mode: "tor", socksHost }), {})).close()
})
test("only Tor applies the launcher's host rule, so a file saved in another mode keeps launching", () => {
  for (const mode of ["inherit", "direct"]) for (const socksHost of ["localhost:9050", "tor_proxy"]) assert.equal(validateTraffic({ mode, socksHost }).socksHost, socksHost)
})
test("settings pickers mount one footer and ignore Esc mid-save", async () => {
  const source = await readFile(new URL("../mods/infiniteoc/settings/dialog-infiniteoc.tsx", import.meta.url), "utf8")
  // Upstream DialogSelect reads footer twice; inline JSX compiles to a getter whose never-mounted copy's spinner never stops.
  assert.doesNotMatch(source, /footer=\{</)
  // Upstream DialogSelect's Esc ignores locked; leaving mid-save would hide the save's result.
  assert.match(source, /onCancel=\{\(\) => \{ if \(!saving\(\)\) home\(\) \}\}/)
})
test("settings wizard stays large on every step, so one-line safety notes are not clipped", async () => {
  const source = await readFile(new URL("../mods/infiniteoc/settings/dialog-infiniteoc.tsx", import.meta.url), "utf8")
  // Upstream replace() resets to medium and DialogPrompt sets its own size on mount.
  assert.match(source, /dialog\.setSize\("large"\)/)
  assert.match(source, /<DialogPrompt size="large"/)
  assert.ok(source.split('{ size: "large" }').length >= 3) // choose() and the SecretPrompt replace
})
test("provider field errors are static plain Errors, safe to show inline per wizard step", () => {
  for (const [field, value, message] of [["id", "secret-value!", /Provider ID/], ["baseURL", "https://user:secret-value@example.com", /base URL/], ["models", "secret-value#", /model ID/], ["apiKey", "{env:secret-value!}", /environment/]]) {
    assert.throws(() => validateProvider({ ...input, [field]: value }), (e) => e.constructor === Error && !("code" in e) && message.test(e.message) && !e.message.includes("secret-value"))
  }
})
test("provider packages match upstream AISDKNative protocol selection, explicit models required", () => {
  for (const [protocol, pkg] of Object.entries({ anthropic: "@ai-sdk/anthropic", "openai-completions": "@ai-sdk/openai-compatible", "openai-responses": "@ai-sdk/openai", gemini: "@ai-sdk/google" })) {
    const result = buildProvider({ ...input, protocol }, "{env:MY_API_KEY}")
    assert.equal(result.package, pkg)
    assert.deepEqual(result.models["model-a"], { name: "model-a", modelID: "model-a" })
    assert.equal(result.settings.apiKey, "{env:MY_API_KEY}")
  }
  for (const extra of [{ models: "" }, { id: "__proto__" }, { baseURL: "https://user:secret-value@example.com" }, { protocol: "invalid" }]) assert.throws(() => validateProvider({ ...input, ...extra }))
})
test("gemini provider takes a custom base URL and works without an API key", () => {
  const result = buildProvider({ ...input, protocol: "gemini", baseURL: "http://127.0.0.1:8080/v1beta" })
  assert.equal(result.package, "@ai-sdk/google")
  assert.deepEqual(result.settings, { baseURL: "http://127.0.0.1:8080/v1beta" })
})
test("a JSONC overlay beside the config only blocks the provider ID it defines", async () => {
  const dir = await lab(), configFile = path.join(dir, "opencode.json")
  await writeFile(`${configFile}c`, '{\n  // mine\n  "theme": "x", /* c */\n  "providers": { "taken": { "name": "t", }, },\n}\n')
  await saveProvider({ ...input, id: "fresh" }, { configFile, settingsFile: path.join(dir, "settings.json") })
  assert.ok(JSON.parse(await readFile(configFile, "utf8")).providers.fresh)
  await assert.rejects(saveProvider({ ...input, id: "taken" }, { configFile, settingsFile: path.join(dir, "settings.json") }), /already defines/)
  await writeFile(`${configFile}c`, "{ not json")
  await assert.rejects(saveProvider({ ...input, id: "other" }, { configFile, settingsFile: path.join(dir, "settings.json") }), /Could not read the JSONC overlay/)
})
test("model discovery asks each protocol's list with its own auth and never leaks the key", async () => {
  const seen = []
  const reply = (body, ok = true) => async (url, init) => { seen.push({ url, headers: init.headers, redirect: init.redirect }); return { ok, status: ok ? 200 : 401, json: async () => body } }
  const gemini = await discoverModels({ ...input, protocol: "gemini", baseURL: "https://h.example/v1beta/", apiKey: "secret-value" }, { fetch: reply({ models: [{ name: "models/gem-b", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }, { name: "models/gem-a" }] }) })
  assert.deepEqual(gemini, ["gem-a", "gem-b"])
  assert.equal(seen[0].url, "https://h.example/v1beta/models?pageSize=1000")
  assert.equal(seen[0].headers["x-goog-api-key"], "secret-value")
  assert.equal(seen[0].redirect, "error")
  assert.deepEqual(await discoverModels({ ...input, protocol: "openai-completions", apiKey: "{env:K}" }, { env: { K: "k1" }, fetch: reply({ data: [{ id: "m2" }, { id: "m1" }] }) }), ["m1", "m2"])
  assert.equal(seen[1].headers.authorization, "Bearer k1")
  await discoverModels({ ...input, protocol: "anthropic", apiKey: "k2" }, { fetch: reply({ data: [{ id: "c" }] }) })
  assert.equal(seen[2].headers["x-api-key"], "k2")
  await discoverModels({ ...input, protocol: "gemini" }, { fetch: reply({ models: [{ name: "models/x" }] }) })
  assert.equal("x-goog-api-key" in seen[3].headers, false)
  await assert.rejects(discoverModels({ ...input, apiKey: "secret-value" }, { fetch: reply({}, false) }), (e) => /HTTP 401/.test(e.message) && !e.message.includes("secret-value"))
  await assert.rejects(discoverModels({ ...input, apiKey: "secret-value" }, { fetch: async () => { throw new Error("secret-value boom") } }), (e) => /Could not reach/.test(e.message) && !e.message.includes("secret-value"))
  await assert.rejects(discoverModels(input, { fetch: reply({ data: [] }) }), /no models/)
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
  await writeFile(`${configFile}c`, '{ "providers": { "custom": {} } }')
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