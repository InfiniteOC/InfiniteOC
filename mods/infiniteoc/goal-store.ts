// InfiniteOC /goal state that survives compaction. The transcript's control messages stay the record of
// what happened, but a compaction hides everything before it from the session context, including the
// /goal that started the work. This file per session keeps the goal, its counters and the plan the agent
// records with goal_progress, so the goal and the plan stay in the model's system prompt for the whole run.
// Written to packages/core/src/plugin/infiniteoc-goal-store.ts by mods/infiniteoc. Node built-ins only.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type GoalStatus = "active" | "paused" | "done"
export type GoalRecord = {
  goal: string
  status: GoalStatus
  /** Continuation and verification prompts sent since this goal started. */
  continues: number
  verifies: number
  /** Turns that ended by announcing work instead of doing it. */
  stalls: number
  plan: { done: string[]; todo: string[] }
  note?: string
  updatedAt: number
}

const MAX_ITEMS = 60
const MAX_ITEM = 300
const SAFE = /^[A-Za-z0-9_-]{1,128}$/

export const goalsDir = () => path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "infiniteoc", "goals")
const file = (sessionID: string) => {
  if (!SAFE.test(sessionID)) throw new Error("invalid session id")
  return path.join(goalsDir(), `${sessionID}.json`)
}

export const fresh = (goal: string): GoalRecord => ({ goal, status: "active", continues: 0, verifies: 0, stalls: 0, plan: { done: [], todo: [] }, updatedAt: Date.now() })

export function readGoal(sessionID: string): GoalRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(file(sessionID), "utf8"))
    return value && typeof value.goal === "string" && value.plan ? value : undefined
  } catch {
    return undefined
  }
}

export function writeGoal(sessionID: string, record: GoalRecord) {
  const target = file(sessionID)
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ ...record, updatedAt: Date.now() }) + "\n", { mode: 0o600 })
    renameSync(temp, target)
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Read-modify-write; a missing record stays missing (returns undefined) unless `update` creates one. */
export function updateGoal(sessionID: string, update: (record: GoalRecord | undefined) => GoalRecord | undefined) {
  const next = update(readGoal(sessionID))
  if (next) writeGoal(sessionID, next)
  return next
}

const tidy = (items: unknown) =>
  (Array.isArray(items) ? items : [])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM))
    .filter(Boolean)

/**
 * goal_progress: `plan` replaces the remaining steps (in order), `done` moves steps to the done list
 * (matching remaining ones are removed), `note` keeps one line of state. Lists are capped.
 */
export function applyProgress(record: GoalRecord, input: { plan?: unknown; done?: unknown; note?: unknown }): GoalRecord {
  const done = tidy(input.done)
  const key = (item: string) => item.toLowerCase()
  const finished = new Set(done.map(key))
  const todo = (input.plan !== undefined ? tidy(input.plan) : record.plan.todo).filter((item) => !finished.has(key(item)))
  const all = [...record.plan.done, ...done.filter((item) => !record.plan.done.some((old) => key(old) === key(item)))]
  return {
    ...record,
    plan: { done: all.slice(-MAX_ITEMS), todo: todo.slice(0, MAX_ITEMS) },
    note: typeof input.note === "string" && input.note.trim() ? input.note.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM) : record.note,
  }
}
