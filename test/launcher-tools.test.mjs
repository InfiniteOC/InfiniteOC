import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runWizard } from "../src/wizard.mjs"
import { loadSettings } from "../mods/infiniteoc/settings/settings-store.mjs"
import { applyTeam, mergeTeam, readTeamFile } from "../src/team.mjs"
import { isCrash, redact, writeCrashReport } from "../src/crash.mjs"
import { missingPaths, repairPaths } from "../src/mcp-paths.mjs"

const lab = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "infiniteoc-tools-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const scripted = (answers) => {
  const said = []
  return { said, say: (text) => said.push(text), ask: async (question) => { said.push(question); return answers.length ? answers.shift() : undefined } }
}

test("the wizard adds a provider, picks its model, theme, update mode and ponytail level", async (t) => {
  const dir = await lab(t)
  const env = { XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data") }
  const settingsPath = join(dir, "settings.json"), configFile = join(dir, "config/opencode/opencode.json")
  await mkdir(join(dir, "config/opencode"), { recursive: true })
  await writeFile(configFile, JSON.stringify({ username: "kept" }))
  const io = scripted(["y", "2", "lab", "http://127.0.0.1:19140/v1", "fake, haiku", "sk-secret-value", "2", "3", "ask", "full"])
  const result = await runWizard({ io, env, settingsPath, configFile })
  assert.deepEqual(result.done, ["provider lab", "model lab/haiku", "theme catppuccin", "updates ask", "ponytail full"])
  const config = JSON.parse(await readFile(configFile, "utf8"))
  assert.equal(config.model, "lab/haiku")
  assert.equal(config.username, "kept")
  assert.deepEqual(Object.keys(config.providers.lab.models), ["fake", "haiku"])
  assert.doesNotMatch(await readFile(settingsPath, "utf8"), /sk-secret-value/)
  assert.equal((await loadSettings(settingsPath)).updates.mode, "ask")
  assert.equal((await loadSettings(settingsPath)).wizard.done, true)
  assert.equal(JSON.parse(await readFile(join(dir, "config/opencode/cli.json"), "utf8")).theme.name, "catppuccin")
  assert.equal(await readFile(join(dir, "config/opencode/.ponytail-active"), "utf8"), "full")
  assert.ok((await readdir(join(dir, "config/opencode"))).some((name) => name.endsWith(".bak")), "the config was backed up")
})

test("the wizard defaults change nothing, and an early Ctrl+C still ends it for good", async (t) => {
  const dir = await lab(t)
  const env = { XDG_CONFIG_HOME: join(dir, "config") }
  const settingsPath = join(dir, "settings.json"), configFile = join(dir, "opencode.json")
  const result = await runWizard({ io: scripted(["", "", "", "", "", ""]), env, settingsPath, configFile })
  assert.deepEqual(result, { done: [], aborted: false })
  assert.equal((await loadSettings(settingsPath)).wizard.done, true)
  const again = await runWizard({ io: scripted([]), env, settingsPath, configFile })
  assert.equal(again.aborted, true)
  await assert.rejects(readFile(join(dir, "config/opencode/cli.json")), { code: "ENOENT" })
})

test("a bad provider is reported and can be retried", async (t) => {
  const dir = await lab(t)
  const settingsPath = join(dir, "settings.json"), configFile = join(dir, "opencode.json")
  const io = scripted(["y", "1", "p", "not a url", "m", "", "p", "", "m1", "", "1", "", "", ""])
  const result = await runWizard({ io, env: { XDG_CONFIG_HOME: dir }, settingsPath, configFile })
  assert.ok(io.said.some((line) => /Could not add the provider/.test(line)))
  assert.deepEqual(result.done.slice(0, 2), ["provider p", "model p/m1"])
})

test("team settings sit under personal ones, need approval, and only allowlisted keys apply", async (t) => {
  const dir = await lab(t)
  const project = join(dir, "project/src")
  await mkdir(project, { recursive: true })
  await mkdir(join(dir, "project/.git"))
  const teamPath = join(dir, "project", "infiniteoc.team.json")
  await writeFile(teamPath, JSON.stringify({ traffic: { mode: "proxy", proxyURL: "http://proxy.corp:3128" }, updates: { mode: "ask" }, mods: ["./evil.mjs"], providers: { x: {} } }))
  const file = join(dir, "settings.json")
  const save = async (value, path) => writeFile(path, JSON.stringify(value))
  const load = (path) => loadSettings(path)
  const team = await readTeamFile(teamPath)
  assert.deepEqual(team.ignored.sort(), ["mods", "providers"])

  // Not approved and no terminal: not applied.
  let result = await applyTeam({ file, cwd: project, ask: undefined, load, save })
  assert.equal(result.saved.traffic.mode, "inherit")
  assert.match(result.notices.join("\n"), /not applied; run infiniteoc team trust/)
  // Declined at the prompt.
  result = await applyTeam({ file, cwd: project, ask: async () => "n", load, save })
  assert.equal(result.saved.traffic.mode, "inherit")
  // Approved: the team proxy applies, and the approval is remembered.
  result = await applyTeam({ file, cwd: project, ask: async () => "y", load, save })
  assert.equal(result.saved.traffic.proxyURL, "http://proxy.corp:3128")
  assert.equal(result.saved.updates.mode, "ask")
  assert.equal(result.saved.mods, undefined)
  result = await applyTeam({ file, cwd: project, ask: undefined, load, save })
  assert.equal(result.saved.traffic.mode, "proxy", "remembered approval")
  // Personal choices win; a personal value left at its default does not.
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), updates: { mode: "off" }, traffic: { mode: "direct" } }))
  result = await applyTeam({ file, cwd: project, ask: undefined, load, save })
  assert.equal(result.saved.updates.mode, "off")
  assert.equal(result.saved.traffic.mode, "direct")
  assert.deepEqual(mergeTeam({ traffic: { mode: "tor" } }, { traffic: { mode: "inherit", socksPort: 1 } }, { traffic: { mode: "inherit" } }), { traffic: { mode: "tor", socksPort: 1 } })
  // Editing the file revokes the approval.
  await writeFile(teamPath, JSON.stringify({ updates: { mode: "auto" } }))
  await writeFile(file, JSON.stringify({ team: JSON.parse(await readFile(file, "utf8")).team }))
  result = await applyTeam({ file, cwd: project, ask: undefined, load, save })
  assert.match(result.notices.join("\n"), /not applied/)
})

