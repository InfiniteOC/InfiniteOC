import test from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes, cp, copyFile, chmod, realpath, stat } from "node:fs/promises"
import { once } from "node:events"
import net from "node:net"
import { constants, tmpdir, uptime } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { acquireLock, checked, config, run } from "../src/launcher.mjs"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const settings = { upstream: "v2.0.21", mods: [] }
// Short prefix: a copied home's .opendaemon/control.sock must still fit sun_path.
async function lab(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "ioc-")))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
// A disposable InfiniteOC home; PATH holds only fake-bin, so nothing can reach npm, git or the network.
async function install(t, json = settings) {
  const base = await lab(t)
  for (const dir of ["bin", "src"]) await cp(path.join(repo, dir), path.join(base, dir), { recursive: true })
  await mkdir(path.join(base, "mods/infiniteoc/settings"), { recursive: true })
  await mkdir(path.join(base, "fake-bin"))
  await copyFile(path.join(repo, "mods/infiniteoc/settings/settings-store.mjs"), path.join(base, "mods/infiniteoc/settings/settings-store.mjs"))
  await copyFile(path.join(repo, "package.json"), path.join(base, "package.json"))
  await writeFile(path.join(base, "infiniteoc.json"), typeof json === "string" ? json : JSON.stringify(json))
  return base
}
const cli = (base, args, env = {}) => spawnSync(process.execPath, [path.join(base, "bin/infiniteoc.mjs"), ...args], {
  cwd: base, encoding: "utf8", timeout: 20000,
  env: { PATH: path.join(base, "fake-bin"), HOME: base, INFINITEOC_SETTINGS_FILE: path.join(base, "settings.json"), ...env },
})
async function script(file, body) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `#!/bin/sh\n${body}\n`)
  await chmod(file, 0o755)
}
// Tools and pinned source that bootstrap() accepts as-is; a daemon cannot start (.opendaemon is a file).
async function bootstrapped(base) {
  await script(path.join(base, ".tools/node_modules/.bin/bun"), "echo 1.4.2")
  await mkdir(path.join(base, ".upstream/.git"), { recursive: true })
  await writeFile(path.join(base, ".upstream/package.json"), JSON.stringify({ version: "2.0.21" }))
  await writeFile(path.join(base, ".opendaemon"), "")
}
// Just the anchors prepare() and installDaemonTool() patch, plus a bun whose "build" writes the binary.
async function buildable(base) {
  await bootstrapped(base)
  const sources = {
    "cli/src/services/server-connection.ts": "if (args.standalone || (yield* ServiceConfig.read()).disabled === true) {}",
    "server/src/handlers/agent.ts": "return yield* response(Agent.Service.use((agent) => agent.list()))",
    "server/src/handlers/model.ts": "const models = yield* Model.Service",
    "server/src/handlers/provider.ts": "const providers = yield* Provider.Service",
    "core/src/tool/plugin/opencode.ts": 'import { Effect, Schema } from "effect"\n        draft.add({\n          name: "session_rename",',
  }
  for (const [file, text] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(base, ".upstream/packages", file)), { recursive: true })
    await writeFile(path.join(base, ".upstream/packages", file), text)
  }
  await script(path.join(base, ".tools/node_modules/.bin/bun"), `case "$1" in
  --version) echo 1.4.2 ;;
  run) exec "${process.execPath}" -e 'const dir = "dist/cli-" + process.platform + "-" + process.arch + "/bin"; require("fs").mkdirSync(dir, { recursive: true }); require("fs").writeFileSync(dir + "/opencode", "", { mode: 0o755 })' ;;
esac`)
}
// Stands in for the OpenCode binary: records argv and env next to itself, exits 7.
const recorder = file => script(file, `exec "${process.execPath}" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), env: process.env })); process.exitCode = 7' -- "$0.json" "$@"`)
const closedPort = async () => {
  const server = net.createServer().listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

test("build lock reclaims a dead owner's lock and a stale pid-less one", { timeout: 10000 }, async t => {
  const lock = path.join(await lab(t), "prepare.lock")
  await mkdir(lock)
  await writeFile(path.join(lock, "pid"), String(spawnSync(process.execPath, ["-e", ""]).pid))
  let release = await acquireLock(lock)
  assert.equal(await readFile(path.join(lock, "pid"), "utf8"), String(process.pid))
  await release()
  await assert.rejects(stat(lock), { code: "ENOENT" })
  await mkdir(lock)
  const old = new Date(Date.now() - 31 * 60_000)
  await utimes(lock, old, old)
  release = await acquireLock(lock)
  await release()
})

test("build lock waits for a live owner, says how to clear it, then takes over once it is released", { timeout: 10000 }, async t => {
  const lock = path.join(await lab(t), "prepare.lock")
  const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" })
  t.after(() => owner.kill())
  await mkdir(lock)
  await writeFile(path.join(lock, "pid"), String(owner.pid))
  const log = t.mock.method(console, "error", () => {})
  let acquired = false
  const pending = acquireLock(lock).then(release => { acquired = true; return release })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(acquired, false)
  // A crashed build's pid can be reused by an unrelated process, so the way out must be on screen.
  assert.deepEqual(log.mock.calls.map(call => call.arguments[0]), [`[InfiniteOC] Waiting for another InfiniteOC build (pid ${owner.pid}); if none is running, remove ${lock}`])
  assert.equal(await readFile(path.join(lock, "pid"), "utf8"), String(owner.pid))
  await rm(lock, { recursive: true })
  await (await pending)()
})

test("build lock reclaims a pid written before this boot, even if that number is alive again", { timeout: 5000 }, async t => {
  const lock = path.join(await lab(t), "prepare.lock")
  const owner = path.join(lock, "pid")
  await mkdir(lock)
  await writeFile(owner, String(process.ppid))
  const beforeBoot = Date.now() / 1000 - uptime() - 3600
  await utimes(owner, beforeBoot, beforeBoot)
  const release = await acquireLock(lock)
  assert.equal(await readFile(owner, "utf8"), String(process.pid))
  await release()
})

test("Ctrl+C while the build lock is held removes it and exits 130", async t => {
  const lock = path.join(await lab(t), "prepare.lock")
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { acquireLock } = await import(${JSON.stringify(pathToFileURL(path.join(repo, "src/launcher.mjs")).href)})
    await acquireLock(${JSON.stringify(lock)})
    process.kill(process.pid, "SIGINT")
    setInterval(() => {}, 1000)`], { encoding: "utf8", timeout: 10000 })
  assert.equal(result.status, 130, result.stderr)
  await assert.rejects(stat(lock), { code: "ENOENT" })
})

test("a child killed by a signal exits 128 + its number", async () => {
  for (const signal of ["SIGKILL", "SIGHUP", "SIGTERM"])
    assert.equal(await run(process.execPath, ["-e", `process.kill(process.pid, "${signal}")`], { stdio: "ignore" }), 128 + constants.signals[signal], signal)
})

test("failed build steps name the command and step", async t => {
  const dir = await lab(t)
  await writeFile(path.join(dir, "install.js"), "process.exit(Number(process.env.CODE))")
  const node = path.basename(process.execPath)
  const step = code => checked(process.execPath, ["install.js"], { cwd: dir, stdio: "ignore", env: { ...process.env, CODE: code } })
  await step("0")
  await assert.rejects(step("1"), { message: `${node} install.js failed (exit 1)` })
  // Ctrl+C or SIGTERM: exitCode tells launch() to stop rather than fall back.
  for (const code of [130, 143]) await assert.rejects(step(String(code)), { message: `${node} install.js interrupted`, exitCode: code })
  await assert.rejects(checked("infiniteoc-missing-command", ["install", "--flag"]), { message: "infiniteoc-missing-command not found on PATH" })
})

test("infiniteoc.json errors name the file", async t => {
  const dir = await lab(t), file = path.join(dir, "infiniteoc.json")
  await writeFile(file, "{ broken")
  await assert.rejects(config(dir), error => error.message.startsWith(`${file}: `))
  for (const value of [{ upstream: "main", mods: [] }, null]) {
    await writeFile(file, JSON.stringify(value))
    await assert.rejects(config(dir), { message: `${file}: must contain an exact upstream tag and mods array` })
  }
})

test("help works with a broken infiniteoc.json; other commands name the file", async t => {
  const base = await install(t, "{ broken")
  for (const args of [["help"], ["--help"]]) {
    const help = cli(base, args)
    assert.equal(help.status, 0, help.stderr)
    for (const text of ["doctor [--json]     Read-only","opendaemon status | watch | restart", "/settings → InfiniteOC Settings", "npm link"]) assert.ok(help.stdout.includes(text), text)
  }
  const mods = cli(base, ["mods"])
  assert.equal(mods.status, 1)
  assert.ok(mods.stderr.startsWith(`[InfiniteOC] ${path.join(base, "infiniteoc.json")}: `), mods.stderr)
})

test("uninstall, upgrade and update are refused before anything is prepared", async t => {
  const base = await install(t)
  // The pinned effect parser runs the subcommand after any of its global settings, in each of these spellings.
  for (const args of [["uninstall"], ["--", "upgrade", "--method", "npm"], ["--print-logs", "update"], ["--log-level", "debug", "uninstall"], ["--print-logs", "true", "upgrade"], ["--print-logs=1", "upgrade"], ["--no-print-logs", "update"]]) {
    const result = cli(base, args)
    assert.equal(result.status, 1, args.join(" "))
    assert.ok(result.stderr.includes("refused: it would act on your stock OpenCode install"), result.stderr)
  }
  await assert.rejects(stat(path.join(base, ".runtime")), { code: "ENOENT" })
  // Bare "infiniteoc update" is InfiniteOC's own self-update (git), never OpenCode's; this home is not a checkout.
  const self = cli(base, ["update"])
  assert.equal(self.status, 1)
  assert.match(self.stderr, /git not found on PATH|not a git checkout/)
  assert.ok(!self.stderr.includes("refused"), self.stderr)
  // Only the subcommand position counts, and a root flag's value is not one; these launches get as far as bootstrap (no npm on the fake PATH).
  for (const args of [["--print-logs", "run", "update"], ["--prompt", "update"]]) {
    const run = cli(base, args)
    assert.equal(run.status, 1, args.join(" "))
    assert.match(run.stderr, /npm not found on PATH/)
    assert.ok(!run.stderr.includes("refused"), run.stderr)
  }
})

test("feature enable checks the mod before editing infiniteoc.json; disable takes it out again", async t => {
  const base = await install(t)
  const file = path.join(base, "infiniteoc.json")
  const original = await readFile(file, "utf8")
  const missing = cli(base, ["feature", "enable", "missing"])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /No mod at mods\/missing\/index\.mjs; existing: infiniteoc$/m)
  assert.equal(await readFile(file, "utf8"), original)
  // A mod that fails the check is never written (loading fails before .upstream is needed).
  await mkdir(path.join(base, "mods/bad"))
  await writeFile(path.join(base, "mods/bad/index.mjs"), "export default {}")
  const bad = cli(base, ["feature", "enable", "bad"])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /Invalid mod: /)
  assert.equal(await readFile(file, "utf8"), original)
  // feature check reads only the pinned TUI sources.
  await cp(path.join(repo, ".upstream/packages/tui/src"), path.join(base, ".upstream/packages/tui/src"), { recursive: true })
  assert.equal(cli(base, ["feature", "new", "hello"]).status, 0)
  const enable = cli(base, ["feature", "enable", "hello"])
  assert.equal(enable.status, 0, enable.stderr)
  assert.match(enable.stdout, /^Enabled hello \(backup: infiniteoc\.json\.bak\)/)
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).mods, ["./mods/hello/index.mjs"])
  assert.equal(cli(base, ["feature", "enable", "hello"]).stdout, "hello is already enabled.\n")
  // Any spelling of the same entry counts, for the check as well.
  await writeFile(file, JSON.stringify({ ...settings, mods: ["mods/hello/index.mjs"] }))
  assert.equal(cli(base, ["feature", "enable", "hello"]).stdout, "hello is already enabled.\n")
  assert.match(cli(base, ["feature", "disable", "hello"]).stdout, /^Disabled hello/)
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).mods, [])
})

test("doctor is read-only and gives every failing check a hint", async t => {
  const base = await install(t)
  const port = await closedPort()
  await writeFile(path.join(base, "settings.json"), JSON.stringify({ traffic: { mode: "tor", socksPort: port } }))
  const before = await readdir(base)
  const result = cli(base, ["doctor", "--json"])
  const report = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(report), ["platform", "node", "bun", "upstream", "build", "web", "mcp", "daemon", "socket", "settings", "socks"])
  for (const name of ["bun", "upstream", "socks"]) assert.equal(report[name].ok, false, name)
  // A missing or stale build is a warning: the next launch rebuilds it, so it does not fail the report.
  assert.deepEqual([report.build.ok, report.build.warn, report.build.fix], [true, true, "build"])
  assert.equal(report.settings.ok, true)
  // Idle is healthy: every launch starts the daemon.
  assert.deepEqual(report.daemon, { ok: true, detail: "opendaemon not running; the next launch starts it" })
  assert.equal(report.socks.detail, `Tor SOCKS 127.0.0.1:${port} unreachable`)
  // Measured limits: longer paths fail with EINVAL.
  assert.match(report.socket.detail, process.platform === "darwin" ? /\/104 bytes$/ : /\/107 bytes$/)
  for (const check of Object.values(report)) assert.ok(check.ok || check.hint, check.detail)
  assert.equal(result.status, 1)

  assert.match(cli(base, ["doctor"]).stdout, /^! no finished build\n {4}the next launch rebuilds; infiniteoc doctor --fix rebuilds now$/m)
  assert.deepEqual(await readdir(base), before)
})

test("a missing build and an MCP path that does not exist are warnings, and doctor --fix relinks MCP paths", async t => {
  const base = await install(t)
  await bootstrapped(base)
  await rm(path.join(base, ".opendaemon"))
  await mkdir(path.join(base, ".tools/gimp-mcp"), { recursive: true })
  await writeFile(path.join(base, "opencode.json"), JSON.stringify({ mcp: { servers: { gimp: { type: "local", command: ["uv", "--directory", "/old/place/.tools/gimp-mcp"] }, other: { type: "local", command: ["/nowhere/tool.sh"] } } } }))
  const warned = cli(base, ["doctor"])
  assert.equal(warned.status, 0, warned.stdout)
  assert.match(warned.stdout, /^! no finished build/m)
  assert.match(warned.stdout, /^! MCP paths missing: gimp \/old\/place\/\.tools\/gimp-mcp; other \/nowhere\/tool\.sh/m)
  // --fix relinks what exists in this install; it would also rebuild (nothing is connected), which this stub tree cannot do: reported, not fatal.
  const fixed = cli(base, ["doctor", "--fix", "--json"])
  assert.match(fixed.stderr, /doctor --fix: relinked 1 MCP path\(s\)/)
  assert.match(fixed.stderr, /doctor --fix: rebuild failed: /)
  assert.match(await readFile(path.join(base, "opencode.json"), "utf8"), /\{env:INFINITEOC_HOME\}\/\.tools\/gimp-mcp/)
  assert.equal(JSON.parse(fixed.stdout).mcp.detail.includes("gimp"), false)
})

test("a bun that cannot run is bootstrapped again", async t => {
  const base = await install(t)
  await script(path.join(base, ".tools/node_modules/.bin/bun"), "exit 1")
  await script(path.join(base, "fake-bin/npm"), `echo "$@" > "$0.args"; exit 1`)
  const result = cli(base, ["setup"])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /\[InfiniteOC\] npm install failed \(exit 1\)/)
  assert.match(await readFile(path.join(base, "fake-bin/npm.args"), "utf8"), /^install --prefix .+ bun@1\.4\.2$/m)
})

test("launch keeps --server, runs without the daemon, warns about Tor and exits", async t => {
  const base = await install(t)
  await bootstrapped(base)
  const binary = path.join(base, `.runtime/opencode/packages/cli/dist/cli-${process.platform}-${process.arch}/bin/opencode`)
  await recorder(binary)
  const { fingerprint } = await import(pathToFileURL(path.join(base, "src/launcher.mjs")).href)
  await writeFile(path.join(base, ".runtime/build.json"), JSON.stringify({ key: await fingerprint(settings, []), builtAt: "2026-01-01T00:00:00.000Z" }))
  const port = await closedPort()
  await writeFile(path.join(base, "settings.json"), JSON.stringify({ traffic: { mode: "tor", socksHost: "127.0.0.1", socksPort: port } }))
  // An enclosing InfiniteOC session's values must not leak into this launch.
  const result = cli(base, ["--server=http://127.0.0.1:9", "--continue"], { INFINITEOC_DAEMON_SOCKET: "/inherited.sock", INFINITEOC_NOTICE: "inherited", INFINITEOC_UI_CLIENT: "inherited" })
  assert.equal(result.status, 7, result.stderr)
  const record = JSON.parse(await readFile(`${binary}.json`, "utf8"))
  assert.deepEqual(record.args, ["--server=http://127.0.0.1:9", "--continue"])
  assert.equal(record.env.INFINITEOC, "1")
  assert.match(record.env.INFINITEOC_UI_CLIENT, /^[0-9a-f-]{36}$/)
  assert.equal(record.env.INFINITEOC_DAEMON_SOCKET, undefined)
  assert.equal(record.env.INFINITEOC_LIVE_MANIFEST, undefined)
  assert.match(record.env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+/)
  const [tor, daemon, ...rest] = record.env.INFINITEOC_NOTICE.split(" · ")
  assert.equal(tor, `Tor SOCKS 127.0.0.1:${port} unreachable; requests will fail until it runs (change in /settings → InfiniteOC Settings → Traffic)`)
  assert.match(daemon, /^opendaemon unavailable \(.+\); live reload is off for this session$/)
  assert.deepEqual(rest, [])
  assert.ok(result.stderr.includes(tor))
  await assert.rejects(stat(path.join(base, ".runtime/prepare.lock")), { code: "ENOENT" })
})

test("a TUI killed where it cannot clean up gets the terminal restored; a SIGTERM exit, which OpenTUI handles, does not", async t => {
  const base = await install(t)
  await bootstrapped(base)
  const binary = path.join(base, `.runtime/opencode/packages/cli/dist/cli-${process.platform}-${process.arch}/bin/opencode`)
  await script(binary, "kill -9 $$")
  const { fingerprint } = await import(pathToFileURL(path.join(base, "src/launcher.mjs")).href)
  await writeFile(path.join(base, ".runtime/build.json"), JSON.stringify({ key: await fingerprint(settings, []), builtAt: "2026-01-01T00:00:00.000Z" }))
  const stty = path.join(base, "fake-bin/stty")
  await script(stty, `echo "$@" >> "$0.args"; echo saved-state`)
  const plain = cli(base, [])
  assert.equal(plain.status, 137, plain.stderr)
  assert.ok(!plain.stderr.includes("terminal restored"), plain.stderr)
  await assert.rejects(stat(`${stty}.args`), { code: "ENOENT" }) // no terminal, no stty
  // The launcher only asks isTTY, so a preload stands in for a terminal.
  const terminal = { NODE_OPTIONS: "--import=data:text/javascript,process.stdin.isTTY=process.stdout.isTTY=true" }
  const killed = cli(base, [], terminal)
  assert.equal(killed.status, 137, killed.stderr)
  assert.equal(await readFile(`${stty}.args`, "utf8"), "-g\nsaved-state\n")
  assert.equal(killed.stdout, "\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b[?2031l\x1b[?2026l", JSON.stringify(killed.stdout))
  assert.match(killed.stderr, /OpenCode ended by a signal \(exit 137\); terminal restored/)
  await rm(`${stty}.args`)
  await script(binary, "kill -TERM $$")
  const term = cli(base, [], terminal)
  assert.equal(term.status, 143, term.stderr)
  assert.equal(await readFile(`${stty}.args`, "utf8"), "-g\n")
  assert.ok(!term.stderr.includes("terminal restored"), term.stderr)
})

test("launch falls back to the last good build only when one exists", async t => {
  const base = await install(t, { ...settings, mods: ["./mods/broken/index.mjs"] })
  await bootstrapped(base)
  const failed = cli(base, [])
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /mods\/broken\/index\.mjs/)
  const good = path.join(base, ".runtime/last-good")
  await recorder(path.join(good, "opencode"))
  await writeFile(path.join(good, "build.json"), JSON.stringify({ builtAt: "2026-01-01T00:00:00.000Z" }))
  const result = cli(base, ["--continue"])
  assert.equal(result.status, 7, result.stderr)
  assert.match(result.stderr, /mods\/broken\/index\.mjs/)
  const record = JSON.parse(await readFile(path.join(good, "opencode.json"), "utf8"))
  assert.deepEqual(record.args, ["--continue"])
  assert.match(record.env.INFINITEOC_NOTICE, /^Launching the previous build from 2026-01-01T00:00:00\.000Z; fix the mod, then run infiniteoc rebuild · opendaemon unavailable/)
})

test("Ctrl+C during bootstrap stops the launch instead of starting the last good build", async t => {
  const base = await install(t)
  await bootstrapped(base)
  await script(path.join(base, ".tools/node_modules/.bin/bun"), "exit 1")
  // npm dies from the terminal's SIGINT, as on a real Ctrl+C.
  await script(path.join(base, "fake-bin/npm"), `exec "${process.execPath}" -e 'process.kill(process.pid, "SIGINT")'`)
  const good = path.join(base, ".runtime/last-good")
  await recorder(path.join(good, "opencode"))
  await writeFile(path.join(good, "build.json"), JSON.stringify({ builtAt: "2026-01-01T00:00:00.000Z" }))
  const result = cli(base, [])
  assert.equal(result.status, 130, result.stderr)
  assert.match(result.stderr, /^\[InfiniteOC\] npm install interrupted$/m)
  await assert.rejects(stat(path.join(good, "opencode.json")), { code: "ENOENT" })
})

test("a broken settings.json stops launch before any build and names the file", async t => {
  const base = await install(t)
  await writeFile(path.join(base, ".opendaemon"), "")
  const file = path.join(base, "settings.json")
  await writeFile(file, "{ broken")
  const result = cli(base, [])
  assert.equal(result.status, 1)
  // Nothing is bootstrapped, so reaching prepare() would have failed with "npm not found on PATH".
  assert.ok(result.stderr.startsWith(`[InfiniteOC] ${file}: `), result.stderr)
  assert.ok(result.stderr.endsWith(". Fix or delete it to restore defaults.\n"), result.stderr)
})

test("setup builds in four steps, keeps a last good fallback, and the idle result passes doctor", async t => {
  const base = await install(t)
  await buildable(base)
  const runtime = path.join(base, ".runtime")
  const binary = path.join(runtime, `opencode/packages/cli/dist/cli-${process.platform}-${process.arch}/bin/opencode`)
  const good = path.join(runtime, "last-good")
  const kept = async () => {
    assert.equal((await stat(path.join(good, "opencode"))).ino, (await stat(binary)).ino)
    assert.equal(await readFile(path.join(good, "build.json"), "utf8"), await readFile(path.join(runtime, "build.json"), "utf8"))
  }
  const setup = cli(base, ["setup"])
  assert.equal(setup.status, 0, setup.stderr)
  for (const text of ["Building: no finished build yet", "[1/4] Copying pinned source", "[2/4] Applying 0 mod(s)", "[3/4] Installing dependencies", `[4/4] Building ${process.platform}-${process.arch}`, "Ready in"])
    assert.ok(setup.stderr.includes(text), `${text}\n${setup.stderr}`)
  await kept()
  const before = (await stat(binary)).ino
  const rebuild = cli(base, ["rebuild"])
  assert.equal(rebuild.status, 0, rebuild.stderr)
  assert.match(rebuild.stderr, /Building: rebuild requested/)
  assert.notEqual((await stat(binary)).ino, before)
  await kept()
  // Bookkeeping that fails only costs the fallback, never the finished build.
  await rm(good, { recursive: true })
  await writeFile(good, "")
  const blocked = cli(base, ["rebuild"])
  assert.equal(blocked.status, 0, blocked.stderr)
  assert.match(blocked.stderr, /Could not keep this build as the fallback: EEXIST/)
  assert.ok(JSON.parse(await readFile(path.join(runtime, "build.json"), "utf8")).builtAt)
  // Built and idle (no daemon until the next launch) is healthy; doctor never starts one.
  await rm(path.join(base, ".opendaemon"))
  const doctor = cli(base, ["doctor"])
  assert.equal(doctor.status, 0, doctor.stdout)
})
