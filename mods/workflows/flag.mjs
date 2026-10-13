// The workflows.enabled contract for other mods and launcher hooks (plain Node, no TypeScript).
// See README.md "The workflows.enabled contract". The server and TUI read the same key on every
// request, so a change applies without a rebuild or restart.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const settingsFile = (env = process.env) => env.INFINITEOC_SETTINGS_FILE || path.join(homedir(), ".config/infiniteoc/settings.json")

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

function readRoot(file) {
  if (!existsSync(file)) return {}
  const value = JSON.parse(readFileSync(file, "utf8"))
  if (!record(value)) throw new Error("InfiniteOC settings root must be a JSON object")
  return value
}

/** The explicit value in the settings file: true, false, or undefined when unset (the build default applies). */
export function readWorkflowsEnabled(env = process.env) {
  try {
    const value = readRoot(settingsFile(env)).workflows?.enabled
    return typeof value === "boolean" ? value : undefined
  } catch {
    return undefined
  }
}

/** Sets workflows.enabled, keeping every other key; refuses to rewrite a file that is not strict JSON. */
export function setWorkflowsEnabled(enabled, env = process.env) {
  if (typeof enabled !== "boolean") throw new TypeError("workflows.enabled must be a boolean")
  const file = settingsFile(env)
  let root
  try {
    root = readRoot(file)
  } catch {
    throw new Error(`${file} is not strict JSON; not modified`)
  }
  const workflows = record(root.workflows) ? root.workflows : {}
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ ...root, workflows: { ...workflows, enabled } }, null, 2) + "\n", { mode: 0o600 })
    renameSync(temp, file)
  } finally {
    try {
      unlinkSync(temp)
    } catch {}
  }
  return enabled
}
