#!/usr/bin/env node
import { config, bootstrap, prepare, launch, home } from "../src/launcher.mjs"
import { loadMods } from "../src/mod-loader.mjs"
import { scaffoldFeature, checkFeatures } from "../src/feature-scaffold.mjs"

try {
  const args = process.argv.slice(2)
  const settings = await config()
  if (args[0] === "help" || args[0] === "--help") {
    console.log(`InfiniteOC — source-backed OpenCode mod launcher

  infiniteoc setup             Fetch dependencies, apply mods, build isolated CLI
  infiniteoc rebuild           Reapply mods from pristine source and rebuild
  infiniteoc mods              List configured mods
  infiniteoc doctor            Check pinned source and runtime prerequisites
  infiniteoc feature new ID    Create a typed, working TUI slash-command mod (not enabled)
  infiniteoc feature check ID  Check feature declarations and pinned UI integration
  infiniteoc [directory/args]  Launch modded OpenCode (private server by default)
  infiniteoc -- [args]         Pass all arguments directly to OpenCode

Configuration: ${home}/infiniteoc.json
Mods are trusted local code, not sandboxed. Stock OpenCode is never patched.`)
  } else if (args[0] === "feature") {
    const id = args[2]
    if (!id || !/^[a-z][a-z0-9-]*$/.test(id) || args.length !== 3) throw new Error("Usage: infiniteoc feature new|check ID")
    if (args[1] === "new") console.log(`Created ${await scaffoldFeature(home, id)}. Not enabled; see its README.`)
    else if (args[1] === "check") console.log(JSON.stringify(await checkFeatures(home, id), null, 2))
    else throw new Error("Usage: infiniteoc feature new|check ID")
  } else if (args[0] === "mods") {
    for (const mod of await loadMods(settings.mods, home)) console.log(`${mod.id}@${mod.version ?? "local"}  ${mod.filename}`)
  } else if (args[0] === "doctor") {
    const tools = await bootstrap(settings)
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, ...tools, upstream: settings.upstream }, null, 2))
  } else if (["setup", "rebuild"].includes(args[0])) {
    const result = await prepare(settings, args[0] === "rebuild")
    console.log(`[InfiniteOC] Ready: ${result.binary}`)
  } else {
    process.exitCode = await launch(args[0] === "--" ? args.slice(1) : args, settings)
  }
} catch (error) {
  console.error(`[InfiniteOC] ${error.message}`)
  process.exitCode = 1
}