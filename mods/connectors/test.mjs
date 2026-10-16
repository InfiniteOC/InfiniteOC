import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CATALOG, CATEGORIES, connect, connectorStatus, disconnect, formatStatus, resolve, serverEntry } from "./connectors.mjs"
import mod, { relink } from "./index.mjs"

const repo = path.resolve(import.meta.dirname, "../..")
const find = (id) => CATALOG.find((entry) => entry.id === id)

async function fixture(t, existing) {
  const dir = await mkdtemp(path.join(tmpdir(), "ioc-connect-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const configFile = path.join(dir, "opencode", "opencode.json")
  const keysDir = path.join(dir, "infiniteoc", "keys")
  if (existing) {
    await mkdir(path.dirname(configFile), { recursive: true })
    await writeFile(configFile, JSON.stringify(existing, null, 2))
  }
  return { dir, configFile, keysDir, read: async () => JSON.parse(await readFile(configFile, "utf8")) }
}

test("catalog: unique ids, known categories, https remotes, npx/uvx/bunx/xcrun locals", () => {
  const ids = CATALOG.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const entry of CATALOG) {
    assert.match(entry.id, /^[a-z0-9][a-z0-9-]*$/, entry.id)
    assert.ok(CATEGORIES.includes(entry.category), `${entry.id}: ${entry.category}`)
    if (entry.kind === "remote") assert.match(entry.url, /^https:\/\//, entry.id)
    else assert.ok(["npx", "uvx", "bunx", "xcrun"].includes(entry.command[0]), entry.id)
    for (const item of entry.vars ?? []) assert.ok(item.help && /^[A-Z][A-Z0-9_]*$/.test(item.name), `${entry.id}.${item.name}`)
    if (entry.auth === "token") assert.equal(entry.vars?.[0]?.secret, true, entry.id)
  }
  // Every category has members, and the families asked for are there.
  for (const category of CATEGORIES) assert.ok(CATALOG.some((entry) => entry.category === category), category)
  assert.ok(CATALOG.filter((entry) => entry.category === "Cloudflare").length >= 16)
  for (const id of ["discord", "telegram", "imessage", "xcode", "google-workspace", "gcloud", "cloudflare"]) assert.ok(find(id), id)
  // Servers that only take pre-registered clients would never finish signing in.
  for (const id of ["slack", "hubspot", "box", "pagerduty", "render"]) assert.equal(find(id), undefined, id)
})

test("catalog: secret-receiving community servers are pinned; Telegram never comes from PyPI's unrelated package", () => {
  const telegram = find("telegram")
  assert.ok(telegram.command.includes("--from"))
  assert.match(telegram.command.join(" "), /git\+https:\/\/github\.com\/chigwell\/telegram-mcp\.git@[0-9a-f]{40} telegram-mcp$/)
  assert.ok(telegram.vars.find((item) => item.name === "TELEGRAM_SESSION_STRING").help.includes("@c1e3dc4adff27a6935852309bf0218f1ac4cd766"))
  for (const [id, pin] of [["discord", "mcp-discord@1.3.4"], ["imessage", "mac-messages-mcp@1.1.0"], ["google-workspace", "workspace-mcp@2.1.0"], ["obsidian", "mcp-obsidian@0.2.3"]])
    assert.ok(find(id).command.includes(pin), id)
  for (const id of ["xcode", "xcodebuild", "apple-apps", "imessage", "macos-automator"]) assert.equal(find(id).platform, "darwin", id)
})

test("entries map to OpenCode's MCP server shape", () => {
  assert.deepEqual(serverEntry(find("linear")), { type: "remote", url: "https://mcp.linear.app/mcp" })
  assert.deepEqual(serverEntry(find("github"), { GITHUB_PERSONAL_ACCESS_TOKEN: "{env:GITHUB_PERSONAL_ACCESS_TOKEN}" }), {
    type: "remote", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer {env:GITHUB_PERSONAL_ACCESS_TOKEN}" }, oauth: false,
  })
  // Google API keys use their own header, without "Bearer".
  assert.deepEqual(serverEntry(find("google-maps"), { GOOGLE_MAPS_API_KEY: "{file:/k}" }).headers, { "X-Goog-Api-Key": "{file:/k}" })
  assert.equal(serverEntry(find("context7")).oauth, false)
  assert.equal(serverEntry(find("square")).protocol, "sse")
  assert.deepEqual(serverEntry(find("playwright")), { type: "local", command: ["npx", "-y", "@playwright/mcp@latest"] })
  assert.equal(serverEntry(find("postgres"), { DATABASE_URL: "{env:DATABASE_URL}" }).command.at(-1), "{env:DATABASE_URL}")
  const telegram = serverEntry(find("telegram"), { TELEGRAM_API_ID: "123", TELEGRAM_API_HASH: "{file:/a}", TELEGRAM_SESSION_STRING: "{file:/b}" })
  assert.deepEqual(telegram.environment, { TELEGRAM_API_ID: "123", TELEGRAM_API_HASH: "{file:/a}", TELEGRAM_SESSION_STRING: "{file:/b}" })
  assert.equal(serverEntry(find("aws")).environment, undefined)
})

test("connect keeps every other key, backs up the file and refuses to replace without force", async (t) => {
  const { configFile, keysDir, read } = await fixture(t, { $schema: "x", providers: { p: { name: "p" } }, mcp: { servers: { blender: { type: "local", command: ["uvx", "blender-mcp"] } } } })
  const result = await connect("linear", { configFile, keysDir, env: {} })
  const config = await read()
  assert.deepEqual(config.providers, { p: { name: "p" } })
  assert.equal(config.$schema, "x")
  assert.deepEqual(Object.keys(config.mcp.servers), ["blender", "linear"])
  assert.ok(result.backup && (await stat(result.backup)).isFile())
  assert.ok(result.next.some((line) => line.includes("infiniteoc mcp auth linear")))
  await assert.rejects(connect("linear", { configFile, keysDir, env: {} }), /already configured/)
  await connect("linear", { configFile, keysDir, env: {}, force: true })
  await assert.rejects(connect("nope", { configFile, keysDir }), /Unknown connector/)
})

test("typed secrets go to 0600 key files, plain values are stored, empty required values read the environment", async (t) => {
  const { configFile, keysDir, read } = await fixture(t)
  const hash = "0123456789abcdef0123456789abcdef"
  const result = await connect("telegram", { configFile, keysDir, values: { TELEGRAM_API_ID: "4242", TELEGRAM_API_HASH: hash }, env: {} })
  const text = await readFile(configFile, "utf8")
  assert.ok(!text.includes(hash))
  const environment = (await read()).mcp.servers.telegram.environment
  assert.equal(environment.TELEGRAM_API_ID, "4242")
  assert.match(environment.TELEGRAM_API_HASH, /^\{file:.*mcp-telegram-.*\.key\}$/)
  assert.equal(environment.TELEGRAM_SESSION_STRING, "{env:TELEGRAM_SESSION_STRING}")
  assert.equal(result.keyFiles.length, 1)
  assert.equal(await readFile(result.keyFiles[0], "utf8"), hash)
  if (process.platform !== "win32") assert.equal((await stat(result.keyFiles[0])).mode & 0o777, 0o600)
  assert.ok(result.next.some((line) => line.includes("TELEGRAM_SESSION_STRING")))
  // Optional values left empty are omitted entirely.
  await connect("aws", { configFile, keysDir, values: { AWS_REGION: "eu-west-1" }, env: {} })
  assert.deepEqual((await read()).mcp.servers.aws.environment, { AWS_REGION: "eu-west-1" })
  // Disconnect removes the server and every key file this command created for it.
  await disconnect("telegram", { configFile, keysDir })
  assert.equal((await read()).mcp.servers.telegram, undefined)
  assert.deepEqual(await readdir(keysDir), [])
})

test("status reports missing environment values and platform limits", async (t) => {
  const { configFile, keysDir } = await fixture(t)
  await connect("discord", { configFile, keysDir, env: {} })
  const rows = await connectorStatus({ configFile, env: {}, platform: "linux" })
  assert.deepEqual(rows.find((row) => row.id === "discord").missing, ["DISCORD_TOKEN"])
  assert.equal(rows.find((row) => row.id === "imessage").unsupported, "macOS only")
  assert.equal((await connectorStatus({ configFile, env: {}, platform: "darwin" })).find((row) => row.id === "imessage").unsupported, undefined)
  assert.deepEqual((await connectorStatus({ configFile, env: { DISCORD_TOKEN: "x" } })).find((row) => row.id === "discord").missing, [])
  assert.match(formatStatus(rows), /● discord .*\[needs DISCORD_TOKEN\]/)
  assert.match(formatStatus(rows), /○ imessage .*\[macOS only\]/)
  const imessage = await connect("imessage", { configFile, keysDir, env: {}, platform: "linux" })
  assert.ok(imessage.next[0].includes("macOS only"))
})

test("resolve expands {env:} and {file:} the way OpenCode does when loading the config", async (t) => {
  const { dir } = await fixture(t)
  const key = path.join(dir, "k")
  await writeFile(key, "s3cret\n")
  assert.deepEqual(
    await resolve({ headers: { Authorization: `Bearer {file:${key}}` }, environment: { A: "{env:A}", B: "lit" }, command: ["x", `{file:${key}}`] }, { A: "aa" }),
    { headers: { Authorization: "Bearer s3cret" }, environment: { A: "aa", B: "lit" }, command: ["x", "s3cret"] },
  )
})

test("bad input and JSONC are refused without writing", async (t) => {
  const { dir, configFile, keysDir } = await fixture(t, {})
  await assert.rejects(connect("linear", { configFile: path.join(dir, "x.jsonc"), keysDir }), /JSONC/)
  await writeFile(`${configFile}c`, "{}")
  await assert.rejects(connect("linear", { configFile, keysDir }), /would override/)
  await rm(`${configFile}c`)
  await assert.rejects(connect("github", { configFile, keysDir, values: { GITHUB_PERSONAL_ACCESS_TOKEN: "a\nb" } }), /Invalid value/)
  await assert.rejects(connect("bigquery", { configFile, keysDir, values: { BIGQUERY_PROJECT: "{env:X}" } }), /cannot contain/)
  await assert.rejects(disconnect("linear", { configFile, keysDir }), /not configured/)
  await assert.rejects(disconnect("../x", { configFile, keysDir }), /Invalid/)
  assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), {})
  assert.equal(existsSync(keysDir), false)
})

