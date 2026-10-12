import { mkdir, writeFile, readFile, access, rename } from "node:fs/promises"
import { join, resolve } from "node:path"

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
  await writeFile(join(directory, "README.md"), `# ${id}\n\nEdit command.tsx. Its typed FeatureContext is supplied by InfiniteOC.\nRun: node ${join(base, "bin/infiniteoc.mjs")} feature check ${id}\nThen run: node ${join(base, "bin/infiniteoc.mjs")} feature enable ${id}\nScaffolding never enables a mod or edits saved sessions.\n`, { flag: "wx" })
  return directory
}

// Edits only infiniteoc.json mods (other keys and order kept); the previous file is kept as infiniteoc.json.bak.
export async function setFeatureEnabled(base, id, enabled) {
  const file = join(base, "infiniteoc.json")
  const raw = await readFile(file, "utf8")
  const settings = JSON.parse(raw)
  const entry = `./mods/${id}/index.mjs`
  const same = item => resolve(base, item) === resolve(base, entry)
  if (settings.mods.some(same) === enabled) return false
  // ponytail: enable appends, so re-enabling a mod that later mods patch on top of (infiniteoc, under deep-deliberation) fails the next
  // build until it is moved back by hand or infiniteoc.json.bak is restored; re-insert at its index in the .bak if that bites.
  settings.mods = enabled ? [...settings.mods, entry] : settings.mods.filter(item => !same(item))
  await writeFile(`${file}.bak`, raw)
  // Renamed into place: the daemon polls infiniteoc.json and must never read a partial file.
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n")
  await rename(temporary, file)
  return true
}

// Dry-run against only the upstream files the declared API actually needs.
// Traditional source mods should use the existing full check-mod script.
export async function checkFeatures(base, candidate) {
  const { loadMods, applyMods } = await import("./mod-loader.mjs")
  const { mkdtemp, cp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const settings = JSON.parse(await readFile(join(base, "infiniteoc.json"), "utf8"))
  const entry = `./mods/${candidate}/index.mjs`
  const mods = await loadMods([...new Set([...settings.mods, entry].map(item => resolve(base, item)))], base)
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
    }, join(base, ".upstream/packages/tui/src"))
    return { features: registered.features, note: "Registration and pinned UI anchors checked. Not a TypeScript/build/runtime test; rebuild and interact before declaring success." }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}