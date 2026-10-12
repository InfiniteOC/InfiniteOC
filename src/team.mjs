// Team settings: a committed infiniteoc.team.json in the project (or any parent up to the git root) is merged
// UNDER the personal settings file. A repository is untrusted input, so only an allowlist of keys is read and
// the file has to be approved once (its sha256 is remembered per path) before it applies.
import { readFile, access } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { validateTraffic } from "../mods/infiniteoc/settings/settings-store.mjs"

export const TEAM_FILE = "infiniteoc.team.json"
// Never mods, MCP servers or providers: those run code or hold credentials.
export const TEAM_KEYS = ["traffic", "updates"]
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export async function findTeamFile(cwd) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const file = join(dir, TEAM_FILE)
    try { await access(file); return file } catch {}
    try { await access(join(dir, ".git")); return undefined } catch {}
    if (dirname(dir) === dir) return undefined
  }
}

/** Reads and filters a team file. Throws a readable error for invalid JSON. */
export async function readTeamFile(file) {
  const text = await readFile(file, "utf8")
  let value
  try { value = JSON.parse(text) } catch { throw new Error(`${file} is not valid JSON`) }
  if (!record(value)) throw new Error(`${file} must contain an object`)
  const settings = Object.fromEntries(TEAM_KEYS.filter((key) => record(value[key])).map((key) => [key, value[key]]))
  const ignored = Object.keys(value).filter((key) => !TEAM_KEYS.includes(key) && key !== "$schema")
  return { file, settings, ignored, sha256: createHash("sha256").update(text).digest("hex") }
}

/** Personal values win. A personal value equal to the built-in default counts as unset, because saving any setting writes them all. */
export function mergeTeam(team, personal, defaults = {}) {
  const out = { ...team }
  for (const [key, value] of Object.entries(personal)) {
    if (record(value) && record(team[key])) out[key] = mergeTeam(team[key], value, defaults[key] ?? {})
    else if (!(key in team) || !same(value, defaults[key])) out[key] = value
  }
  return out
}

/** The settings the launcher runs with: personal file (as written) over the approved team file. */
export function effective(personal, team) {
  const merged = team ? mergeTeam(team.settings, personal, { traffic: validateTraffic({}) }) : personal
  return { ...merged, traffic: validateTraffic(merged.traffic), providers: merged.providers || {} }
}

export const isTrusted = (personal, team) => personal.team?.trusted?.[team.file] === team.sha256

const readPersonal = (file) => readFile(file, "utf8").then(JSON.parse, (error) => (error.code === "ENOENT" ? {} : Promise.reject(error)))

/**
 * Settings for this launch. `ask(question)` resolves the answer (undefined without a terminal).
 * Returns { saved, notices }; `saved` is the plain personal settings when there is no approved team file.
 */
export async function applyTeam({ file, cwd, ask, load, save }) {
  const notices = []
  const plain = await load(file)
  const teamFile = await findTeamFile(cwd).catch(() => undefined)
  if (!teamFile) return { saved: plain, notices }
  let team
  try { team = await readTeamFile(teamFile) } catch (error) { return { saved: plain, notices: [`Team settings ignored: ${error.message}`] } }
  if (team.ignored.length) notices.push(`${team.file} keys ignored (not allowed in team settings): ${team.ignored.join(", ")}`)
  if (!Object.keys(team.settings).length) return { saved: plain, notices }
  const personal = await readPersonal(file)
  if (!isTrusted(personal, team)) {
    const answer = ask && await ask(`Apply team settings from ${team.file} (${Object.keys(team.settings).join(", ")})? [y/N] `)
    if (!/^y/i.test(answer ?? "")) return { saved: plain, notices: [...notices, `Team settings in ${team.file} not applied; run infiniteoc team trust to approve them`] }
    await save({ ...plain, team: { ...plain.team, trusted: { ...plain.team?.trusted, [team.file]: team.sha256 } } }, file)
    personal.team = { ...personal.team, trusted: { ...personal.team?.trusted, [team.file]: team.sha256 } }
  }
  return { saved: { ...effective(personal, team) }, notices: [...notices, `Team settings applied from ${team.file}`] }
}
