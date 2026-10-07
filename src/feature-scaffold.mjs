import { mkdir, writeFile, readFile, access } from "node:fs/promises"
import { join } from "node:path"

export async function scaffoldFeature(base, id) {
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error("Feature id must be lowercase letters, digits and hyphens, starting with a letter")
  const directory = join(base, "mods", id)
  try { await access(directory); throw new Error(`Feature directory already exists: ${directory}`) } catch (error) { if (error.code !== "ENOENT") throw error }
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "index.mjs"), `import { readFile } from "node:fs/promises"
export default {
  id: ${JSON.stringify(id)},
  version: "1.0.0",
  async setup(api) {
    api.tui.command({
      id: "main",
      title: ${JSON.stringify(`Run ${id}`)},
      slash: ${JSON.stringify(id)},
      source: await readFile(new URL("./command.tsx", import.meta.url), "utf8"),
    })
  },
}
`, { flag: "wx" })
  await writeFile(join(directory, "command.tsx"), `import type { FeatureContext } from "./api"
export function run(ctx: FeatureContext) {
  ctx.toast.show({ variant: "info", message: ${JSON.stringify(`${id} is running. Open tabs: `)} + ctx.tabs.tabs().length })
}
`, { flag: "wx" })
  await writeFile(join(directory, "README.md"), `# ${id}\n\nEdit command.tsx. Its typed FeatureContext is supplied by InfiniteOC.\nRun: node ${join(base, "bin/infiniteoc.mjs")} feature check ${id}\nThen enable manually in infiniteoc.json.mods and rebuild/restart.\nScaffolding never enables a mod or edits saved sessions.\n`, { flag: "wx" })
  return directory
}

// Dry-run against only the upstream files the declared API actually needs.
// Traditional source mods should use the existing full check-mod script.
export async function checkFeatures(base, candidate) {
  const { loadMods, applyMods } = await import("./mod-loader.mjs")
  const { mkdtemp, cp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const settings = JSON.parse(await readFile(join(base, "infiniteoc.json"), "utf8"))
  const entry = `./mods/${candidate}/index.mjs`
  const mods = await loadMods([...new Set([...settings.mods, entry])], base)
  const registered = await applyMods(mods, join(base, ".upstream"), settings.options, true)
  const temporary = await mkdtemp(join(tmpdir(), "infiniteoc-features-"))
  try {
    for (const file of ["app.tsx", "context/session-tabs.tsx"]) {
      const target = join(temporary, "packages/tui/src", file)
      await mkdir(join(target, ".."), { recursive: true })
      await cp(join(base, ".upstream", "packages/tui/src", file), target)
    }
    const { installTuiFeatures, validateCommand } = await import("./tui-features.mjs")
    // Recollect source descriptors using the same real setup contract; writes,
    // patches and lifecycle hooks are intentionally skipped in this check.
    const commands = []
    for (const mod of mods) await mod.setup({
      root: join(base, ".upstream"), options: settings.options,
      read: file => readFile(join(base, ".upstream", file), "utf8"),
      write: async () => {}, patch: async () => {}, patchExact: async () => {}, on() {},
      tui: { command: input => commands.push(validateCommand(mod.id, input)) },
    })
    await installTuiFeatures(commands, {
      read: file => readFile(join(temporary, file), "utf8"),
      write: async (file, source) => { await mkdir(join(temporary, file, ".."), { recursive: true }); await writeFile(join(temporary, file), source) },
      patch: async (file, transform) => { await writeFile(join(temporary, file), transform(await readFile(join(temporary, file), "utf8"))) },
    })
    return { features: registered.features, note: "Registration and pinned UI anchors checked. Not a TypeScript/build/runtime test; rebuild and interact before declaring success." }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}