// Personal mods live outside the InfiniteOC checkout, next to settings.json: ~/.config/infiniteoc/mods/<id>/.
// The checkout stays exactly what was installed, so updates keep fast-forwarding, and an agent that writes a
// mod for you commits in your own folder (a local git repository with no remote) instead of in a clone of the
// InfiniteOC repository it might push. mods.json there lists the enabled ones; they load after the bundled mods
// and installed packs, in the order they were enabled.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { settingsFile } from "../mods/infiniteoc/settings/settings-store.mjs"

const ID = /^[a-z][a-z0-9-]*$/

export const userModsDir = (env = process.env) => env.INFINITEOC_MODS_DIR || join(dirname(settingsFile(env)), "mods")
const listFile = (env) => join(userModsDir(env), "mods.json")
export const userModPath = (id, env = process.env) => join(userModsDir(env), id, "index.mjs")

export async function readEnabled(env = process.env) {
  try {
    const value = JSON.parse(await readFile(listFile(env), "utf8"))
    return Array.isArray(value?.enabled) ? value.enabled.filter((id) => typeof id === "string" && ID.test(id)) : []
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw new Error(`${listFile(env)}: ${error.message}`)
  }
}

/** Absolute index.mjs paths of the enabled personal mods; a missing one is named in `skipped`. */
export async function userModEntries(env = process.env) {
  const entries = [], skipped = []
  for (const id of await readEnabled(env)) {
    const file = userModPath(id, env)
    if (existsSync(file)) entries.push(file)
    else skipped.push(`${id}: ${file} is missing`)
  }
  return { entries, skipped }
}

/** Adds or removes `id` in mods.json; false when it already was in that state. */
export async function setUserModEnabled(id, enabled, env = process.env) {
  const current = await readEnabled(env)
  if (current.includes(id) === enabled) return false
  const next = enabled ? [...current, id] : current.filter((item) => item !== id)
  await mkdir(userModsDir(env), { recursive: true })
  const temporary = `${listFile(env)}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ enabled: next }, null, 2) + "\n")
  await rename(temporary, listFile(env))
  return true
}

const AGENTS = (home) => `# Personal InfiniteOC mods

This folder holds the user's own InfiniteOC mods. It is NOT the InfiniteOC repository and has no remote.

- Each mod is a folder here with an index.mjs (see ${join(home, "FEATURES.md")} and
  ${join(home, "skills/infiniteoc-mod-development/SKILL.md")}).
- mods.json lists the enabled mods. Use \`infiniteoc feature check|enable|disable ID\`; it edits mods.json.
- Never push. Commit here only when the user asks; this repository is local by design.
- Never edit the InfiniteOC install (${home}) to change a personal mod: that checkout is replaced on update.
`

/** Creates the folder with its AGENTS.md, a README and a local git repository (when git is available). */
export async function ensureUserModsDir(home, env = process.env) {
  const directory = userModsDir(env)
  await mkdir(directory, { recursive: true })
  if (!existsSync(join(directory, "AGENTS.md"))) await writeFile(join(directory, "AGENTS.md"), AGENTS(home))
  if (!existsSync(join(directory, "README.md")))
    await writeFile(join(directory, "README.md"), "# My InfiniteOC mods\n\nCreate one with `infiniteoc feature new ID`, then `infiniteoc feature enable ID`. See AGENTS.md.\n")
  if (!existsSync(join(directory, ".git"))) spawnSync("git", ["init", "-q"], { cwd: directory, stdio: "ignore", windowsHide: true })
  return directory
}
