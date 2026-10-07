import { spawn } from "node:child_process"
import { access, readFile, writeFile, mkdir, cp, rm, readdir } from "node:fs/promises"
import { resolve, join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { loadMods, applyMods } from "./mod-loader.mjs"
import { applyTraffic } from "./traffic.mjs"
import { loadSettings, settingsFile } from "../mods/infiniteoc/settings/settings-store.mjs"
import { ensureDaemon } from "./opendaemon.mjs"
import { installDaemonTool } from "./opendaemon-tool.mjs"

export const home = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export async function exists(path) { try { await access(path); return true } catch { return false } }
export function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: "inherit", ...options })
    const handlers = ["SIGINT", "SIGTERM"].map(signal => {
      const handler = () => child.kill(signal)
      process.on(signal, handler)
      return [signal, handler]
    })
    const clean = () => handlers.forEach(([signal, handler]) => process.off(signal, handler))
    child.on("error", error => { clean(); fail(error) })
    child.on("exit", (code, signal) => { clean(); done(code ?? (signal === "SIGINT" ? 130 : 143)) })
  })
}
async function checked(command, args, options) {
  const code = await run(command, args, options)
  if (code !== 0) throw new Error(`${command} failed (exit ${code})`)
}
export async function config() {
  const value = JSON.parse(await readFile(join(home, "infiniteoc.json"), "utf8"))
  if (!/^v\d+\.\d+\.\d+$/.test(value.upstream) || !Array.isArray(value.mods))
    throw new Error("infiniteoc.json must contain an exact upstream tag and mods array")
  return value
}
export async function bootstrap(settings) {
  const upstream = join(home, ".upstream")
  const bun = join(home, ".tools/node_modules/.bin/bun")
  if (!await exists(bun)) {
    await checked("npm", ["install", "--prefix", join(home, ".tools"), "--ignore-scripts", "bun@1.4.2"])
    await checked(process.execPath, ["install.js"], { cwd: join(home, ".tools/node_modules/bun") })
  }
  if (!await exists(join(upstream, ".git")))
    await checked("git", ["clone", "--depth", "1", "--branch", settings.upstream, "https://github.com/anomalyco/opencode.git", upstream])
  const pkg = JSON.parse(await readFile(join(upstream, "package.json"), "utf8"))
  if (`v${pkg.version}` !== settings.upstream)
    throw new Error(`Source is v${pkg.version}, config requests ${settings.upstream}. Use a matching tag; no automatic destructive update.`)
  return { upstream, bun }
}
async function fingerprint(settings, mods) {
  const hash = createHash("sha256").update(JSON.stringify(settings))
  hash.update(await readFile(fileURLToPath(import.meta.url)))
  hash.update(await readFile(join(home, "src/mod-loader.mjs")))
  hash.update(await readFile(join(home, "src/tui-features.mjs")))
  for (const file of ["live-runtime.ts", "daemon-client.mjs", "opendaemon-tool.mjs"]) hash.update(await readFile(join(home, "src", file)))
  hash.update(await readFile(join(home, "src/traffic.mjs")))
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["node_modules", ".git"].includes(entry.name)) continue
      const file = join(path, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) hash.update(file).update(await readFile(file))
    }
  }
  for (const mod of mods) await visit(dirname(mod.filename))
  return hash.digest("hex")
}
export async function prepare(settings, force = false) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("This initial launcher supports Linux x64 only")
  const { upstream, bun } = await bootstrap(settings)
  const mods = await loadMods(settings.mods, home)
  const key = await fingerprint(settings, mods)
  const runtime = join(home, ".runtime")
  const root = join(runtime, "opencode")
  const binary = join(root, "packages/cli/dist/cli-linux-x64/bin/opencode")
  const marker = join(runtime, "build.json")
  if (!force && await exists(marker) && await exists(binary)) {
    const manifest = JSON.parse(await readFile(marker, "utf8"))
    if (manifest.key === key) return { root, binary, mods, manifest }
  }
  await mkdir(runtime, { recursive: true })
  const lock = join(runtime, "prepare.lock")
  try { await mkdir(lock) } catch { throw new Error(`Another setup is active. If it crashed, remove ${lock} and retry.`) }
  try {
    await rm(marker, { force: true })
    await rm(root, { recursive: true, force: true })
    console.error("[InfiniteOC] Copying pinned source into isolated mod worktree…")
    await cp(upstream, root, { recursive: true, filter: path => ![".git", "node_modules"].includes(path.split("/").at(-1)) })
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
    const applied = await applyMods(mods, root, settings.options)
    await installDaemonTool(root)
    console.error(`[InfiniteOC] Applied ${applied.changes.length} changes from ${mods.length} mod(s). Installing/building…`)
    const env = { ...process.env, PATH: `${dirname(bun)}:${process.env.PATH}`, HUSKY: "0", OPENCODE_CHANNEL: "infiniteoc", OPENCODE_VERSION: `${settings.upstream.slice(1)}-infiniteoc` }
    await checked(bun, ["install", "--frozen-lockfile"], { cwd: root, env })
    await checked(bun, ["run", "script/build.ts", "--single", "--skip-install", "--skip-web-ui"], { cwd: join(root, "packages/cli"), env })
    // Linux x64 is the supported platform of this initial launcher.
    if (!await exists(binary)) throw new Error("Build missing expected Linux x64 artifact")
    const manifest = { key, upstream: settings.upstream, builtAt: new Date().toISOString(), mods: mods.map(mod => mod.id), changes: applied.changes }
    await writeFile(marker, JSON.stringify(manifest, null, 2))
    return { root, binary, mods, manifest }
  } finally { await rm(lock, { recursive: true, force: true }) }
}
export async function launch(args, settings) {
  const prepared = await prepare(settings)
  const hooks = await applyMods(prepared.mods, prepared.root, settings.options, true)
  const saved = await loadSettings()
  const traffic = await applyTraffic(saved.traffic)
  const context = { args: [...args], env: { ...traffic.env, INFINITEOC_SETTINGS_FILE: settingsFile(), INFINITEOC: "1", OPENCODE_CLIENT: "InfiniteOC", OPENCODE_TUI_CHANNEL: "infiniteoc" }, cwd: process.cwd() }
  const daemon = await ensureDaemon(home)
  context.env.INFINITEOC_DAEMON_SOCKET = daemon.socket
  context.env.INFINITEOC_LIVE_MANIFEST = daemon.manifest
  // Private server: do not replace the user's stock background service.
  if (!context.args.length || context.args[0].startsWith("-") || await exists(resolve(context.args[0])))
    if (!context.args.includes("--standalone") && !context.args.includes("--server")) context.args.push("--standalone")
  try {
    for (const mod of prepared.mods) if (mod.beforeLaunch) await mod.beforeLaunch(context)
    await hooks.emit("beforeLaunch", context)
    const code = await run(prepared.binary, context.args, { cwd: context.cwd, env: context.env })
    for (const mod of prepared.mods) if (mod.afterExit) await mod.afterExit({ ...context, code })
    await hooks.emit("afterExit", { ...context, code })
    return code
  } finally { await traffic.close() }
}