test("crash reports keep the log tail and events, redact secrets, and skip clean exits", async (t) => {
  const dir = await lab(t)
  const logs = join(dir, "data/opencode/log")
  await mkdir(logs, { recursive: true })
  await writeFile(join(logs, "old.log"), "ancient\n")
  await new Promise((resolve) => setTimeout(resolve, 20))
  await writeFile(join(logs, "new.log"), `start\nrequest failed Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123\nkey sk-abcdefghijklmnopqrstuvwxyz\nfatal: boom\n`)
  const file = await writeCrashReport({ home: dir, code: 139, args: ["/work"], env: { XDG_DATA_HOME: join(dir, "data") }, manifest: { builtAt: "now", upstream: "v2.0.21", mods: ["a"] }, startedAt: new Date(Date.now() - 5000) })
  const text = await readFile(file, "utf8")
  assert.match(file, /\.runtime\/crashes\/crash-.*\.log$/)
  assert.match(text, /exit code 139 \(signal 11\)/)
  assert.match(text, /fatal: boom/)
  assert.doesNotMatch(text, /ancient|abcdefghijklmnopqrstuvwxyz/)
  assert.equal(redact("api_key=supersecretvalue1"), "[redacted]")
  assert.deepEqual([0, 130, 143, 129, 1, 2, 139].map((code) => isCrash(code)), [false, false, false, false, false, false, true])
  assert.equal(isCrash(1, { tui: true }), true)
  assert.equal(isCrash(130, { tui: true }), false)
})

