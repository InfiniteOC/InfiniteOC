import { spawn, spawnSync } from "node:child_process"
import { access, readFile, writeFile, mkdir, cp, rm, stat, link, copyFile } from "node:fs/promises"
import { rmSync } from "node:fs"
import { resolve, join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import { constants, uptime } from "node:os"
import { setTimeout as sleep } from "node:timers/promises"
import { loadMods, applyMods } from "./mod-loader.mjs"
import { applyTraffic, probeSocks } from "./traffic.mjs"
import { loadSettings, saveSettings, settingsFile, providerConfigFile } from "../mods/infiniteoc/settings/settings-store.mjs"
import { ensureDaemon, daemonPaths, digestTree } from "./opendaemon.mjs"
import { daemonRequest } from "./daemon-client.mjs"
import { installDaemonTool } from "./opendaemon-tool.mjs"
import { update, settle } from "./updater.mjs"
import { fx } from "./fx.mjs"
import { needsWizard, runWizard, terminalIO } from "./wizard.mjs"
import { applyTeam } from "./team.mjs"
import { packEntries } from "./packs.mjs"
import { isCrash, writeCrashReport } from "./crash.mjs"
import { missingPaths, repairPaths } from "./mcp-paths.mjs"

export const home = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// Matches upstream build.ts --single target naming: cli-<os>-<arch>.
const target = `${process.platform}-${process.arch}`
const binary = join(home, `.runtime/opencode/packages/cli/dist/cli-${target}/bin/opencode`)
const supported = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(target)
const bunVersion = bun => { const result = spawnSync(bun, ["--version"], { encoding: "utf8" }); return result.status === 0 ? result.stdout.trim() : undefined }
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== "ESRCH" } }
const seconds = since => `${((Date.now() - since) / 1000).toFixed(1)}s`
const socksLabel = (mode, socks) => `${mode === "tor" ? "Tor SOCKS" : "SOCKS proxy"} ${socks.host}:${socks.port}`
let reducedMotion = false
export async function exists(path) { try { await access(path); return true } catch { return false } }
export function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: "inherit", ...options })
    const handlers = ["SIGINT", "SIGTERM"].map(signal => {
      const handler = () => child.kill(signal)
      // First in line: the child is signalled before the build lock's handler exits the process.
      process.prependListener(signal, handler)
      return [signal, handler]
    })
    const clean = () => handlers.forEach(([signal, handler]) => process.off(signal, handler))
    child.on("error", error => { clean(); fail(error) })
    child.on("exit", (code, signal) => { clean(); done(code ?? 128 + constants.signals[signal]) })
  })
}
export async function checked(command, args, options) {
  const name = [basename(command), ...args].join(" ").split(" -")[0]
  const code = await run(command, args, options).catch(error => { throw error.code === "ENOENT" ? new Error(`${basename(command)} not found on PATH`) : error })
  // Ctrl+C or SIGTERM (the signals run() forwards): exitCode tells launch() to stop, not fall back.
  if (code === 130 || code === 143) throw Object.assign(new Error(`${name} interrupted`), { exitCode: code })
  if (code !== 0) throw new Error(`${name} failed (exit ${code})`)
}
export async function config(base = home) {
  const file = join(base, "infiniteoc.json")
  const text = await readFile(file, "utf8")
  try {
    const value = JSON.parse(text)
    if (/^v\d+\.\d+\.\d+$/.test(value?.upstream) && Array.isArray(value.mods)) {
      // Installed packs whose files still match their pin join the mod list; a changed one is named and left out.
      const { entries, skipped } = await packEntries(base)
      for (const reason of skipped) console.error(`[InfiniteOC] Pack not loaded (${reason}); reinstall it with infiniteoc mod remove/add`)
      return { ...value, mods: [...value.mods, ...entries] }
    }
    throw new Error("must contain an exact upstream tag and mods array")
  } catch (error) { throw new Error(`${file}: ${error.message}`) }
}
export async function bootstrap(settings) {
  const upstream = join(home, ".upstream")
  const bun = join(home, ".tools/node_modules/.bin/bun")
  if (!bunVersion(bun)) {
    await checked("npm", ["install", "--prefix", join(home, ".tools"), "--ignore-scripts", "bun@1.4.2"])
    await checked(process.execPath, ["install.js"], { cwd: join(home, ".tools/node_modules/bun") })
  }
  if (!await exists(join(upstream, ".git")))
    await checked("git", ["clone", "--depth", "1", "--branch", settings.upstream, "https://github.com/sst/opencode.git", upstream])
  const pkg = JSON.parse(await readFile(join(upstream, "package.json"), "utf8"))
  if (`v${pkg.version}` !== settings.upstream)
    throw new Error(`Source is v${pkg.version}, config requests ${settings.upstream}. Use a matching tag; no automatic destructive update.`)
  return { upstream, bun }
}
export async function fingerprint(settings, mods) {
  const hash = createHash("sha256").update(JSON.stringify(settings))
  hash.update(await readFile(fileURLToPath(import.meta.url)))
  hash.update(await readFile(join(home, "src/mod-loader.mjs")))
  hash.update(await readFile(join(home, "src/tui-features.mjs")))
  for (const file of ["live-runtime.ts", "daemon-client.mjs", "opendaemon-tool.mjs"]) hash.update(await readFile(join(home, "src", file)))
  hash.update(await readFile(join(home, "src/traffic.mjs")))
  for (const mod of mods) await digestTree(dirname(mod.filename), hash)
  return hash.digest("hex")
}
// Self-healing: a lock whose owner died, or a pid-less one older than 30 minutes, is reclaimed.
// A pid written before this boot is dead too, even if its number was reused since.
// ponytail: two launchers reclaiming the same dead lock in the same instant can both proceed; OS file locks if that ever bites.
// ponytail: boot time is estimated from the wall clock, so a forward clock step (first NTP sync on an RTC-less board) can make a live lock look pre-boot;
// compare a recorded boot id (/proc/sys/kernel/random/boot_id, sysctl kern.bootsessionuuid) if that bites.
export async function acquireLock(lock) {
  const owner = join(lock, "pid")
  const started = Date.now()
  let waiting = false
  for (;;) {
    try { await mkdir(lock); await writeFile(owner, String(process.pid)); break } catch (error) { if (error.code !== "EEXIST") throw error }
    const pid = Number(await readFile(owner, "utf8").catch(() => ""))
    const written = (await stat(owner).catch(() => null))?.mtimeMs ?? Date.now()
    const stale = pid ? pid === process.pid || !alive(pid) || written < Date.now() - uptime() * 1000 : Date.now() - ((await stat(lock).catch(() => null))?.mtimeMs ?? 0) > 30 * 60_000
    if (stale) { await rm(lock, { recursive: true, force: true }); continue }
    // A crashed build's pid may be reused by an unrelated process, so the way out is printed once.
    if (!waiting) console.error(`[InfiniteOC] Waiting for another InfiniteOC build${pid ? ` (pid ${pid})` : ""}; if none is running, remove ${lock}`)
    if (process.stderr.isTTY) process.stderr.write(`\r[InfiniteOC] Waiting… ${Math.round((Date.now() - started) / 1000)}s`)
    waiting = true
    await sleep(1000)
  }
  if (waiting && process.stderr.isTTY) process.stderr.write("\n")
  // Ctrl+C (or a closed terminal) mid-build must not leave a lock behind.
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map(signal => {
    const handler = () => { rmSync(lock, { recursive: true, force: true }); process.exit(128 + constants.signals[signal]) }
    process.on(signal, handler)
    return [signal, handler]
  })
  return async () => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
    await rm(lock, { recursive: true, force: true })
  }
}
// Steps whose child output streams through get a closing line rather than a spinner over it.
async function step(label, task, streams = false) {
  const ui = fx(process.stderr, { motion: !reducedMotion })
  if (ui.tty && !streams) return ui.spin(`[InfiniteOC] ${label}`, task)
  const started = Date.now()
  process.stderr.write(`[InfiniteOC] ${label}…${streams ? "\n" : ""}`)
  try { return await task() } finally { process.stderr.write(`${streams ? `[InfiniteOC] ${label} ` : " "}${seconds(started)}\n`) }
}
export async function prepare(settings, force = false) {
  reducedMotion = !!settings.options?.reducedMotion
  if (!supported) throw new Error(`Unsupported platform ${target}; InfiniteOC builds on Linux and macOS (x64/arm64)`)
  const { upstream, bun } = await bootstrap(settings)
  const mods = await loadMods(settings.mods, home)
  const key = await fingerprint(settings, mods)
  const runtime = join(home, ".runtime")
  const root = join(runtime, "opencode")
  const marker = join(runtime, "build.json")
  const built = () => readFile(marker, "utf8").then(JSON.parse).catch(() => undefined)
  const fresh = async manifest => !force && manifest?.key === key && await exists(binary)
  let manifest = await built()
  if (await fresh(manifest)) return { root, binary, mods, manifest }
  await mkdir(runtime, { recursive: true })
  const release = await acquireLock(join(runtime, "prepare.lock"))
  try {
    // Another launcher may have finished this very build while we waited.
    manifest = await built()
    if (await fresh(manifest)) return { root, binary, mods, manifest }
    const started = Date.now()
    // No manifest also follows a failed or interrupted build, so this cannot say "first build".
    console.error(`[InfiniteOC] Building: ${force ? "rebuild requested" : manifest ? `mods or framework changed since ${manifest.builtAt}` : "no finished build yet"}`)
    await rm(marker, { force: true })
    await step("[1/4] Copying pinned source", async () => {
      await rm(root, { recursive: true, force: true })
      await cp(upstream, root, { recursive: true, filter: path => ![".git", "node_modules"].includes(path.split("/").at(-1)) })
    })
    const applied = await step(`[2/4] Applying ${mods.length} mod(s)`, async () => {
      // With INFINITEOC=1 every ServerConnection.resolve caller starts a private server, so the
      // user's stock background service is never replaced and --server keeps working.
      const connectionFile = join(root, "packages/cli/src/services/server-connection.ts")
      const connection = await readFile(connectionFile, "utf8")
      const anchor = 'if (args.standalone || (yield* ServiceConfig.read()).disabled === true)'
      if (!connection.includes(anchor)) throw new Error("Incompatible upstream server-connection anchor")
      await writeFile(connectionFile, connection.replace(anchor,
        'if (args.standalone || process.env.INFINITEOC === "1" || (yield* ServiceConfig.read()).disabled === true)'))
      // A short-lived private server otherwise answers agent.list before built-ins activate.
      const agentFile = join(root, "packages/server/src/handlers/agent.ts")
      const agentSource = await readFile(agentFile, "utf8")
      const agentAnchor = 'return yield* response(Agent.Service.use((agent) => agent.list()))'
      if (!agentSource.includes(agentAnchor)) throw new Error("Incompatible upstream agent-handler anchor")
      await writeFile(agentFile, agentSource.replace('import { Agent } from "@opencode/core/agent"',
        'import { Agent } from "@opencode/core/agent"\nimport { Plugin } from "@opencode/core/plugin"')
        .replace(agentAnchor, 'yield* Plugin.awaitActivation\n        ' + agentAnchor))
      // Provider/model registries must also be populated before initial UI sync.
      for (const [handler, service] of [["model", "Model"], ["provider", "Provider"]]) {
        const file = join(root, `packages/server/src/handlers/${handler}.ts`)
        const source = await readFile(file, "utf8")
        const anchor = `const ${handler}s = yield* ${service}.Service`
        if (!source.includes(anchor)) throw new Error(`Incompatible upstream ${handler}-handler anchor`)
        await writeFile(file, source.replace(`import { ${service} } from "@opencode/core/${handler}"`,
          `import { ${service} } from "@opencode/core/${handler}"\nimport { Plugin } from "@opencode/core/plugin"`)
          .replaceAll(anchor, `yield* Plugin.awaitActivation\n          ${anchor}`))
      }
      const result = await applyMods(mods, root, settings.options)
      await installDaemonTool(root)
      return result
    })
    const env = { ...process.env, PATH: `${dirname(bun)}:${process.env.PATH}`, HUSKY: "0", OPENCODE_CHANNEL: "infiniteoc", OPENCODE_VERSION: `${settings.upstream.slice(1)}-infiniteoc` }
    await step("[3/4] Installing dependencies", () => checked(bun, ["install", "--frozen-lockfile"], { cwd: root, env }), true)
    await step(`[4/4] Building ${target}`, () => checked(bun, ["run", "script/build.ts", "--single", "--skip-install", "--skip-web-ui"], { cwd: join(root, "packages/cli"), env }), true)
    if (!await exists(binary)) throw new Error(`Build missing expected ${target} artifact`)
    manifest = { key, upstream: settings.upstream, builtAt: new Date().toISOString(), mods: mods.map(mod => mod.id), changes: applied.changes }
    await writeFile(marker, JSON.stringify(manifest, null, 2))
    // launch() falls back to this when a later build fails; a hardlink survives the next rm of root.
    // Best-effort: losing the fallback must never fail a finished build.
    const good = join(runtime, "last-good")
    try {
      await mkdir(good, { recursive: true })
      await rm(join(good, "opencode"), { force: true })
      await link(binary, join(good, "opencode"))
      await copyFile(marker, join(good, "build.json"))
    } catch (error) { console.error(`[InfiniteOC] Could not keep this build as the fallback: ${error.message}`) }
    console.error(`[InfiniteOC] Ready in ${seconds(started)}`)
    return { root, binary, mods, manifest }
  } finally { await release() }
}
export async function launch(args, settings) {
  const notices = []
  const notice = text => { notices.push(text); console.error(`[InfiniteOC] ${text}`) }
  const file = settingsFile()
  const unreadable = error => { throw new Error(`${file}: ${error.message}. Fix or delete it to restore defaults.`) }
  await loadSettings(file).catch(unreadable)
  // First launch on a terminal only (a TUI start, not a one-shot command).
  if (!process.env.INFINITEOC_UPDATED && !args.some(arg => arg.startsWith("-")) && args.length <= 1 && await needsWizard()) {
    const io = terminalIO()
    try { await runWizard({ io }) } finally { io.close() }
  }
  // Personal settings, with an approved infiniteoc.team.json from the project merged underneath.
  const interactive = process.stdin.isTTY && process.stderr.isTTY
  const askIO = interactive ? terminalIO() : undefined
  let team
  try { team = await applyTeam({ file, cwd: process.cwd(), ask: askIO?.ask, load: loadSettings, save: saveSettings }).catch(unreadable) } finally { askIO?.close() }
  const saved = team.saved
  for (const text of team.notices) notice(text)
  // Self-update first; the updated launcher, mods and config then run (and rebuild) in a fresh process.
  if (process.env.INFINITEOC_UPDATED) notice(`Updated InfiniteOC ${process.env.INFINITEOC_UPDATED}`)
  else if (process.env.INFINITEOC_ROLLBACK) notice(process.env.INFINITEOC_ROLLBACK)
  else {
    const summary = await update({ home, saved, motion: !settings.options?.reducedMotion })
    if (summary) {
      // Build the new version first; if that fails the checkout is rolled back and the previous version launches.
      const result = await settle(home, () => run(process.execPath, [join(home, "bin/infiniteoc.mjs"), "setup"]))
      const env = { ...process.env, ...(result.ok ? { INFINITEOC_UPDATED: summary } : { INFINITEOC_ROLLBACK: `Update ${summary} did not build and was rolled back` }) }
      return run(process.execPath, [join(home, "bin/infiniteoc.mjs"), "--", ...args], { env })
    }
  }
  let prepared, hooks
  try {
    prepared = await prepare(settings)
    hooks = await applyMods(prepared.mods, prepared.root, settings.options, true)
  } catch (error) {
    // A broken mod or build must not lock the user out: run the last good build, without mod hooks.
    if (error.exitCode) throw error
    const good = join(home, ".runtime/last-good")
    const manifest = await readFile(join(good, "build.json"), "utf8").then(JSON.parse).catch(() => undefined)
    if (!manifest || !await exists(join(good, "opencode"))) throw error
    console.error(`[InfiniteOC] ${error.message}`)
    notice(`Launching the previous build from ${manifest.builtAt}; fix the mod, then run infiniteoc rebuild`)
    prepared = { binary: join(good, "opencode"), mods: [] }
    hooks = { emit: async () => {} }
  }
  const traffic = await applyTraffic(saved.traffic)
  try {
    // INFINITEOC_UI_CLIENT: one opendaemon client id per launched UI, inherited by its server, terminals and agent.
    // INFINITEOC_SKILLS: the bundled skill library, registered by mods/infiniteoc (mostly unlisted, loadable by ID).
    const context = { args: [...args], env: { ...traffic.env, INFINITEOC_SETTINGS_FILE: file, INFINITEOC_HOME: home, INFINITEOC: "1", OPENCODE_CLIENT: "InfiniteOC", OPENCODE_TUI_CHANNEL: "infiniteoc", INFINITEOC_UI_CLIENT: randomUUID(), INFINITEOC_SKILLS: join(home, "skills") }, cwd: process.cwd() }
    // Possibly inherited from an enclosing InfiniteOC session; only this launch's values may reach the TUI.
    for (const key of ["INFINITEOC_DAEMON_SOCKET", "INFINITEOC_LIVE_MANIFEST", "INFINITEOC_NOTICE", "INFINITEOC_UPDATED", "INFINITEOC_ROLLBACK"]) delete context.env[key]
    if (traffic.socks && !await probeSocks(traffic.socks.host, traffic.socks.port))
      notice(`${socksLabel(saved.traffic.mode, traffic.socks)} unreachable; requests will fail until it runs (change in /settings → InfiniteOC Settings → Traffic)`)
    try {
      const daemon = await ensureDaemon(home)
      context.env.INFINITEOC_DAEMON_SOCKET = daemon.socket
      context.env.INFINITEOC_LIVE_MANIFEST = daemon.manifest
    } catch (error) { notice(`opendaemon unavailable (${error.message}); live reload is off for this session`) }
    // Shown by the TUI as a startup toast.
    if (notices.length) context.env.INFINITEOC_NOTICE = notices.join(" · ")
    for (const mod of prepared.mods) if (mod.beforeLaunch) await mod.beforeLaunch(context)
    await hooks.emit("beforeLaunch", context)
    // Saved before the TUI takes the terminal. It restores it on exit and INT/TERM/HUP; SIGKILL, SIGSEGV and native aborts skip that.
    const tty = process.stdin.isTTY && process.stdout.isTTY ? spawnSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).stdout?.trim() : ""
    const startedAt = new Date()
    const code = await run(prepared.binary, context.args, { cwd: context.cwd, env: context.env })
    const crash = isCrash(code, { tui: !!tty }) ? await writeCrashReport({ home, code, args: context.args, env: context.env, socket: context.env.INFINITEOC_DAEMON_SOCKET, manifest: prepared.manifest, startedAt }).catch(() => undefined) : undefined
    if (tty && code > 128 && ![129, 130, 143].includes(code)) {
      spawnSync("stty", [tty], { stdio: ["inherit", "ignore", "ignore"] })
      // Main screen, cursor on, mouse/focus/paste/color-scheme reporting off, kitty keyboard flags popped, modifyOtherKeys off, any synchronized frame ended.
      process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b[?2031l\x1b[?2026l")
      console.error(`[InfiniteOC] OpenCode ended by a signal (exit ${code}); terminal restored`)
    }
    // After the terminal is restored: written while the TUI's alternate screen is up, it would vanish with it.
    if (crash) console.error(`[InfiniteOC] OpenCode crashed (exit ${code}). Crash report saved to ${crash}`)
    for (const mod of prepared.mods) if (mod.afterExit) await mod.afterExit({ ...context, code })
    await hooks.emit("afterExit", { ...context, code })
    return code
  } finally { await traffic.close() }
}
// Read-only: never downloads, builds, starts the daemon or writes a file.
export async function doctor(settings) {
  const report = {}
  const check = (name, ok, detail, hint, data) => { report[name] = { ok, detail, hint: ok ? undefined : hint, ...data } }
  // A warning is not a failure (exit code stays 0): the launcher repairs it by itself, or it only affects an optional tool.
  const warn = (name, detail, hint, data) => { report[name] = { ok: true, warn: true, detail, hint, ...data } }
  check("platform", supported, `platform ${target}`, "InfiniteOC builds on Linux and macOS (x64/arm64)")
  check("node", Number(process.versions.node.split(".")[0]) >= 22, `node ${process.version}`, "install Node.js 22 or newer")
  const bun = bunVersion(join(home, ".tools/node_modules/.bin/bun"))
  check("bun", Boolean(bun), `bun ${bun ?? "missing or not runnable"}`, "run infiniteoc setup")
  const source = await readFile(join(home, ".upstream/package.json"), "utf8").then(text => `v${JSON.parse(text).version}`).catch(() => undefined)
  check("upstream", source === settings.upstream, `upstream ${source ?? "missing"} (config ${settings.upstream})`, source ? "check out the configured tag in .upstream; nothing is replaced automatically" : "run infiniteoc setup")
  try {
    const key = await fingerprint(settings, await loadMods(settings.mods, home))
    const built = await readFile(join(home, ".runtime/build.json"), "utf8").then(JSON.parse).catch(() => undefined)
    const fresh = built?.key === key && await exists(binary)
    if (fresh) check("build", true, `build from ${built.builtAt} is fresh`)
    else warn("build", built ? `build from ${built.builtAt} is stale` : "no finished build", "the next launch rebuilds; infiniteoc doctor --fix rebuilds now", { fix: "build" })
  } catch (error) { check("build", false, `mods failed to load: ${error.message}`, "fix the mod") }
  // Optional tools (a missing GIMP or Roblox checkout) must not fail the whole report.
  const mcp = []
  for (const file of [join(home, "opencode.json"), providerConfigFile()]) {
    const config = await readFile(file, "utf8").then(JSON.parse, () => undefined)
    for (const { server, path } of config ? await missingPaths(config, home) : []) mcp.push({ file, server, path })
  }
  if (mcp.length) warn("mcp", `MCP paths missing: ${mcp.map(({ server, path }) => `${server} ${path}`).join("; ")}`, "install the tool under .tools, or edit the path; infiniteoc doctor --fix relinks paths that exist in this install", { fix: "mcp", files: [...new Set(mcp.map(item => item.file))] })
  else check("mcp", true, "MCP server paths exist")
  const { socket } = daemonPaths(home)
  try {
    const status = await daemonRequest(socket, "GET", "/status", undefined, 2000)
    const clients = Object.keys(status.clients ?? {}).length
    check("daemon", true, `opendaemon pid ${status.pid}, revision ${status.revision?.slice(0, 8) ?? "none"}, ${clients} UI(s)${status.restartRequired ? ", restart required" : ""}`, undefined, { pid: status.pid, revision: status.revision, clients, restartRequired: status.restartRequired })
  } catch (error) {
    // Not running is the idle state (as in ensureDaemon); every launch starts it.
    if (["ENOENT", "ECONNREFUSED"].includes(error.code)) check("daemon", true, "opendaemon not running; the next launch starts it")
    else check("daemon", false, `opendaemon not reachable (${error.message})`, "run opendaemon serve to see why")
  }
  // Measured: longer socket paths fail with EINVAL (macOS 104 bytes; Linux sun_path 108 incl. NUL); same limit as socketLimit in src/opendaemon.mjs.
  const limit = process.platform === "darwin" ? 104 : 107
  check("socket", Buffer.byteLength(socket) <= limit, `daemon socket path ${Buffer.byteLength(socket)}/${limit} bytes`, "move InfiniteOC to a shorter directory")
  const file = settingsFile()
  try {
    const saved = await loadSettings(file)
    const traffic = await applyTraffic(saved.traffic, {})
    await traffic.close()
    check("settings", true, `settings ${file} (traffic ${saved.traffic.mode})`)
    if (traffic.socks) {
      const reachable = await probeSocks(traffic.socks.host, traffic.socks.port)
      check("socks", reachable, `${socksLabel(saved.traffic.mode, traffic.socks)} ${reachable ? "reachable" : "unreachable"}`, "start it, or change /settings → InfiniteOC Settings → Traffic")
    }
  } catch (error) { check("settings", false, `settings ${file}: ${error.message}`, "fix or delete it to restore defaults") }
  for (const name of ["bun", "upstream"]) if (!report[name].ok) report[name].fix = "tools"
  return report
}
/**
 * Repairs what doctor flagged: missing bun/upstream (downloads), legacy MCP paths, a stale build. Returns what it did.
 * A rebuild is skipped while a UI is connected: replacing the generated source under a live agent is not safe.
 */
export async function doctorFix(settings, report) {
  const did = []
  const fixes = new Set(Object.values(report).map(item => item.fix).filter(Boolean))
  // One failing step must not hide the others; its error is listed and the report is checked again afterwards.
  const step = async (name, task) => { try { did.push(await task()) } catch (error) { did.push(`${name} failed: ${error.message}`) } }
  if (fixes.has("tools")) await step("fetching tools", async () => { await bootstrap(settings); return "fetched missing tools and upstream source" })
  if (fixes.has("mcp")) await step("relinking MCP paths", async () => {
    let count = 0
    for (const file of report.mcp.files) count += await repairPaths(file, home)
    return count ? `relinked ${count} MCP path(s) to ${home}/.tools` : "no MCP path could be relinked (the files do not exist in this install)"
  })
  if (fixes.has("build") || fixes.has("tools")) await step("rebuild", async () => {
    if (report.daemon?.clients > 0) return `skipped the rebuild: ${report.daemon.clients} UI(s) are running; restart them, then run infiniteoc rebuild`
    await prepare(settings)
    return "rebuilt"
  })
  return did
}
