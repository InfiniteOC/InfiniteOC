#!/usr/bin/env node
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"

export async function checkMod(candidate, launcher = "/home/rize/InfiniteOC") {
  const base = resolve(launcher)
  const filename = resolve(candidate)
  execFileSync(process.execPath, ["--check", filename], { stdio: "pipe" })
  const settings = JSON.parse(await readFile(join(base, "infiniteoc.json"), "utf8"))
  if (!Array.isArray(settings.mods)) throw new Error("Expected infiniteoc.json.mods array")
  const { loadMods, applyMods } = await import(pathToFileURL(join(base, "src/mod-loader.mjs")))
  const paths = settings.mods.map(entry => resolve(base, entry))
  if (!paths.includes(filename)) paths.push(filename)
  const mods = await loadMods(paths, base)
  const temporary = await mkdtemp(join(tmpdir(), "infiniteoc-check-mod-"))
  const root = join(temporary, "source")
  try {
    await cp(join(base, ".upstream"), root, {
      recursive: true,
      filter: path => !["node_modules", ".git"].includes(path.split("/").at(-1)),
    })
    const result = await applyMods(mods, root, settings.options)
    return { mods: mods.map(mod => mod.id), changes: result.changes }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || process.argv.length > 4) {
    console.error("Usage: node check-mod.mjs /absolute/mod/index.mjs [/absolute/InfiniteOC]")
    process.exitCode = 2
  } else {
    try {
      console.log(JSON.stringify(await checkMod(process.argv[2], process.argv[3]), null, 2))
    } catch (error) {
      console.error(`Mod check failed: ${error.message}`)
      process.exitCode = 1
    }
  }
}