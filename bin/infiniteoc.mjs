#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { config, prepare, launch, doctor, doctorFix, exists, home, run } from "../src/launcher.mjs"
import { update, settle } from "../src/updater.mjs"
import { needsWizard, runWizard, terminalIO } from "../src/wizard.mjs"
import { bench, format, parseConfig, TASKS } from "../src/bench.mjs"
import { addPack, removePack } from "../src/packs.mjs"
import { findTeamFile, readTeamFile, isTrusted } from "../src/team.mjs"
import { loadSettings, saveSettings, settingsFile } from "../mods/infiniteoc/settings/settings-store.mjs"
import { loadMods } from "../src/mod-loader.mjs"
import { scaffoldFeature, checkFeatures, setFeatureEnabled } from "../src/feature-scaffold.mjs"

try {
  const args = process.argv.slice(2)
  const help = args[0] === "help" || args[0] === "--help"
  // Help must still work when infiniteoc.json is broken.
  const settings = help ? undefined : await config()
  if (help) {
    console.log(`InfiniteOC — source-backed OpenCode mod launcher

  infiniteoc setup               Fetch dependencies, apply mods, build isolated CLI
  infiniteoc rebuild             Reapply mods from pristine source and rebuild
  infiniteoc wizard              Re-run the first-run setup (provider, model, theme, updates, ponytail)
  infiniteoc team [trust|revoke] Show or approve the project's infiniteoc.team.json
  infiniteoc update              Fast-forward this checkout to its remote branch, then rebuild
  infiniteoc bench --a CFG --b CFG  Compare two configurations on a fixed task set (pass rate, tokens, time)
  infiniteoc mods                List configured mods (including installed packs)
  infiniteoc mod add URL         Install a mod pack from git, pinned by --commit and --sha256 (prompts if omitted)
  infiniteoc mod remove ID       Remove an installed pack
  infiniteoc doctor [--json]     Read-only checks; never downloads or changes anything
  infiniteoc doctor --fix        Repair: fetch missing tools, relink MCP paths, rebuild a stale build
  infiniteoc feature new ID      Create a typed, working TUI slash-command mod (not enabled)
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
Mods are trusted local code, not sandboxed. Stock OpenCode is never patched.`)
  } else if (args[0] === "feature") {
    const [, action, id] = args
    const usage = "Usage: infiniteoc feature new|check|enable|disable ID"
    if (!id || !/^[a-z][a-z0-9-]*$/.test(id) || args.length !== 3) throw new Error(usage)
    if (action === "new") console.log(`Created ${await scaffoldFeature(home, id)}. Not enabled; see its README.`)
    else if (action === "check") console.log(JSON.stringify(await checkFeatures(home, id), null, 2))
    else if (action === "enable") {
      if (!await exists(join(home, "mods", id, "index.mjs"))) throw new Error(`No mod at mods/${id}/index.mjs; existing: ${(await readdir(join(home, "mods"))).join(", ")}`)
      // Load errors, invalid declarations and slash collisions fail before infiniteoc.json is written.
      await checkFeatures(home, id)
      console.log(await setFeatureEnabled(home, id, true) ? `Enabled ${id} (backup: infiniteoc.json.bak). A running opendaemon publishes its live commands now; compiled parts apply on the next launch, which rebuilds automatically.` : `${id} is already enabled.`)
    } else if (action === "disable") console.log(await setFeatureEnabled(home, id, false) ? `Disabled ${id} (backup: infiniteoc.json.bak); the next launch rebuilds without it.` : `${id} is not enabled.`)
    else throw new Error(usage)
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
      for (const line of did) console.error(`[InfiniteOC] fixed: ${line}`)
      if (!did.length) console.error("[InfiniteOC] nothing to fix")
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
    if (summary) process.exitCode = (await settle(home, () => run(process.execPath, [join(home, "bin/infiniteoc.mjs"), "setup"]))).ok ? 0 : 1
  } else if (["setup", "rebuild"].includes(args[0])) {
    const result = await prepare(settings, args[0] === "rebuild")
    console.log(`[InfiniteOC] Ready: ${result.binary}`)
  } else {
    const forwarded = args[0] === "--" ? args.slice(1) : args
    // Upstream uninstall deletes the data, config and sessions shared with stock OpenCode; upgrade reinstalls stock OpenCode.
    // The binary refuses too (mods/infiniteoc), but not with that mod disabled or from an older last-good build.
    // effect lets only its global settings precede a subcommand (--[no-]print-logs [bool], --log-level <level>, or --flag=value); any other flag there fails the parse or runs a built-in action instead.
    const command = forwarded.find((arg, i) => !/^--((no-)?print-logs|log-level)(=|$)/.test(arg) && forwarded[i - 1] !== "--log-level" && !(forwarded[i - 1] === "--print-logs" && /^(true|false|yes|no|on|off|[01yn])$/.test(arg)))
    if (["uninstall", "upgrade", "update"].includes(command)) throw new Error(`${command} refused: it would act on your stock OpenCode install and the sessions, credentials and config InfiniteOC shares with it. Update InfiniteOC with infiniteoc update; remove it by deleting this checkout. For OpenCode itself run stock opencode ${command}.`)
    process.exitCode = await launch(forwarded, settings)
  }
} catch (error) {
  console.error(`[InfiniteOC] ${error.message}`)
  process.exitCode = error.exitCode ?? 1
}
