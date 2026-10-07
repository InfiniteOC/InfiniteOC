// Fresh worker per generation: Node's module cache must not reuse old mod setup
// or helper imports. Never run the full rebuild against a running runtime tree.
import { readFile, writeFile, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { loadMods, applyMods } from "./mod-loader.mjs"

export async function buildLive(base, output, revision, progress = () => {}, override) {
  progress("discovering", "Reading configured local mods")
  const config = JSON.parse(await readFile(path.join(base, "infiniteoc.json"), "utf8"))
  const mods = await loadMods(config.mods, base)
  const result = override ? { featureSources: override } : await applyMods(mods, path.join(base, ".upstream"), config.options, true)
  if (result.featureSources.some(command => /(?:from\s*|import\s*\()["'](?:solid-js|@opentui|@opencode)/.test(command.source))) throw new Error("Live handlers cannot import framework modules; use supplied context")
  const seen = new Set()
  const app = await readFile(path.join(base, ".upstream/packages/tui/src/app.tsx"), "utf8")
  for (const command of result.featureSources) {
    for (const name of [command.slash, ...command.aliases]) {
      if (seen.has(name) || [...app.matchAll(/slash:\s*\{([^}]+)\}/g)].some(match => match[1].includes(JSON.stringify(name)))) throw new Error(`Duplicate TUI slash command: /${name}`)
      seen.add(name)
    }
  }
  const directory = path.join(output, "generations", revision)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const entries = []
  try {
    for (const [index, command] of result.featureSources.entries()) {
      progress("compiling", `Compiling ${command.id} (${index + 1}/${result.featureSources.length})`)
      const source = path.join(directory, command.file)
      const bundle = path.join(directory, command.file.replace(/\.tsx$/, ".mjs"))
      // ctx-only handler sources compile without their own copy of TUI contexts.
      // Local source helper imports resolve from the mod's original directory.
      const mod = mods.find(mod => mod.id === command.modID)
      const originalDir = mod ? path.dirname(mod.filename) : base
      const rewritten = command.source.replace(/(from\s*|import\s*\()(["'])(\.\.?\/[^"']+)\2/g, (match, prefix, quote, spec) => {
        if (spec === "./api") return match // type-only FeatureContext is erased
        return `${prefix}${quote}${path.resolve(originalDir, spec)}${quote}`
      })
      await writeFile(source, rewritten, { mode: 0o600 })
      await new Promise((resolve, reject) => {
        const child = spawn(path.join(base, ".tools/node_modules/.bin/bun"), ["build", source, "--target=bun", "--outfile", bundle], { stdio: ["ignore", "pipe", "pipe"] })
        // Do not return compiler excerpts that can contain literals/secrets.
        child.stdout.resume(); child.stderr.resume()
        child.on("error", reject)
        child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Cannot compile ${command.id}; use ctx-only live handlers, or keep UI component/framework imports in a source mod`)))
      })
      const code = await readFile(bundle, "utf8")
      if (/from\s*["'](?:solid-js|@opentui|@opencode)|require\(["'](?:solid-js|@opentui|@opencode)/.test(code)) throw new Error("Live handlers must use the supplied context, not load another framework instance")
      const { source: ignored, ...metadata } = command
      entries.push({ ...metadata, module: pathToFileURL(bundle).href })
    }
    progress("validating", "Bundles compiled; preparing atomic generation")
    return { revision, commands: entries, generatedAt: new Date().toISOString(), hash: createHash("sha256").update(JSON.stringify(entries)).digest("hex") }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [base, output, revision, resultFile] = process.argv.slice(2)
    const manifest = await buildLive(base, output, revision, (stage, message) => process.stdout.write(JSON.stringify({ stage, message }) + "\n"))
    await writeFile(resultFile, JSON.stringify(manifest), { mode: 0o600 })
  } catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1 }
}