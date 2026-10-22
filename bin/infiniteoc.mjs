#!/usr/bin/env node
import { fx } from "../src/fx.mjs"
import { readdir, readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { config, prepare, launch, doctor, doctorFix, exists, home, run } from "../src/launcher.mjs"
import { update, settle } from "../src/updater.mjs"
import { needsWizard, runWizard, terminalIO } from "../src/wizard.mjs"
import { startRemote, remoteFile, isPrivate } from "../src/remote.mjs"
import { bench, format, parseConfig, TASKS } from "../src/bench.mjs"
import { addPack, removePack } from "../src/packs.mjs"
import { findTeamFile, readTeamFile, isTrusted } from "../src/team.mjs"
import { loadSettings, saveSettings, settingsFile } from "../mods/infiniteoc/settings/settings-store.mjs"
import { loadMods } from "../src/mod-loader.mjs"
import { scaffoldFeature, checkFeatures, setFeatureEnabled } from "../src/feature-scaffold.mjs"
import { serve, enableWebUi } from "../src/serve.mjs"

const HELP = `InfiniteOC — source-backed OpenCode mod launcher

  infiniteoc setup               Fetch dependencies, apply mods, build isolated CLI
  infiniteoc rebuild [--clean]   Reapply mods from pristine source and rebuild (--clean: also reinstall dependencies, drop web UI caches)
  infiniteoc wizard              Re-run the first-run setup (provider, model, theme, updates, ponytail)
  infiniteoc team [trust|revoke] Show or approve the project's infiniteoc.team.json
  infiniteoc update              Fast-forward this checkout to its remote branch, then rebuild
  infiniteoc remote [--host IP] [--port N]  Phone page for sessions and permission prompts (opt-in, local network, token)
  infiniteoc remote attach       Open the TUI on the backend the phone page watches
  infiniteoc serve [--hostname H] [--port N] [--cors ORIGIN]  Headless API server of this build (127.0.0.1, password required)
  infiniteoc web [--hostname H] [--port N] [--no-open]        The same server with the web UI, plus a one-time browser sign-in link
  infiniteoc connect [ID [ARG]] [--ask] [--force]  List app connectors, or add one as an MCP server (/apps inside the TUI)
  infiniteoc disconnect ID       Remove a connector (keeps a .bak of the OpenCode config)
  infiniteoc device [list|add NAME URL|remove NAME]  Pair InfiniteOC servers on your other devices for the device agent tool
  infiniteoc new NAME [--template node|python|web]  Create a project in the InfiniteOC projects folder and open it
  infiniteoc projects            List the projects in that folder
  infiniteoc host [--host H] [--port N] [--config FILE]  Password-guarded web app; projects live in each visitor's browser
  infiniteoc host bundle DIR     A clean, web-host-only copy (node host.mjs, Dockerfile) to run anywhere
  infiniteoc graph [--port N] [--no-open]  Local web graph of your projects, sessions and notes
  infiniteoc bench --a CFG --b CFG  Compare two configurations on a fixed task set (pass rate, tokens, time)
  infiniteoc mods                List configured mods (including installed packs)
  infiniteoc mod add URL         Install a mod pack from git, pinned by --commit and --sha256 (prompts if omitted)
  infiniteoc mod remove ID       Remove an installed pack
  infiniteoc doctor [--json]     Read-only checks; never downloads or changes anything
  infiniteoc doctor --fix        Repair: fetch missing tools, relink MCP paths, rebuild a stale build
  infiniteoc feature new ID      Create a typed, working TUI slash-command mod in your personal mods folder (not enabled)
  infiniteoc feature check ID    Check feature declarations and pinned UI integration
  infiniteoc feature enable ID   Check it, then append it to infiniteoc.json mods (keeps a .bak)
  infiniteoc feature disable ID  Remove it from infiniteoc.json mods (keeps a .bak)
  infiniteoc [directory/args]    Launch modded OpenCode (private server unless --server)
  infiniteoc -- [args]           Pass all arguments directly to OpenCode

Live reload:   opendaemon status | watch | restart (every launch starts it)
Traffic/Tor:   /settings → InfiniteOC Settings, inside the TUI
On PATH:       npm link (in ${home}) installs infiniteoc and opendaemon
Auto-update:   checks every 6h at launch; /settings → InfiniteOC Settings → Updates (auto, ask, off)
Refused:       uninstall, upgrade (they act on stock OpenCode data)
Configuration: ${home}/infiniteoc.json
Mods are trusted local code, not sandboxed. Stock OpenCode is never patched.`
// The launcher's own commands; everything else goes to OpenCode, which answers --help itself.
const OWN = ["setup", "rebuild", "wizard", "team", "update", "remote", "serve", "web", "connect", "disconnect", "device", "new", "projects", "host", "graph", "bench", "mods", "mod", "doctor", "feature"]

try {
  const args = process.argv.slice(2)
  const help = args[0] === "help" || args[0] === "--help"
  // `infiniteoc rebuild --help` must explain rebuild, not start one (agents learn commands that way).
  const ownHelp = !help && OWN.includes(args[0]) && args.slice(1, args.includes("--") ? args.indexOf("--") : undefined).some(arg => arg === "--help" || arg === "-h")
  // A bundle made by `infiniteoc host bundle` only runs the web host (node host.mjs).
  if (!help && !ownHelp && args[0] !== "host" && await exists(join(home, "HOST_ONLY"))) throw new Error(`This copy of InfiniteOC only runs the web host: node ${join(home, "host.mjs")} (or npm start). Install InfiniteOC normally to use it in a terminal.`)
  // Help must still work when infiniteoc.json is broken.
  const settings = help || ownHelp ? undefined : await config()
  if (help) {
    console.log(HELP)
  } else if (ownHelp) {
    console.log(HELP.split("\n").filter(line => line.startsWith(`  infiniteoc ${args[0]} `)).join("\n"))
  } else if (args[0] === "feature") {
    const repo = args.includes("--repo")
    const [, action, id, ...extra] = args.filter(arg => arg !== "--repo")
    const usage = "Usage: infiniteoc feature new|check|enable|disable ID   (new --repo: inside this checkout, for contributing to InfiniteOC)"
    if (!id || !/^[a-z][a-z0-9-]*$/.test(id) || extra.length || (repo && action !== "new")) throw new Error(usage)
    const { locateFeature } = await import("../src/feature-scaffold.mjs")
    if (action === "new") {
      const directory = await scaffoldFeature(home, id, { repo })
      console.log(`Created ${directory}. Not enabled; see its README.${repo ? "" : "\nIt is in your personal mods folder (a local git repository, no remote), not in the InfiniteOC checkout."}`)
    } else if (action === "check") console.log(JSON.stringify(await checkFeatures(home, id), null, 2))
    else if (action === "enable") {
      const found = await locateFeature(home, id)
      if (!await exists(join(found.directory, "index.mjs"))) throw new Error(`No mod ${id}: looked in ${found.directory}. Create one with infiniteoc feature new ${id}`)
      // Load errors, invalid declarations and slash collisions fail before anything is written.
      await checkFeatures(home, id)
      const where = found.personal ? "your personal mods.json" : "infiniteoc.json (backup: infiniteoc.json.bak)"
      console.log(await setFeatureEnabled(home, id, true) ? `Enabled ${id} in ${where}. A running opendaemon publishes its live commands now; compiled parts apply on the next launch, which rebuilds automatically.` : `${id} is already enabled.`)
    } else if (action === "disable") console.log(await setFeatureEnabled(home, id, false) ? `Disabled ${id}; the next launch rebuilds without it.` : `${id} is not enabled.`)
    else throw new Error(usage)
  } else if (args[0] === "connect") {
    // Loaded on demand: a problem in that mod must not break launching or any other command.
    const { connect, connectorStatus, findConnector, formatStatus } = await import("../mods/connectors/connectors.mjs")
    const positional = args.slice(1).filter(arg => !arg.startsWith("--"))
    if (!positional.length) console.log(formatStatus(await connectorStatus()))
    else {
      const [id, arg] = positional
      const entry = findConnector(id)
      if (!entry) throw new Error(`Unknown connector "${id}". Run infiniteoc connect to list them.`)
      const values = {}
      const argVar = entry.vars?.find(item => item.arg)
      if (arg && argVar) values[argVar.name] = arg
      // Values are typed at a prompt (secrets hidden), never passed as arguments (shell history, ps).
      if (args.includes("--ask") || args.includes("--token")) {
        if (!entry.vars?.length) throw new Error(`${id} needs no values`)
        if (!process.stdin.isTTY) throw new Error("--ask needs a terminal to type into")
        const io = terminalIO()
        try {
          for (const item of entry.vars) {
            if (values[item.name]) continue
            const keep = process.env[item.name] ? `Enter keeps $${item.name}` : item.optional ? "Enter skips" : `Enter reads $${item.name} later`
            values[item.name] = await io.ask(`${item.name}: ${item.help}${item.secret ? " (hidden)" : ""}\n  ${keep}: `, { secret: Boolean(item.secret) }) ?? ""
          }
        } finally { io.close() }
      }
      const result = await connect(id, { values, force: args.includes("--force") })
      console.log(`Connected ${id} in ${result.configFile}${result.backup ? ` (backup: ${result.backup})` : ""}${result.keyFiles.length ? `\n  secrets stored in ${result.keyFiles.join(", ")} (mode 600), referenced from the config` : ""}\n${result.next.map(line => `  next: ${line}`).join("\n")}\n  next: restart InfiniteOC, or add it live with /apps`)
    }
  } else if (args[0] === "disconnect") {
    const { disconnect } = await import("../mods/connectors/connectors.mjs")
    if (!args[1]) throw new Error("Usage: infiniteoc disconnect ID")
    const result = await disconnect(args[1])
    console.log(`Removed ${args[1]} from ${result.configFile}${result.backup ? ` (backup: ${result.backup})` : ""}. Restart InfiniteOC to drop its tools.`)
  } else if (args[0] === "device") {
    // Paired InfiniteOC servers the agent's device tool works on. Passwords are typed at a prompt
    // (hidden) or taken from INFINITEOC_DEVICE_PASSWORD, never passed as arguments (shell history, ps).
    const Devices = await import("../mods/devices/lib.mjs")
    const [sub, name, url] = args.slice(1).filter(arg => !arg.startsWith("--"))
    if (!sub || sub === "list") {
      const all = await Devices.listDevices()
      console.log(all.length ? [`Paired devices:`, ...all.map(item => `  ${item.name.padEnd(24)} ${item.url}`), "", "Work on one: use the device tool in InfiniteOC."].join("\n") : "No devices paired. Pair one with: infiniteoc device add NAME URL")
    } else if (sub === "add") {
      if (!name || !url) throw new Error("Usage: infiniteoc device add NAME URL   (URL is the device's infiniteoc serve/host address)")
      if (args.slice(1).filter(arg => !arg.startsWith("--")).length > 3) throw new Error("Usage: infiniteoc device add NAME URL   (URL is the device's infiniteoc serve/host address)")
      let password = process.env.INFINITEOC_DEVICE_PASSWORD
      if (!password && process.stdin.isTTY) {
        const io = terminalIO()
        try { password = await io.ask(`Server password for ${url} (hidden): `, { secret: true }) ?? "" } finally { io.close() }
      }
      if (!password) throw new Error("Set INFINITEOC_DEVICE_PASSWORD or type the password at a terminal.")
      const added = await Devices.addDevice({ name, url, password })
      console.log(`Paired ${added.name} (${added.url}). Secrets are stored mode 600, never in the registry.`)
    } else if (sub === "remove") {
      if (!name) throw new Error("Usage: infiniteoc device remove NAME")
      if (args.slice(1).filter(arg => !arg.startsWith("--")).length > 2) throw new Error("Usage: infiniteoc device [list|add NAME URL|remove NAME]")
      console.log(`Unpaired ${(await Devices.removeDevice(name)).name}.`)
    } else throw new Error("Usage: infiniteoc device [list|add NAME URL|remove NAME]")
  } else if (args[0] === "new" || args[0] === "projects") {
    // The same managed folder the agent's project tool uses (mods/projects).
    const Projects = await import("../mods/projects/lib.mjs")
    const root = Projects.projectsRoot()
    if (args[0] === "projects") {
      const all = Projects.listProjects(root)
      console.log(all.length ? [`Projects in ${root}:`, ...all.map(item => `  ${item.name.padEnd(28)} ${item.description}`), "", "Open one: infiniteoc " + JSON.stringify(all[0].dir)].join("\n") : `No projects yet in ${root}. Create one: infiniteoc new NAME [--template node|python|web]`)
    } else {
      const opt = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
      const name = args.slice(1).filter((arg, i, list) => !arg.startsWith("--") && !["--template", "--description"].includes(list[i - 1])).join(" ")
      if (!name) throw new Error("Usage: infiniteoc new NAME [--template empty|node|python|web] [--description TEXT]")
      const created = Projects.createProject({ name, template: opt("--template"), description: opt("--description") }, root)
      spawnSync("git", ["init", "-q"], { cwd: created.dir, stdio: "ignore", windowsHide: true })
      console.error(`[InfiniteOC] Created ${created.dir}`)
      process.exitCode = await launch([created.dir], settings)
    }
  } else if (args[0] === "host") {
    const opt = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
    if (settings.options?.webUi !== true) throw new Error(`infiniteoc host needs the web UI in the build: add "webUi": true to "options" in ${join(home, "infiniteoc.json")} (or run infiniteoc web once and accept), then try again.`)
    const { binary } = await prepare(settings)
    if (args[1] === "bundle") {
      if (!args[2]) throw new Error("Usage: infiniteoc host bundle DIR")
      const { bundleHost } = await import("../src/host-bundle.mjs")
      const result = await bundleHost({ home, binary, target: args[2] })
      console.log(`Wrote a web-host-only copy of InfiniteOC to ${result.directory} (${result.files} files).\n  Run it: cd ${JSON.stringify(result.directory)} && INFINITEOC_HOST_PASSWORD=... node host.mjs\n  Or with Docker: docker build -t infiniteoc-host . && docker run -p 8080:8080 -e INFINITEOC_HOST_PASSWORD=... infiniteoc-host\nSee HOSTING.md there.`)
    } else {
      const { startHost } = await import("../src/host.mjs")
      let password = process.env.INFINITEOC_HOST_PASSWORD
      let generated = false
      if (!password && process.stdin.isTTY) {
        const io = terminalIO()
        try { password = await io.ask("Password for this host (12+ characters, Enter to generate one): ", { secret: true }) } finally { io.close() }
      }
      if (!password) { password = (await import("node:crypto")).randomBytes(18).toString("base64url"); generated = true }
      const { providerConfigFile } = await import("../mods/infiniteoc/settings/settings-store.mjs")
      const hostAddress = opt("--host") ?? "127.0.0.1"
      const running = await startHost({ home, binary, password, host: hostAddress, port: Number(opt("--port") ?? 0), config: opt("--config") ?? providerConfigFile(), idleMinutes: Number(opt("--idle") ?? 30), secureCookies: args.includes("--secure-cookies"), log: (line) => console.error(line) })
      console.log(`InfiniteOC host on ${running.url}${generated ? `\n  Password (generated, shown once): ${password}` : ""}\n  Projects live in each visitor's browser; this machine keeps only a temporary copy in ${running.root}, deleted when the host stops.${hostAddress === "127.0.0.1" ? "" : "\n  Reachable from other machines: put it behind HTTPS (a reverse proxy) before using it over the internet, then add --secure-cookies."}\nCtrl+C stops it.`)
      const stop = async () => { await running.close(); process.exit(0) }
      process.once("SIGINT", stop); process.once("SIGTERM", stop)
      await running.exited
      await running.close()
      throw new Error("The OpenCode backend stopped")
    }
  } else if (args[0] === "graph") {
    const opt = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
    const { startGraph } = await import("../src/graph.mjs")
    const { openBrowser } = await import("../src/serve.mjs")
    const graph = await startGraph({ port: Number(opt("--port") ?? 0) })
    const opened = !args.includes("--no-open") && openBrowser(graph.link)
    console.log(`Project graph on ${graph.url} (this machine only)\n  ${opened ? "Opened in your browser" : "Open"}: ${graph.link}\nCtrl+C stops it.`)
    const stop = async () => { await graph.close(); process.exit(0) }
    process.once("SIGINT", stop); process.once("SIGTERM", stop)
  } else if (args[0] === "bench") {
    const opt = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
    const usage = "Usage: infiniteoc bench --a model=P/M[,agent=X][,ponytail=LEVEL] --b model=P/M[,...] [--runs N] [--tasks FILE] [--timeout SECONDS] [--json] [--yes]"
    if (!opt("--a") || !opt("--b")) throw new Error(usage)
    const configs = [parseConfig(opt("--a")), parseConfig(opt("--b"))]
    const tasks = opt("--tasks") ? JSON.parse(await readFile(opt("--tasks"), "utf8")) : TASKS
    const runs = Number(opt("--runs") ?? 1)
    if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error("--runs must be 1-20")
    // Real providers cost money: say how much work this is and ask, unless --yes.
    const trials = tasks.length * runs * 2
    if (!args.includes("--yes")) {
      if (!process.stdin.isTTY) throw new Error(`This runs ${trials} agent sessions with auto-approved tools against your configured providers. Add --yes to run it.`)
      const io = terminalIO()
      try {
        if (!/^y/i.test(await io.ask(`Run ${trials} agent sessions (${tasks.length} tasks x ${runs} x 2 configurations, tools auto-approved in temp directories) against your configured providers? [y/N] `) ?? "")) throw new Error("Not run")
      } finally { io.close() }
    }
    const { binary } = await prepare(settings)
    const env = { ...process.env, INFINITEOC_SETTINGS_FILE: settingsFile(), INFINITEOC_HOME: home, INFINITEOC: "1", OPENCODE_CLIENT: "InfiniteOC", OPENCODE_TUI_CHANNEL: "infiniteoc", INFINITEOC_SKILLS: join(home, "skills") }
    const results = await bench({ binary, env, configs, tasks, runs, timeout: Number(opt("--timeout") ?? 180) * 1000, progress: (config, trial) => console.error(`[bench] ${config.label}  ${trial.task}  ${trial.pass ? "pass" : "FAIL"}  ${(trial.ms / 1000).toFixed(1)}s`) })
    console.log(args.includes("--json") ? JSON.stringify(results, null, 2) : format(results))
  } else if (args[0] === "remote") {
    const opt = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
    if (args[1] === "attach") {
      // The TUI joins the backend that the phone page watches, so its permission prompts show up there too.
      const state = await readFile(remoteFile(home), "utf8").then(JSON.parse, () => { throw new Error("No remote control is running; start it with infiniteoc remote") })
      try { process.kill(state.pid, 0) } catch { throw new Error("The remote control that wrote this has stopped; start it again with infiniteoc remote") }
      process.env.OPENCODE_PASSWORD = state.password
      process.exitCode = await launch(["--server", state.backendUrl, ...args.slice(2)], settings)
    } else {
      const host = opt("--host")
      if (host && !isPrivate(host)) throw new Error(`${host} is not a private network address; remote control is local network only`)
      const { binary } = await prepare(settings)
      const env = { ...process.env, INFINITEOC_SETTINGS_FILE: settingsFile(), INFINITEOC_HOME: home, INFINITEOC: "1", OPENCODE_CLIENT: "InfiniteOC", OPENCODE_TUI_CHANNEL: "infiniteoc", INFINITEOC_SKILLS: join(home, "skills") }
      const remote = await startRemote({ home, binary, env, host, port: Number(opt("--port") ?? 0) })
      console.log(`Remote control on ${remote.url} (local network only)\n  Open it on your phone, then enter this token:\n    ${remote.token}\n  or open ${remote.url}/#${remote.token}\n\nIt shows sessions and permission prompts of sessions that run on its backend:\n  infiniteoc remote attach     (in another terminal; opens the TUI on that backend)\nTraffic is plain HTTP: use a network you trust, or tunnel it. Ctrl+C stops it.`)
      const stop = async () => { await remote.close(); process.exit(0) }
      process.once("SIGINT", stop); process.once("SIGTERM", stop)
      await remote.exited
      await remote.close()
      throw new Error("The OpenCode backend stopped")
    }
  } else if (args[0] === "mod") {
    const [, action, target, ...rest] = args
    const flag = (name) => rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined
    const usage = "Usage: infiniteoc mod add GIT_URL [--commit FULL_SHA --sha256 DIGEST] | infiniteoc mod remove ID"
    if (action === "add" && target) {
      const tty = process.stdin.isTTY && process.stderr.isTTY
      const io = tty ? terminalIO() : undefined
      const confirm = io && (async (found) => {
        console.error(`\nPack code runs with your permissions, like any mod. Review it first.\n  url     ${found.url}\n  commit  ${found.commit}\n  sha256  ${found.sha256}`)
        return /^y/i.test(await io.ask("Install this exact version? [y/N] ") ?? "")
      })
      try {
        const result = await addPack({ home, url: target, commit: flag("--commit"), sha256: flag("--sha256"), confirm, existing: (await loadMods(settings.mods, home)).map(mod => mod.id) })
        console.log(`Installed ${result.id}\n  pin: --commit ${result.commit} --sha256 ${result.sha256}\nIt is built in on the next launch.`)
      } finally { io?.close() }
    } else if (action === "remove" && target) {
      await removePack(home, target)
      console.log(`Removed ${target}; the next launch rebuilds without it.`)
    } else throw new Error(usage)
  } else if (args[0] === "mods") {
    for (const mod of await loadMods(settings.mods, home)) console.log(`${mod.id}@${mod.version ?? "local"}  ${mod.filename}`)
  } else if (args[0] === "doctor") {
    let report = await doctor(settings)
    if (args.includes("--fix")) {
      const did = await doctorFix(settings, report)
      for (const line of did) console.error(`[InfiniteOC] doctor --fix: ${line}`)
      if (!did.length) console.error("[InfiniteOC] doctor --fix: nothing to fix")
      report = await doctor(settings)
    }
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2))
    else for (const { ok, warn, detail, hint } of Object.values(report)) console.log(warn ? `! ${detail}\n    ${hint}` : ok ? `✓ ${detail}` : `✗ ${detail}\n    ${hint}`)
    if (Object.values(report).some(check => !check.ok)) process.exitCode = 1
  } else if (args[0] === "wizard") {
    const io = terminalIO()
    try { await runWizard({ io }) } finally { io.close() }
  } else if (args[0] === "team") {
    const file = await findTeamFile(process.cwd())
    if (!file) throw new Error("No infiniteoc.team.json in this directory or its parents (up to the git root)")
    const team = await readTeamFile(file)
    const saved = await loadSettings(settingsFile())
    console.log(`${file}\n  sets: ${Object.keys(team.settings).join(", ") || "nothing"}${team.ignored.length ? `\n  ignored (not allowed): ${team.ignored.join(", ")}` : ""}\n  ${isTrusted(saved, team) ? "approved" : "not approved"}`)
    if (args[1] === "trust") {
      await saveSettings({ ...saved, team: { ...saved.team, trusted: { ...saved.team?.trusted, [file]: team.sha256 } } })
      console.log("Approved. It applies from the next launch, until the file changes.")
    } else if (args[1] === "revoke") {
      const { [file]: _, ...rest } = saved.team?.trusted ?? {}
      await saveSettings({ ...saved, team: { ...saved.team, trusted: rest } })
      console.log("Approval removed.")
    } else if (args[1]) throw new Error("Usage: infiniteoc team [trust|revoke]")
  } else if (args[0] === "update") {
    // InfiniteOC's own checkout only; stock OpenCode is never updated. The new code rebuilds in a fresh process.
    // A settings file that cannot be read must fail the update: it may hold updates.requireSigned.
    const saved = await loadSettings(settingsFile()).catch(error => { throw new Error(`${settingsFile()}: ${error.message}. Fix or delete it to restore defaults.`) })
    const summary = await update({ home, saved, explicit: true, motion: !settings.options?.reducedMotion })
    // If the new version does not build, the checkout returns to the previous commit and that is rebuilt.
    if (summary) process.exitCode = (await settle(home, () => run(process.execPath, [join(home, "bin/infiniteoc.mjs"), "setup"]), { motion: !settings.options?.reducedMotion })).ok ? 0 : 1
  } else if (["setup", "rebuild"].includes(args[0])) {
    const result = await prepare(settings, args[0] === "rebuild", { clean: args[0] === "rebuild" && args.includes("--clean") })
    // Scripts read stdout; a terminal gets the same line with a check mark.
    if (process.stdout.isTTY) console.log(fx(process.stdout, { motion: false }).ok(`Ready: ${result.binary}`))
    else console.log(`[InfiniteOC] Ready: ${result.binary}`)
  } else {
    const forwarded = args[0] === "--" ? args.slice(1) : args
    // Upstream uninstall deletes the data, config and sessions shared with stock OpenCode; upgrade reinstalls stock OpenCode.
    // The binary refuses too (mods/infiniteoc), but not with that mod disabled or from an older last-good build.
    // effect lets only its global settings precede a subcommand (--[no-]print-logs [bool], --log-level <level>, or --flag=value); any other flag there fails the parse or runs a built-in action instead.
    const command = forwarded.find((arg, i) => !/^--((no-)?print-logs|log-level)(=|$)/.test(arg) && forwarded[i - 1] !== "--log-level" && !(forwarded[i - 1] === "--print-logs" && /^(true|false|yes|no|on|off|[01yn])$/.test(arg)))
    if (["uninstall", "upgrade", "update"].includes(command)) throw new Error(`${command} refused: it would act on your stock OpenCode install and the sessions, credentials and config InfiniteOC shares with it. Update InfiniteOC with infiniteoc update; remove it with uninstall.sh/uninstall.ps1. For OpenCode itself run stock opencode ${command}.`)
    if (command === "serve" || command === "web") {
      // Also after --: the bind address and password policy must not be skippable.
      const at = forwarded.indexOf(command)
      let current = settings
      if (command === "web" && settings.options?.webUi !== true) {
        const hint = `The web UI is not part of InfiniteOC builds (it makes every build slower and use more memory). Add "webUi": true to "options" in ${join(home, "infiniteoc.json")}, or run infiniteoc serve for the API alone.`
        if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error(hint)
        const io = terminalIO()
        try {
          if (!/^y/i.test(await io.ask("The web UI is not part of InfiniteOC builds yet. Add it? Every build then also compiles the web app (slower, needs more memory). [y/N] ") ?? "")) throw new Error(hint)
        } finally { io.close() }
        await enableWebUi(home)
        console.error("[InfiniteOC] Added \"webUi\": true to infiniteoc.json options (backup: infiniteoc.json.bak); building it in now.")
        current = await config()
      }
      process.exitCode = await serve({ mode: command, prefix: forwarded.slice(0, at), args: forwarded.slice(at + 1), settings: current, launch })
    } else process.exitCode = await launch(forwarded, settings)
  }
} catch (error) {
  // A terminal gets the first line as a red cross and the rest (a failed tool's output) dimmed below it.
  const ui = fx(process.stderr, { motion: false })
  const [first, ...rest] = error.message.split("\n")
  if (ui.color) console.error(`${ui.fail(first)}${rest.length ? `\n${ui.dim(rest.map((line) => `  ${line}`).join("\n"))}` : ""}`)
  else console.error(`[InfiniteOC] ${error.message}`)
  process.exitCode = error.exitCode ?? 1
}
