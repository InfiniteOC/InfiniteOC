// InfiniteOC agent display: pure helpers for the isolated virtual screen.
// Shared by the server plugin (core) and the TUI /display command, so this file
// imports only node: built-ins and uses erasable TypeScript (tests load it directly).
// The agent's screen is an Xvfb X server, never the user's :0/Wayland session.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

export const TOOL = "agent_display"
export const DEFAULT_DISPLAY = ":99"
export const USER_DISPLAY = ":0"
export const WIDTH = 1280
export const HEIGHT = 800
export const DEPTH = 24
export const MAX_FRAME_BYTES = 5 * 1024 * 1024

/** Isolated display for one server process: env override or the default. */
export function resolveDisplay(env: Record<string, string | undefined> = process.env): string {
  const value = (env.INFINITEOC_AGENT_DISPLAY ?? DEFAULT_DISPLAY).trim()
  if (!/^:\d{1,3}$/.test(value)) throw new Error(`Invalid INFINITEOC_AGENT_DISPLAY ${JSON.stringify(value)}; use like ":99"`)
  if (value === USER_DISPLAY) throw new Error("Refused: the agent display is never the user's :0 session")
  return value
}

/** Where status and frames live (never the project tree, never session history). */
export const dataDir = (env: Record<string, string | undefined> = process.env) =>
  path.join(env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "infiniteoc", "agent-display")
export const statusFile = (env: Record<string, string | undefined> = process.env) => path.join(dataDir(env), "status.json")
export const frameFile = (env: Record<string, string | undefined> = process.env) => path.join(dataDir(env), "frame.png")

export type App = { pid: number; command: string; startedAt: number; log: string }
export type Status = {
  display: string
  running: boolean
  pid?: number
  resolution?: string
  startedAt?: number
  lastFrameAt?: number
  framePath?: string
  showRequestedAt?: number
  showNote?: string
  streamPort?: number
  streamStartedAt?: number
  apps: App[]
}

export const blankStatus = (display: string): Status => ({ display, running: false, apps: [] })

function isStatus(value: unknown): value is Status {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.display === "string" && typeof record.running === "boolean" && Array.isArray(record.apps)
}

/** The last written status, or a blank one for this display. Never throws. */
export function readStatus(env: Record<string, string | undefined> = process.env): Status {
  const display = (() => {
    try {
      return resolveDisplay(env)
    } catch {
      return DEFAULT_DISPLAY
    }
  })()
  try {
    const value = JSON.parse(readFileSync(statusFile(env), "utf8"))
    if (!isStatus(value)) return blankStatus(display)
    if (value.display !== display) return blankStatus(display)
    return value
  } catch {
    return blankStatus(display)
  }
}

export function writeStatus(status: Status, env: Record<string, string | undefined> = process.env) {
  const file = statusFile(env)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(status) + "\n", { mode: 0o600 })
    renameSync(temp, file)
  } finally {
    try {
      unlinkSync(temp)
    } catch {}
  }
}

/** True when the recorded Xvfb pid is this process or still alive. */
export function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** A running record whose process is gone is stale: callers restart instead of reusing it. */
export function sweepStatus(status: Status): Status {
  if (status.running && !pidAlive(status.pid)) return { ...blankStatus(status.display), apps: [] }
  return status
}

/** Xvfb argv for the isolated display. -nolisten tcp keeps it on the local socket only. */
export function xvfbArgs(display: string): string[] {
  return [display, "-screen", "0", `${WIDTH}x${HEIGHT}x${DEPTH}`, "-nolisten", "tcp"]
}

/** Screenshot capture: ImageMagick first, ffmpeg x11grab as fallback. */
export function importArgs(display: string, file: string): { command: string; args: string[] } {
  void display
  return { command: "import", args: ["-window", "root", file] }
}
export function ffmpegArgs(display: string, file: string): { command: string; args: string[] } {
  return { command: "ffmpeg", args: ["-y", "-v", "error", "-f", "x11grab", "-i", display, "-frames:v", "1", file] }
}

/** Env for programs the agent spawns: isolated DISPLAY, never the user's Wayland session. */
export function appEnv(display: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (key === "WAYLAND_DISPLAY") continue
    next[key] = value
  }
  next.DISPLAY = display
  return next
}

export type ExecInput = { command?: unknown; args?: unknown }

const MAX_ARGS = 32
/** Validated spawn input, or the refusal message. */
export function validateExec(input: ExecInput): { command: string; args: string[] } | { error: string } {
  const command = typeof input.command === "string" ? input.command.trim() : ""
  if (!command) return { error: "exec needs a command (an executable on PATH, e.g. { action: \"exec\", command: \"xterm\" })." }
  if (command.includes("\0")) return { error: "Refused: the command contains NUL." }
  const raw = input.args === undefined ? [] : input.args
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) return { error: "args must be an array of strings." }
  if (raw.length > MAX_ARGS) return { error: `Refused: at most ${MAX_ARGS} args.` }
  if (raw.some((item) => item.includes("\0"))) return { error: "Refused: an arg contains NUL." }
  return { command, args: [...raw] }
}

/** One-line log file for a spawned app. */
export const appLog = (pid: number, at = Date.now(), dir = tmpdir()) => path.join(dir, `infiniteoc-agent-display-${pid}-${at}.log`)

