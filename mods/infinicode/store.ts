// InfiniCode turns workflows on through the workflows.enabled contract (mods/workflows/README.md)
// and gives the user's own value back when it is left. The value from before InfiniCode is kept
// next to the flag, in the same settings file (`infinicode.workflowsBefore`), so a restart or a
// crash while InfiniCode is on still restores it. Written to
// packages/tui/src/infiniteoc-features/infinicode-store.ts by mods/infinicode.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

type Root = Record<string, unknown>
const record = (value: unknown): value is Root => value !== null && typeof value === "object" && !Array.isArray(value)

/** The InfiniteOC settings file, as in mods/workflows/flag.mjs and mods/infiniteoc settings. */
export const settingsFile = (env: Record<string, string | undefined> = process.env) =>
  env.INFINITEOC_SETTINGS_FILE || path.join(homedir(), ".config/infiniteoc/settings.json")

/**
 * Entering InfiniCode: workflows.enabled becomes true and the explicit value from before (true,
 * false, or null when unset) is saved once. Returns the next settings root, or undefined when
 * nothing changes (already entered). Every other key is kept.
 */
export function enter(root: Root): Root | undefined {
  const workflows = record(root.workflows) ? root.workflows : {}
  const state = record(root.infinicode) ? root.infinicode : {}
  const saved = "workflowsBefore" in state
  if (saved && workflows.enabled === true) return undefined
  return {
    ...root,
    workflows: { ...workflows, enabled: true },
    infinicode: saved ? state : { ...state, workflowsBefore: typeof workflows.enabled === "boolean" ? workflows.enabled : null },
  }
}

/**
 * Leaving InfiniCode: the saved value comes back (null removes the key, so the build default
 * applies again) and the saved entry is dropped. A value the user changed while InfiniCode was on
 * (anything but true) is their choice and stays. Undefined when nothing was saved.
 */
export function leave(root: Root): Root | undefined {
  if (!record(root.infinicode) || !("workflowsBefore" in root.infinicode)) return undefined
  const { workflowsBefore, ...state } = root.infinicode
  const workflows = record(root.workflows) ? { ...root.workflows } : {}
  if (workflows.enabled === true) {
    if (typeof workflowsBefore === "boolean") workflows.enabled = workflowsBefore
    else delete workflows.enabled
  }
  const { infinicode: _state, workflows: _workflows, ...rest } = root
  return {
    ...rest,
    ...(Object.keys(workflows).length ? { workflows } : {}),
    ...(Object.keys(state).length ? { infinicode: state } : {}),
  }
}

/** "on", "off" or "default" (unset: the build default applies): workflows.enabled in a settings root. */
export function describe(root: Root) {
  const value = record(root.workflows) ? root.workflows.enabled : undefined
  return typeof value === "boolean" ? (value ? "on" : "off") : "default"
}

/**
 * Applies enter or leave to the settings file: atomic rename, mode 0600, and like the contract's
 * helper it refuses to rewrite a file that is not strict JSON. Returns the resulting
 * workflows.enabled description, or undefined when the file was left as it was.
 */
export function update(transform: (root: Root) => Root | undefined, file = settingsFile()) {
  let root: unknown = {}
  try {
    if (existsSync(file)) root = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    throw new Error(`${file} is not strict JSON; not modified`)
  }
  if (!record(root)) throw new Error(`${file} is not a JSON object; not modified`)
  const next = transform(root)
  if (!next) return undefined
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
    renameSync(temp, file)
  } finally {
    try {
      unlinkSync(temp)
    } catch {}
  }
  return describe(next)
}
