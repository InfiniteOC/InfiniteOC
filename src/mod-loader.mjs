import { readFile, writeFile, mkdir, realpath } from "node:fs/promises"
import { resolve, relative, dirname, isAbsolute, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { installTuiFeatures, validateCommand, replaceExact } from "./tui-features.mjs"

export async function loadMods(paths, base) {
  const ids = new Set()
  return Promise.all(paths.map(async (entry) => {
    const filename = resolve(base, entry)
    const mod = (await import(pathToFileURL(filename).href)).default
    if (!mod || !/^[a-z0-9][a-z0-9._-]*$/i.test(mod.id) || typeof mod.setup !== "function")
      throw new Error(`Invalid mod: ${filename}; expected default { id, setup(api) }`)
    if (ids.has(mod.id)) throw new Error(`Duplicate mod id: ${mod.id}`)
    ids.add(mod.id)
    return { ...mod, filename }
  }))
}

export async function applyMods(mods, root, options = {}, registerOnly = false) {
  const changes = []
  const hooks = new Map()
  const commands = []
  const commandIDs = new Set()
  const actualRoot = await realpath(root)
  async function target(path) {
    if (isAbsolute(path)) throw new Error(`Mod paths must be relative: ${path}`)
    const full = resolve(root, path)
    if (!relative(root, full) || relative(root, full).startsWith(`..${sep}`) || relative(root, full) === "..")
      throw new Error(`Mod path escapes source tree: ${path}`)
    let parent = dirname(full)
    while (true) {
      try {
        const real = await realpath(parent)
        const rel = relative(actualRoot, real)
        if (rel.startsWith(`..${sep}`) || rel === "..") throw new Error(`Symlink escapes source tree: ${path}`)
        break
      } catch (error) {
        if (error.code !== "ENOENT") throw error
        parent = dirname(parent)
      }
    }
    try {
      const real = await realpath(full)
      if (relative(actualRoot, real).startsWith(`..${sep}`)) throw new Error(`Symlink escapes source tree: ${path}`)
    } catch (error) { if (error.code !== "ENOENT") throw error }
    return full
  }
  for (const mod of mods) {
    await mod.setup({
      root, options,
      async read(path) { return readFile(await target(path), "utf8") },
      async write(path, content) {
        if (registerOnly) return
        const full = await target(path)
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, content)
        changes.push({ mod: mod.id, path, action: "write" })
      },
      async patch(path, transform) {
        if (registerOnly) return
        const full = await target(path)
        const before = await readFile(full, "utf8")
        const after = await transform(before)
        if (typeof after !== "string" || after === before)
          throw new Error(`${mod.id}: patch did not change ${path}; upstream may be incompatible`)
        await writeFile(full, after)
        changes.push({ mod: mod.id, path, action: "patch" })
      },
      async patchExact(path, before, after) {
        if (registerOnly) return
        const full = await target(path)
        const source = await readFile(full, "utf8")
        const next = replaceExact(source, before, after, `${mod.id}: ${path}`)
        if (next === source) throw new Error(`${mod.id}: patch did not change ${path}`)
        await writeFile(full, next)
        changes.push({ mod: mod.id, path, action: "patch" })
      },
      tui: {
        command(input) {
          const command = validateCommand(mod.id, input)
          if (commandIDs.has(command.id)) throw new Error(`Duplicate TUI command id: ${command.id}`)
          commandIDs.add(command.id)
          commands.push(command)
        },
      },
      on(event, callback) {
        if (!["beforeLaunch", "afterExit"].includes(event) || typeof callback !== "function")
          throw new Error(`Invalid lifecycle hook: ${event}`)
        const list = hooks.get(event) ?? []
        list.push(callback)
        hooks.set(event, list)
      },
    })
  }
  if (!registerOnly) await installTuiFeatures(commands, {
    async read(path) { return readFile(await target(path), "utf8") },
    async write(path, content) {
      const full = await target(path)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, content)
      changes.push({ mod: "infiniteoc.features", path, action: "write" })
    },
    async patch(path, transform) {
      const full = await target(path)
      const source = await readFile(full, "utf8")
      const next = await transform(source)
      if (typeof next !== "string" || next === source) throw new Error(`Feature integration did not change ${path}`)
      await writeFile(full, next)
      changes.push({ mod: "infiniteoc.features", path, action: "patch" })
    },
  })
  return { changes, featureSources: commands, features: commands.map(({ source, ...metadata }) => metadata), async emit(event, context) {
    for (const hook of hooks.get(event) ?? []) await hook(context)
  } }
}