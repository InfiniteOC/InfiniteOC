// Fresh worker per generation: Node's module cache must not reuse old mod setup
// or helper imports. Never run the full rebuild against a running runtime tree.
import { readFile, writeFile, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { loadMods, applyMods } from "./mod-loader.mjs"
import { packEntries } from "./packs.mjs"
import { userModEntries } from "./user-mods.mjs"
import { builtinSlashNames, claimSlashNames, safeError } from "./tui-features.mjs"
import { bunCandidates } from "./platform.mjs"
import { existsSync } from "node:fs"

const findBun = (base) => bunCandidates(base).find(file => existsSync(file)) ?? bunCandidates(base)[0]

export async function buildLive(base, output, revision, progress = () => {}, override) {
  progress("discovering", "Reading configured local mods")
  const config = JSON.parse(await readFile(path.join(base, "infiniteoc.json"), "utf8"))
  const mods = await loadMods([...config.mods, ...(await packEntries(base)).entries, ...(await userModEntries()).entries], base)
  const result = override ? { featureSources: override } : await applyMods(mods, path.join(base, ".upstream"), config.options, true)
  if (result.featureSources.some(command => /(?:from\s*|import\s*\()["'](?:solid-js|@opentui|@opencode)/.test(command.source))) throw safeError("Live handlers cannot import framework modules; use supplied context")
  claimSlashNames(result.featureSources, await builtinSlashNames(path.join(base, ".upstream/packages/tui/src")))
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
        const child = spawn(findBun(base), ["build", source, "--target=bun", "--outfile", bundle], { stdio: ["ignore", "pipe", "pipe"] })
        // Do not return compiler excerpts that can contain literals/secrets, except in dev mode (opendaemon dev), where they are the point.
        const dev = process.env.INFINITEOC_LIVE_DEV === "1"
        let diagnostics = ""
        child.stdout.resume(); child.stderr.on("data", data => { if (dev) diagnostics = (diagnostics + data).slice(-1200) })
        child.on("error", reject)
        child.on("exit", code => code === 0 ? resolve() : reject(safeError(`Cannot compile ${command.id}; check its syntax and imports (live handlers are ctx-only; UI components and framework imports belong in a source mod)${diagnostics ? `:\n${diagnostics.trim()}` : ""}`)))
      })
      const code = await readFile(bundle, "utf8")
      if (/from\s*["'](?:solid-js|@opentui|@opencode)|require\(["'](?:solid-js|@opentui|@opencode)/.test(code)) throw safeError("Live handlers must use the supplied context, not load another framework instance")
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
  } catch (error) {
    // stdout becomes daemon status events; only framework-tagged static reasons go there, never compiler output.
    if (error?.safe) process.stdout.write(JSON.stringify({ stage: "invalid", message: error.message }) + "\n")
    process.stderr.write(error.message + "\n"); process.exitCode = 1
  }
}