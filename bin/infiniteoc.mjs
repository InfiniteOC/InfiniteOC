#!/usr/bin/env node
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { config, prepare, launch, doctor, exists, home } from "../src/launcher.mjs"
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
  infiniteoc mods                List configured mods
  infiniteoc doctor [--json]     Read-only checks; never downloads or changes anything
  infiniteoc feature new ID      Create a typed, working TUI slash-command mod (not enabled)
  infiniteoc feature check ID    Check feature declarations and pinned UI integration
  infiniteoc feature enable ID   Check it, then append it to infiniteoc.json mods (keeps a .bak)
  infiniteoc feature disable ID  Remove it from infiniteoc.json mods (keeps a .bak)
  infiniteoc [directory/args]    Launch modded OpenCode (private server unless --server)
  infiniteoc -- [args]           Pass all arguments directly to OpenCode

Live reload:   opendaemon status | watch | restart (every launch starts it)
Traffic/Tor:   /settings → InfiniteOC Settings, inside the TUI
On PATH:       npm link (in ${home}) installs infiniteoc and opendaemon
Refused:       uninstall, upgrade, update (they act on stock OpenCode data)
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
  } else if (args[0] === "mods") {
    for (const mod of await loadMods(settings.mods, home)) console.log(`${mod.id}@${mod.version ?? "local"}  ${mod.filename}`)
  } else if (args[0] === "doctor") {
    const report = await doctor(settings)
    if (args[1] === "--json") console.log(JSON.stringify(report, null, 2))
    else for (const { ok, detail, hint } of Object.values(report)) console.log(ok ? `✓ ${detail}` : `✗ ${detail}\n    ${hint}`)
    if (Object.values(report).some(check => !check.ok)) process.exitCode = 1
  } else if (["setup", "rebuild"].includes(args[0])) {
    const result = await prepare(settings, args[0] === "rebuild")
    console.log(`[InfiniteOC] Ready: ${result.binary}`)
  } else {
    const forwarded = args[0] === "--" ? args.slice(1) : args
    // Upstream uninstall deletes the data, config and sessions shared with stock OpenCode; upgrade reinstalls stock OpenCode.
    // The binary refuses too (mods/infiniteoc), but not with that mod disabled or from an older last-good build.
    // effect lets only its global settings precede a subcommand (--[no-]print-logs [bool], --log-level <level>, or --flag=value); any other flag there fails the parse or runs a built-in action instead.
    const command = forwarded.find((arg, i) => !/^--((no-)?print-logs|log-level)(=|$)/.test(arg) && forwarded[i - 1] !== "--log-level" && !(forwarded[i - 1] === "--print-logs" && /^(true|false|yes|no|on|off|[01yn])$/.test(arg)))
    if (["uninstall", "upgrade", "update"].includes(command)) throw new Error(`${command} refused: it would act on your stock OpenCode install and the sessions, credentials and config InfiniteOC shares with it. Update InfiniteOC with git pull, then infiniteoc rebuild; remove it by deleting this checkout. For OpenCode itself run stock opencode ${command}.`)
    process.exitCode = await launch(forwarded, settings)
  }
} catch (error) {
  console.error(`[InfiniteOC] ${error.message}`)
  process.exitCode = error.exitCode ?? 1
}
