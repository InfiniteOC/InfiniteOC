import test from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import module from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import mod, { patches } from "./index.mjs"
import { ensureBuilt, wantsInfinitui } from "./build.mjs"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")
const hasGo = (() => {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test("setup writes the launcher helper and only patches the CLI default command", async () => {
  const writes = [], patched = []
  await mod.setup({
    async write(file, content) { writes.push([file, content]) },
    async patchExact(file, before, after) { patched.push([file, before, after]) },
  })
  assert.deepEqual(writes.map(([file]) => file), ["packages/cli/src/infiniteoc/infinitui.ts"])
  assert.ok(patched.length === 3 && patched.every(([file]) => file === "packages/cli/src/commands/handlers/default.ts"))
  const body = patched[2][2]
  // Falls back to the classic run() on the reserved exit code, never skips the server lease.
  assert.match(body, /code !== INFINITUI_FALLBACK/)
  assert.match(body, /server\.endpoint\.url/)
})

test("anchors are unique in the pinned upstream", { skip: !existsSync(upstream) && "no .upstream checkout" }, async () => {
  const sources = new Map()
  for (const [file, before, after] of patches) {
    const source = sources.get(file) ?? (await readFile(path.join(upstream, file), "utf8"))
    assert.equal(source.split(before).length, 2, `${file}: ${before}`)
    sources.set(file, source.replace(before, () => after))
  }
  const result = sources.get("packages/cli/src/commands/handlers/default.ts")
  // The hand-off sits after the server is resolved and before the OpenTUI run().
  assert.ok(result.indexOf("infinituiRun(") > result.indexOf("ServerConnection.resolve"))
  assert.ok(result.indexOf("infinituiRun(") < result.indexOf("yield* run({"))
})

test("wantsInfinitui: interactive launches only, with a classic opt-out", async (t) => {
  const dir = await tempDir(t, "infinitui-settings-")
  const settings = path.join(dir, "settings.json")
  const ctx = (args, env = {}) => ({ args, env: { INFINITEOC_SETTINGS_FILE: settings, ...env } })
  assert.equal(await wantsInfinitui(ctx([])), true)
  assert.equal(await wantsInfinitui(ctx(["-c"])), true)
  assert.equal(await wantsInfinitui(ctx(["--session", "ses_1"])), true)
  for (const sub of ["serve", "run", "web", "auth", "models", "mini"]) assert.equal(await wantsInfinitui(ctx([sub])), false, sub)
  assert.equal(await wantsInfinitui(ctx(["--help"])), false)
  assert.equal(await wantsInfinitui(ctx([], { INFINITEOC_TUI: "classic" })), false)
  await writeFile(settings, JSON.stringify({ tui: "classic" }))
  assert.equal(await wantsInfinitui(ctx([])), false)
  assert.equal(await wantsInfinitui(ctx([], { INFINITEOC_TUI: "infinitui" })), true)
})

test("beforeLaunch falls back to the classic UI with a notice when the build fails", async (t) => {
  const home = await tempDir(t, "infinitui-home-")
  const context = { args: [], env: { INFINITEOC_HOME: home, INFINITUI_GO: path.join(home, "no-such-go"), INFINITEOC_SETTINGS_FILE: path.join(home, "s.json") } }
  await mod.beforeLaunch(context)
  assert.equal(context.env.INFINITEOC_GO_TUI, undefined)
  assert.match(context.env.INFINITEOC_NOTICE, /InfiniTUI unavailable.*Go is not installed/)
})

test("ensureBuilt compiles once and reuses the stamped binary", { skip: !hasGo && "go not installed", timeout: 600_000 }, async (t) => {
  const home = await tempDir(t, "infinitui-build-")
  const modDir = import.meta.dirname
  const binary = await ensureBuilt({ modDir, home, env: process.env })
  const first = (await stat(binary)).mtimeMs
  assert.equal(await ensureBuilt({ modDir, home, env: process.env }), binary)
  assert.equal((await stat(binary)).mtimeMs, first, "second launch must not rebuild")
  // Relative paths (the release workflow passes home: ".") resolve the same way.
  assert.equal(await ensureBuilt({ modDir: path.relative(process.cwd(), modDir), home: path.relative(process.cwd(), home), env: process.env }), binary)
  const help = execFileSync(binary, ["--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString()
  assert.equal(typeof help, "string")
})

async function loadLaunch(t) {
  const dir = await tempDir(t, "infinitui-launch-")
  const source = module.stripTypeScriptTypes(await readFile(new URL("./launch.ts", import.meta.url), "utf8"))
  const file = path.join(dir, "launch.mjs")
  await writeFile(file, source)
  return { dir, launch: await import(pathToFileURL(file).href) }
}

test("infinituiRun passes the server and args, returns the exit code, and falls back when missing", { skip: process.platform === "win32" && "sh script" }, async (t) => {
  const { dir, launch } = await loadLaunch(t)
  const out = path.join(dir, "out.txt")
  const fake = path.join(dir, "fake-tui")
  await writeFile(fake, `#!/bin/sh\necho "$INFINITUI_SERVER_URL $INFINITUI_SERVER_PASSWORD \${OPENCODE_PASSWORD:-none} $*" > "${out}"\nexit 3\n`)
  await chmod(fake, 0o755)
  process.env.OPENCODE_PASSWORD = "leak"
  t.after(() => delete process.env.OPENCODE_PASSWORD)
  const code = await launch.infinituiRun(fake, { url: "http://127.0.0.1:9", password: "pw", version: "x", continue: true, prompt: "hi there", auto: true })
  assert.equal(code, 3)
  assert.equal((await readFile(out, "utf8")).trim(), "http://127.0.0.1:9 pw none --continue --prompt hi there --auto")
  assert.equal(launch.infinituiHandoff(), undefined)
  assert.equal(await launch.infinituiRun(path.join(dir, "missing"), { url: "u", version: "x" }), launch.INFINITUI_FALLBACK)
  // /classic: the TUI names its session in the hand-off file before exiting 75.
  const classic = path.join(dir, "classic-tui")
  await writeFile(classic, `#!/bin/sh\nprintf ses_handed > "$INFINITUI_HANDOFF"\nexit 75\n`)
  await chmod(classic, 0o755)
  assert.equal(await launch.infinituiRun(classic, { url: "u", version: "x" }), launch.INFINITUI_FALLBACK)
  assert.equal(launch.infinituiHandoff(), "ses_handed")
})

test("Go unit tests pass", { skip: !hasGo && "go not installed", timeout: 600_000 }, () => {
  execFileSync("go", ["test", "./..."], { cwd: path.join(import.meta.dirname, ".tui"), stdio: "pipe", env: { ...process.env, GOFLAGS: "-buildvcs=false" } })
})
