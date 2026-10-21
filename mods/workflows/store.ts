// InfiniteOC workflows: files shared by the server plugin and the TUI.
//   $XDG_DATA_HOME/infiniteoc/workflows/<parentSessionID>/<workflowID>.json   workflow state
//   … /<workflowID>.cancel                                                    cancel request from the TUI
//   the `workflows` key of the InfiniteOC settings file                       settings (other keys kept)
// Never touches session history. Written to packages/core/src/plugin/infiniteoc-wf-store.ts and
// packages/tui/src/infiniteoc-features/workflows-store.ts by mods/workflows.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { Workflow } from "./dag.ts"
import { applyChange, normalize, type Settings } from "./settings.ts"

export const dataDir = () =>
  path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "infiniteoc", "workflows")
export const settingsFile = () => process.env.INFINITEOC_SETTINGS_FILE || path.join(homedir(), ".config/infiniteoc/settings.json")

const safe = (id: string) => {
  if (!/^[\w-]{1,128}$/.test(id)) throw new Error(`Invalid id: ${id}`)
  return id
}
export const workflowFile = (parentSessionID: string, id: string) => path.join(dataDir(), safe(parentSessionID), `${safe(id)}.json`)
const cancelFile = (parentSessionID: string, id: string) => path.join(dataDir(), safe(parentSessionID), `${safe(id)}.cancel`)

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value)

function atomicWrite(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(temp, text, { mode: 0o600 })
    renameSync(temp, file)
  } finally {
    try {
      unlinkSync(temp)
    } catch {}
  }
}

/** Settings with defaults, read on every use so edits apply without a restart. */
export function readSettings(buildDefault?: boolean): Settings {
  const root = readJson(settingsFile())
  return normalize(record(root) ? root.workflows : undefined, buildDefault)
}

/** Applies one change to the `workflows` key, keeping every other key in the settings file. */
export function changeSetting(key: string, value: string, buildDefault?: boolean): { settings: Settings } | { error: string } {
  const file = settingsFile()
  let root: Record<string, unknown> = {}
  if (existsSync(file)) {
    const parsed = readJson(file)
    // Never rewrite a file we could not parse: it may be JSONC or half-written by someone else.
    if (!record(parsed)) return { error: "The settings file is not strict JSON; edit it by hand." }
    root = parsed
  }
  const result = applyChange(root.workflows, key, value)
  if ("error" in result) return result
  atomicWrite(file, JSON.stringify({ ...root, workflows: result.next }, null, 2) + "\n")
  return { settings: normalize(result.next, buildDefault) }
}

/** Learned step times per model (pool.ts), so a new server starts knowing which models are fast. */
const speedsFile = () => path.join(dataDir(), "..", "model-speeds.json")
const SPEED_MAX_AGE_MS = 24 * 3600 * 1000

/** Speeds measured in the last day: model → average step milliseconds. */
export function loadSpeeds(now = Date.now()): Record<string, number> {
  const raw = readJson(speedsFile())
  if (!record(raw)) return {}
  const out: Record<string, number> = {}
  for (const [model, value] of Object.entries(raw))
    if (record(value) && typeof value.ms === "number" && typeof value.at === "number" && now - value.at < SPEED_MAX_AGE_MS) out[model] = value.ms
  return out
}

const chatsFile = () => path.join(dataDir(), "..", "claude-code-chats.json")

/** InfiniteOC session → its Claude Code session (claude-code.ts), so chats resume after a restart. */
export function loadChats(): Record<string, { claude: string; users: string }> {
  const raw = readJson(chatsFile())
  return record(raw) ? raw : {}
}

/** Records one chat; keeps the 500 most recent. */
export function saveChat(sessionID: string, chat: { claude: string; users: string }) {
  const chats = loadChats()
  delete chats[sessionID]
  chats[sessionID] = chat
  atomicWrite(chatsFile(), JSON.stringify(Object.fromEntries(Object.entries(chats).slice(-500))) + "\n")
}

/** Merges these speeds into the file, stamped now; other models' entries stay. */
export function saveSpeeds(speeds: Record<string, number>, now = Date.now()) {
  if (Object.keys(speeds).length === 0) return
  const raw = readJson(speedsFile())
  const next: Record<string, unknown> = record(raw) ? { ...raw } : {}
  for (const [model, ms] of Object.entries(speeds)) next[model] = { ms, at: now }
  atomicWrite(speedsFile(), JSON.stringify(next) + "\n")
}

export function saveWorkflow(workflow: Workflow) {
  atomicWrite(workflowFile(workflow.parentSessionID, workflow.id), JSON.stringify(workflow) + "\n")
}

const isWorkflow = (value: unknown): value is Workflow =>
  record(value) && typeof value.id === "string" && Array.isArray(value.steps) && record(value.state)

export function loadWorkflow(parentSessionID: string, id: string): Workflow | undefined {
  const value = readJson(workflowFile(parentSessionID, id))
  return isWorkflow(value) ? value : undefined
}

/** Workflows started by a session (or by every session when omitted), newest first. */
export function listWorkflows(parentSessionID?: string, limit = 50): Workflow[] {
  const dirs = parentSessionID ? [safe(parentSessionID)] : safeList(dataDir())
  const result: Workflow[] = []
  for (const dir of dirs)
    for (const name of safeList(path.join(dataDir(), dir))) {
      if (!name.endsWith(".json")) continue
      const value = readJson(path.join(dataDir(), dir, name))
      if (isWorkflow(value)) result.push(value)
    }
  return result.toSorted((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

function safeList(dir: string) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Asks the server that runs the workflow to cancel it; it checks about once a second. */
export function requestCancel(parentSessionID: string, id: string) {
  atomicWrite(cancelFile(parentSessionID, id), String(Date.now()))
}
export const cancelRequested = (parentSessionID: string, id: string) => existsSync(cancelFile(parentSessionID, id))
export function clearCancel(parentSessionID: string, id: string) {
  try {
    unlinkSync(cancelFile(parentSessionID, id))
  } catch {}
}

/** Whether the process that owns a running workflow is still alive. */
export function alive(pid: number | undefined) {
  if (!pid) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Housekeeping at server start: running workflows whose process is gone are marked interrupted
 * (their child sessions stay in history), and finished workflow files older than maxAge are removed.
 */
export function sweep(maxAgeMs = 7 * 24 * 3600 * 1000, now = Date.now()) {
  for (const workflow of listWorkflows(undefined, Number.MAX_SAFE_INTEGER)) {
    if (workflow.status === "running" && !alive(workflow.pid)) {
      workflow.status = "interrupted"
      workflow.endedAt = now
      workflow.error = "the server stopped while it ran"
      for (const state of Object.values(workflow.state))
        if (state.status === "running" || state.status === "pending") {
          state.status = "cancelled"
          state.error = "interrupted"
          state.endedAt = now
        }
      saveWorkflow(workflow)
      continue
    }
    if (workflow.status !== "running" && now - (workflow.endedAt ?? workflow.createdAt) > maxAgeMs) {
      const file = workflowFile(workflow.parentSessionID, workflow.id)
      try {
        unlinkSync(file)
        clearCancel(workflow.parentSessionID, workflow.id)
      } catch {}
    }
  }
  for (const dir of safeList(dataDir())) {
    const full = path.join(dataDir(), dir)
    try {
      if (statSync(full).isDirectory() && safeList(full).length === 0) rmdirSync(full)
    } catch {}
  }
}