/** Window ops the agent can do on its screen (xdotool, preinstalled). */
export const WIN_OPS = ["list", "focus", "move", "resize", "click", "type", "key", "close"] as const
export type WinOp = (typeof WIN_OPS)[number]
export type WinInput = { op?: unknown; window?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown; button?: unknown; text?: unknown; keys?: unknown }

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value)
const needInt = (value: unknown, name: string, min: number, max: number): number | string => {
  if (!isInt(value) || value < min || value > max) return `${name} must be an integer ${min}-${max}.`
  return value
}

/** Validated window input, or the refusal message. */
export function validateWin(input: WinInput): { op: WinOp; window: string; args: string[] } | { error: string } {
  const op = typeof input.op === "string" ? input.op : ""
  if (!(WIN_OPS as readonly string[]).includes(op)) return { error: `win needs op (${WIN_OPS.join(", ")}).` }
  const window = typeof input.window === "string" ? input.window.trim() : ""
  if ((op === "list" ? input.window !== undefined && !window : !window) && op !== "list")
    return { error: "win needs a window (an id from list, or a title fragment)." }
  if (window.includes("\0")) return { error: "Refused: the window contains NUL." }
  const byId = /^\d+$/.test(window)
  const target = (flag: string) => (byId ? [flag, window] : ["search", "--onlyvisible", "--name", window, flag])
  switch (op as WinOp) {
    case "list": {
      if (window) return { op, window, args: ["search", "--onlyvisible", "--name", window, "getwindowname"] }
      return { op, window: "", args: ["search", "--onlyvisible", "", "getwindowname"] }
    }
    case "focus":
      return { op, window, args: [...target("windowactivate")] }
    case "close":
      return { op, window, args: [...target("windowclose")] }
    case "move": {
      const x = needInt(input.x, "x", 0, 8192)
      if (typeof x === "string") return { error: x }
      const y = needInt(input.y, "y", 0, 8192)
      if (typeof y === "string") return { error: y }
      return { op, window, args: [...target("windowmove"), String(x), String(y)] }
    }
    case "resize": {
      const w = needInt(input.w, "w", 1, 8192)
      if (typeof w === "string") return { error: w }
      const h = needInt(input.h, "h", 1, 8192)
      if (typeof h === "string") return { error: h }
      return { op, window, args: [...target("windowsize"), String(w), String(h)] }
    }
    case "click": {
      const button = input.button === undefined ? 1 : input.button
      if (!isInt(button) || button < 1 || button > 9) return { error: "button must be an integer 1-9 (1 left, 2 middle, 3 right)." }
      return { op, window, args: byId ? ["click", "--window", window, String(button)] : ["search", "--onlyvisible", "--name", window, "click", "--window", "%1", String(button)] }
    }
    case "type": {
      const text = typeof input.text === "string" ? input.text : ""
      if (!text || text.length > 4000) return { error: "type needs text (1-4000 chars)." }
      if (text.includes("\0")) return { error: "Refused: the text contains NUL." }
      return { op, window, args: byId ? ["type", "--window", window, "--", text] : ["search", "--onlyvisible", "--name", window, "type", "--window", "%1", "--", text] }
    }
    case "key": {
      const keys = typeof input.keys === "string" ? input.keys.trim() : ""
      if (!keys || keys.length > 200 || /[\0\n]/.test(keys)) return { error: "key needs keys like \"ctrl+q\" (no newlines)." }
      return { op, window, args: byId ? ["key", "--window", window, keys] : ["search", "--onlyvisible", "--name", window, "key", "--window", "%1", keys] }
    }
  }
}

/** Live viewer: loopback only, OS-assigned port. */
export const streamHost = "127.0.0.1"
export const streamRate = 10
export function ffmpegStreamArgs(display: string): string[] {
  return ["-v", "error", "-f", "x11grab", "-r", String(streamRate), "-s", `${WIDTH}x${HEIGHT}`, "-i", display, "-f", "mjpeg", "-q:v", "5", "-"]
}
export const viewerPage = (display: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent display ${display}</title><style>html,body{margin:0;background:#111;height:100%}img{display:block;width:100%;max-width:1280px;margin:0 auto}</style></head><body><img src="/stream.mjpg" alt="Live view of the agent display"></body></html>`

export function describeStatus(status: Status): string {
  const lines = [`Agent display ${status.display}: ${status.running ? `running${status.pid ? ` (pid ${status.pid})` : ""}` : "stopped"}`]
  if (status.resolution) lines[0] += ` · ${status.resolution}`
  if (status.running && status.startedAt) lines[0] += ` · since ${new Date(status.startedAt).toISOString()}`
  lines.push(status.apps.length ? `Apps (${status.apps.length}): ${status.apps.map((app) => `${app.command} (pid ${app.pid})`).join(", ")}` : "Apps: none")
  lines.push(status.lastFrameAt ? `Last frame: ${new Date(status.lastFrameAt).toISOString()}${status.framePath ? ` (${status.framePath})` : ""}` : "Last frame: none yet (screenshot or show takes one)")
  lines.push(status.streamPort ? `Live: http://${streamHost}:${status.streamPort}/ (started ${status.streamStartedAt ? new Date(status.streamStartedAt).toISOString() : "just now"})` : "Live: off (stream starts it on this machine only)")
  return lines.join("\n")
}