test("MCP paths resolve from the install and legacy copies can be relinked", async (t) => {
  const dir = await lab(t)
  await mkdir(join(dir, ".tools/gimp-mcp"), { recursive: true })
  const config = { mcp: { servers: { gimp: { type: "local", command: ["uv", "run", "--directory", "{env:INFINITEOC_HOME}/.tools/gimp-mcp", "x.py"] }, gone: { type: "local", command: ["{env:INFINITEOC_HOME}/.tools/nope.sh"] } } } }
  assert.deepEqual((await missingPaths(config, dir)).map((item) => item.server), ["gone"])
  const legacy = join(dir, "opencode.json")
  await writeFile(legacy, JSON.stringify({ mcp: { servers: { gimp: { type: "local", command: ["uv", "--directory", "/nonexistent/InfiniteOC/.tools/gimp-mcp"] } } } }))
  assert.equal(await repairPaths(legacy, dir), 1)
  assert.match(await readFile(legacy, "utf8"), /\{env:INFINITEOC_HOME\}\/\.tools\/gimp-mcp/)
  assert.equal(await repairPaths(legacy, dir), 0)
  assert.equal((await readdir(dir)).filter((name) => name.endsWith(".bak")).length, 1)
})

import { execFileSync } from "node:child_process"
import { addPack, removePack, packEntries, treeDigest, readPacks } from "../src/packs.mjs"
import { config } from "../src/launcher.mjs"

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim()

async function packFixture(t) {
  const root = await lab(t)
  const home = join(root, "home"), source = join(root, "source")
  await mkdir(home, { recursive: true })
  await writeFile(join(home, "infiniteoc.json"), JSON.stringify({ upstream: "v2.0.21", mods: [] }))
  await mkdir(source)
  git(source, "init", "--quiet", "-b", "main")
  await writeFile(join(source, "index.mjs"), `export default { id: "demo-pack", version: "1.0.0", async setup() {} }\n`)
  git(source, "add", ".")
  git(source, "commit", "--quiet", "-m", "pack")
  const commit = git(source, "rev-parse", "HEAD")
  const url = `file://${source}`
  const sha256 = await (async () => { const copy = join(root, "copy"); await mkdir(copy); await writeFile(join(copy, "index.mjs"), await readFile(join(source, "index.mjs"))); return treeDigest(copy) })()
  return { home, source, url, commit, sha256 }
}

test("a pack installs only at its pinned commit and sha256, and loads while its files match", async (t) => {
  const { home, url, commit, sha256 } = await packFixture(t)
  await assert.rejects(addPack({ home, url, commit, sha256: "0".repeat(64) }), /sha256 mismatch/)
  await assert.rejects(addPack({ home, url, commit: "1".repeat(40), sha256 }), /Pinned commit|failed/)
  await assert.rejects(addPack({ home, url: "ext::sh -c id", commit, sha256 }), /Pack URL must be/)
  await assert.rejects(addPack({ home, url, commit, sha256 }).then(() => addPack({ home, url, commit, sha256 })), /already installed/)
  await removePack(home, "demo-pack")
  assert.deepEqual(await readdir(join(home, "packs")), [], "failed installs leave nothing behind")
  const installed = await addPack({ home, url, commit, sha256 })
  assert.deepEqual(installed, { id: "demo-pack", commit, sha256 })
  assert.deepEqual((await config(home)).mods, ["./packs/demo-pack/index.mjs"])
  // A pack edited after install is left out and reported.
  await writeFile(join(home, "packs/demo-pack/index.mjs"), "export default { id: 'demo-pack', setup() {} }\n// tampered\n")
  assert.deepEqual((await config(home)).mods, [])
  assert.match((await packEntries(home)).skipped[0], /demo-pack: files changed/)
})

test("without a pin a pack needs the user's approval of the exact commit and hash, and can be removed", async (t) => {
  const { home, url, commit, sha256 } = await packFixture(t)
  await assert.rejects(addPack({ home, url }), /Pass --commit and --sha256/)
  let shown
  await assert.rejects(addPack({ home, url, confirm: async (found) => { shown = found; return false } }), /Not installed/)
  assert.deepEqual([shown.commit, shown.sha256], [commit, sha256])
  assert.deepEqual(await readdir(join(home, "packs")), [])
  await addPack({ home, url, confirm: async () => true })
  assert.deepEqual(Object.keys(await readPacks(home)), ["demo-pack"])
  await removePack(home, "demo-pack")
  assert.deepEqual(await readPacks(home), {})
  await assert.rejects(removePack(home, "../escape"), /No installed pack/)
})