test("the TUI copy imports its neighbours in component/", async () => {
  const source = relink(await readFile(new URL("./connectors.mjs", import.meta.url), "utf8"))
  assert.match(source, /from "\.\/settings-store\.mjs"/)
  assert.match(source, /from "\.\/connectors-catalog\.mjs"/)
  assert.throws(() => relink('import x from "../elsewhere.mjs"'), /unmapped/)
})

test("applies to the pinned upstream: /apps beside /mcps, dialog and libraries in component/", { skip: !existsSync(path.join(repo, ".upstream/packages/tui/src/app.tsx")) && "no pinned upstream" }, async () => {
  const files = new Map()
  const read = async (file) => files.get(file) ?? readFile(path.join(repo, ".upstream", file), "utf8")
  const api = {
    write: async (file, text) => void files.set(file, text),
    read,
    patchExact: async (file, before, after) => {
      const source = await read(file)
      assert.equal(source.split(before).length, 2, `one anchor in ${file}`)
      files.set(file, source.replace(before, () => after))
    },
  }
  await mod.setup(api)
  const app = files.get("packages/tui/src/app.tsx")
  assert.match(app, /import \{ DialogApps \} from "\.\/component\/dialog-apps"/)
  assert.match(app, /slash: \{ name: "mcps" \},[\s\S]{0,120}name: "infiniteoc\.apps"[\s\S]{0,200}slash: \{ name: "apps", aliases: \["connectors"\] \}/)
  for (const name of ["connectors-catalog.mjs", "connectors-lib.mjs", "dialog-apps.tsx"]) assert.ok(files.has(`packages/tui/src/component/${name}`), name)
  // Every relative import of the dialog exists upstream or is written by this mod or mods/infiniteoc.
  const dialog = files.get("packages/tui/src/component/dialog-apps.tsx")
  const own = new Set(["./connectors-lib.mjs", "./dialog-infiniteoc"])
  for (const [, spec] of dialog.matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
    if (own.has(spec)) continue
    const base = path.join(repo, ".upstream/packages/tui/src/component", spec)
    assert.ok([".tsx", ".ts", "/index.ts", "/index.tsx", ""].some((ext) => existsSync(base + ext)), spec)
  }
  // The app's slash names must not collide: "apps" and "connectors" are not upstream commands.
  const upstream = await readFile(path.join(repo, ".upstream/packages/tui/src/app.tsx"), "utf8")
  assert.doesNotMatch(upstream, /name: "(apps|connectors)"/)
})
