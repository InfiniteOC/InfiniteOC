// InfiniteOC agent display: pure helpers for the isolated virtual screen.
// Shared by the server plugin (core) and the TUI /display command, so this file
// imports only node: built-ins and uses erasable TypeScript (tests load it directly).
// The agent's screen is an Xvfb X server, never the user's :0/Wayland session.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
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
export const settingsFile = (env: Record<string, string | undefined> = process.env) => path.join(dataDir(env), "settings.json")

/** The user's choices for the display, set from /display. Separate from status.json, which the server
 * rewrites all the time. `realistic`: input moves like a person (gliding pointer, human typing, a beat
 * between steps) so it reads as someone using a computer; off by default because it is slower.
 * `camera`: feed the screen to the virtual camera whenever the display runs. */
export type Settings = { realistic: boolean; camera: boolean }
export function readSettings(env: Record<string, string | undefined> = process.env): Settings {
  try {
    const value = JSON.parse(readFileSync(settingsFile(env), "utf8"))
    return { realistic: value?.realistic === true, camera: value?.camera === true }
  } catch {
    return { realistic: false, camera: false }
  }
}
export function writeSettings(settings: Settings, env: Record<string, string | undefined> = process.env) {
  const file = settingsFile(env)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(settings) + "\n", { mode: 0o600 })
    renameSync(temp, file)
  } finally {
    try {
      unlinkSync(temp)
    } catch {}
  }
}

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
  /** The desktop session on this display: window manager and taskbar pids. */
  desktop?: { wm: number; panel?: number }
  /** ffmpeg feeding the virtual camera. */
  camera?: { pid: number; device: string }
  /** ffmpeg recording the screen to a file. */
  recording?: { pid: number; file: string; startedAt: number }
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

/** A running record whose process is gone is stale: callers restart instead of reusing it.
 * Dead apps are pruned too, so status never lists ghosts. Single pass: one pidAlive per app. */
export function sweepStatus(status: Status): Status {
  if (status.running && !pidAlive(status.pid)) return { ...blankStatus(status.display), apps: [] }
  if (!status.running) return status
  let next = status
  const live = status.apps.filter((app) => pidAlive(app.pid))
  if (live.length !== status.apps.length) next = { ...next, apps: live }
  // A camera feed or recording whose ffmpeg ended is over.
  for (const key of ["camera", "recording"] as const) {
    const output = next[key]
    if (output && !pidAlive(output.pid)) {
      next = { ...next }
      delete next[key]
    }
  }
  return next
}

/** Xvfb argv for the isolated display. -nolisten tcp keeps it on the local socket only. */
export function xvfbArgs(display: string): string[] {
  return [display, "-screen", "0", `${WIDTH}x${HEIGHT}x${DEPTH}`, "-nolisten", "tcp"]
}

/** The local socket Xvfb creates once it accepts clients (readiness, ~100ms after spawn). */
export const displaySocket = (display: string) => `/tmp/.X11-unix/X${display.slice(1)}`

/** Screenshot capture: ImageMagick first, ffmpeg x11grab as fallback. */
export function importArgs(display: string, file: string): { command: string; args: string[] } {
  void display
  return { command: "import", args: ["-window", "root", file] }
}
/** Capture one window (by id from win list) instead of the whole screen. Needs ImageMagick. */
export function importWindowArgs(windowId: string, file: string): { command: string; args: string[] } {
  return { command: "import", args: ["-window", windowId, file] }
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

export type ExecInput = { command?: unknown; args?: unknown; env?: unknown }

const MAX_ARGS = 32
const MAX_ENV = 32
const MANAGED_ENV = ["DISPLAY", "WAYLAND_DISPLAY"]
/** Validated spawn input, or the refusal message. */
export function validateExec(input: ExecInput): { command: string; args: string[]; env: Record<string, string> } | { error: string } {
  const command = typeof input.command === "string" ? input.command.trim() : ""
  if (!command) return { error: "exec needs a command (an executable on PATH, e.g. { action: \"exec\", command: \"xterm\" })." }
  if (command.includes("\0")) return { error: "Refused: the command contains NUL." }
  const raw = input.args === undefined ? [] : input.args
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) return { error: "args must be an array of strings." }
  if (raw.length > MAX_ARGS) return { error: `Refused: at most ${MAX_ARGS} args.` }
  if (raw.some((item) => item.includes("\0"))) return { error: "Refused: an arg contains NUL." }
  const rawEnv = input.env === undefined ? {} : input.env
  if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) return { error: "env must be an object of string keys to string values." }
  const entries = Object.entries(rawEnv as Record<string, unknown>)
  if (entries.length > MAX_ENV) return { error: `Refused: at most ${MAX_ENV} env vars.` }
  const env: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (!key || typeof value !== "string" || key.includes("\0") || key.includes("=") || (value as string).includes("\0"))
      return { error: "env keys need no '=' or NUL and values need no NUL (both strings)." }
    if ((MANAGED_ENV as readonly string[]).includes(key)) return { error: `Refused: ${key} is managed by the display and cannot be overridden.` }
    env[key] = value as string
  }
  return { command, args: [...raw], env }
}

/** One-line log file for a spawned app. */
export const appLog = (pid: number, at = Date.now(), dir = tmpdir()) => path.join(dir, `infiniteoc-agent-display-${pid}-${at}.log`)

/** Window and input ops on the agent's screen (xdotool).
 * Coordinates: without `window`, x/y are SCREEN pixels, the same pixels as a full
 * screenshot. With `window`, they are relative to that window's top-left, the same
 * pixels as a screenshot of that window. move uses screen coordinates.
 * Input goes through XTEST like a real mouse and keyboard: Chromium drops the
 * synthetic per-window events `--window` would send. Keyboard ops with a window
 * focus it first; clicks move keyboard focus to what was clicked, because there is
 * no window manager to do it. list, find, wait and sleep only look or pause.
 * label: instead of x/y, click/mousemove/scroll find visible text on screen (OCR) and use its
 * center, so models that misjudge pixels still hit buttons; find lists text with coordinates. */
export const WIN_OPS = ["list", "find", "wait", "sleep", "focus", "move", "resize", "close", "click", "mousedown", "mouseup", "mousemove", "scroll", "drag", "type", "key", "keydown", "keyup"] as const
export type WinOp = (typeof WIN_OPS)[number]
export const LOOK_OPS: readonly WinOp[] = ["list", "find", "wait", "sleep"]
export type WinInput = {
  op?: unknown
  window?: unknown
  x?: unknown
  y?: unknown
  x2?: unknown
  y2?: unknown
  w?: unknown
  h?: unknown
  button?: unknown
  count?: unknown
  text?: unknown
  keys?: unknown
  ms?: unknown
  timeout?: unknown
  label?: unknown
  nth?: unknown
}
/** A validated op. `window` is "" (the screen) or an id/fragment the plugin resolves to one id. */
export type WinPlan = {
  op: WinOp
  window: string
  x?: number
  y?: number
  x2?: number
  y2?: number
  w?: number
  h?: number
  button: number
  count: number
  text?: string
  keys?: string[]
  ms?: number
  timeout: number
  /** Visible text to act on (OCR) instead of x/y; nth picks among several matches. */
  label?: string
  nth: number
}

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value)
const MAX_COORD = 8192
const MAX_STEPS = 50

/** Validated op, or the refusal message. Nothing is resolved or run here. */
export function validateWin(input: WinInput): WinPlan | { error: string } {
  const op = typeof input.op === "string" ? input.op.trim() : ""
  if (!(WIN_OPS as readonly string[]).includes(op)) return { error: `op must be one of ${WIN_OPS.join(", ")}.` }
  if (input.window !== undefined && typeof input.window !== "string") return { error: "window must be a string (an id from list, or a title/class fragment)." }
  const window = typeof input.window === "string" ? input.window.trim() : ""
  if (window.includes("\0")) return { error: "Refused: the window contains NUL." }
  if (window.length > 200) return { error: "window must be at most 200 chars (an id from list, or a short fragment)." }
  const plan: WinPlan = { op: op as WinOp, window, button: 1, count: 1, timeout: 10, nth: 1 }
  let problem = ""
  if (input.label !== undefined) {
    const label = typeof input.label === "string" ? input.label.trim() : ""
    if (!label || label.length > 200 || label.includes("\0")) return { error: "label must be the visible text to find, 1-200 characters." }
    if (!["click", "mousemove", "scroll", "find", "wait"].includes(op)) return { error: `${op} does not take a label; click, mousemove, scroll, find and wait do.` }
    if (input.x !== undefined || input.y !== undefined) return { error: `${op} takes x/y or label, not both.` }
    plan.label = label
  }
  const int = (value: unknown, name: string, min: number, max: number, fallback?: number) => {
    if (value === undefined && fallback !== undefined) return fallback
    if (!isInt(value) || value < min || value > max) problem ||= `${name} must be an integer ${min}-${max}.`
    return value as number
  }
  // Screen pixels must land on the screen; window-relative ones are checked by the window itself.
  const point = (xName: "x" | "x2", yName: "y" | "y2", required: boolean) => {
    if (!required && input[xName] === undefined && input[yName] === undefined) return
    if (input[xName] === undefined || input[yName] === undefined) return void (problem ||= `${plan.op} needs both ${xName} and ${yName}.`)
    plan[xName] = int(input[xName], xName, 0, window ? MAX_COORD : WIDTH - 1)
    plan[yName] = int(input[yName], yName, 0, window ? MAX_COORD : HEIGHT - 1)
  }
  const needWindow = () => {
    if (!window) problem ||= `${plan.op} needs a window (an id from list, or a title/class fragment).`
  }
  if (plan.label) plan.nth = int(input.nth, "nth", 1, 20, 1)
  switch (plan.op) {
    case "list":
    case "find":
      break
    case "wait":
      // A window to appear, or (with label) text on screen.
      if (!plan.label) needWindow()
      plan.timeout = int(input.timeout, "timeout", 1, 25, 10)
      break
    case "sleep":
      plan.ms = int(input.ms, "ms", 1, 10_000, 500)
      break
    case "focus":
    case "close":
      needWindow()
      break
    case "move":
      needWindow()
      plan.x = int(input.x, "x", 0, MAX_COORD)
      plan.y = int(input.y, "y", 0, MAX_COORD)
      break
    case "resize":
      needWindow()
      plan.w = int(input.w, "w", 1, MAX_COORD)
      plan.h = int(input.h, "h", 1, MAX_COORD)
      break
    case "mousemove":
      if (!plan.label) point("x", "y", true)
      break
    case "click":
    case "mousedown":
    case "mouseup":
      point("x", "y", false)
      plan.button = int(input.button, "button", 1, 9, 1)
      if (plan.op === "click") plan.count = int(input.count, "count", 1, 20, 1)
      break
    case "scroll":
      point("x", "y", false)
      plan.button = int(input.button, "scroll button", 4, 7, 5)
      plan.count = int(input.count, "count", 1, 20, 3)
      break
    case "drag":
      point("x", "y", true)
      point("x2", "y2", true)
      plan.button = int(input.button, "drag button", 1, 3, 1)
      break
    case "type": {
      const text = typeof input.text === "string" ? input.text : ""
      if (!text || text.length > 4000) problem ||= "type needs text (1-4000 chars)."
      else if (text.includes("\0")) problem ||= "Refused: the text contains NUL."
      plan.text = text
      break
    }
    case "key":
    case "keydown":
    case "keyup": {
      // Several keystrokes in one call: "ctrl+a BackSpace", "Tab Tab Return".
      const keys = typeof input.keys === "string" ? input.keys.trim().split(/\s+/).filter(Boolean) : []
      if (!keys.length || keys.length > 20 || keys.some((key) => key.length > 64 || key.includes("\0")))
        problem ||= `${plan.op} needs keys like "ctrl+l" or "ctrl+a BackSpace" (1-20 keystrokes, space separated).`
      else if (keys.some((key) => key.startsWith("-"))) problem ||= `${plan.op} keys must not start with "-" (it would parse as an xdotool flag).`
      plan.keys = keys
      if (plan.op === "key") plan.count = int(input.count, "count", 1, 20, 1)
      break
    }
  }
  return problem ? { error: problem } : plan
}

/** A batch of ops run in order in one tool call; all are validated before any runs. */
export function validateSteps(steps: unknown): WinPlan[] | { error: string } {
  if (!Array.isArray(steps) || !steps.length) return { error: 'steps needs a non-empty array like [{ op: "click", x: 640, y: 400 }, { op: "type", text: "hi" }].' }
  if (steps.length > MAX_STEPS) return { error: `Refused: at most ${MAX_STEPS} steps per call.` }
  const plans: WinPlan[] = []
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== "object" || Array.isArray(step)) return { error: `step ${index + 1}: needs an object with op.` }
    const plan = validateWin(step as WinInput)
    if ("error" in plan) return { error: `step ${index + 1} (${String((step as WinInput).op ?? "?")}): ${plan.error}` }
    plans.push(plan)
  }
  return plans
}

export type Point = { x: number; y: number }
/** How input runs. `managed`: a window manager is up, so it activates, focuses on click and closes
 * gracefully. `human`: realistic input is on (/display), so the pointer glides from `from` and
 * presses and typing take human time; `origin` is the target window's top-left on screen (0,0 for
 * screen pixels). */
export type InputMode = { managed?: boolean; human?: { from: Point; origin: Point; random?: () => number } }

/** A human-looking pointer path: eased (fast start, gentle landing), slightly curved, ~83 moves a
 * second, longer for longer distances. Ends exactly on the target. */
export function glidePath(from: Point, to: Point, random: () => number = Math.random, slow = 1): Point[] {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  if (distance < 2) return [to]
  const duration = Math.min(720, 170 + distance * 0.42) * slow
  const count = Math.max(4, Math.round(duration / 12))
  // A control point off the straight line bends the path the way a wrist does.
  const bend = (random() - 0.5) * Math.min(90, distance * 0.22)
  const control = { x: (from.x + to.x) / 2 - ((to.y - from.y) / distance) * bend, y: (from.y + to.y) / 2 + ((to.x - from.x) / distance) * bend }
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
  const points: Point[] = []
  for (let index = 1; index <= count; index++) {
    const t = ease(index / count)
    const point = {
      x: Math.round((1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * control.x + t * t * to.x),
      y: Math.round((1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * control.y + t * t * to.y),
    }
    if (!points.length || points.at(-1)!.x !== point.x || points.at(-1)!.y !== point.y) points.push(point)
  }
  if (points.at(-1)!.x !== to.x || points.at(-1)!.y !== to.y) points.push(to)
  return points
}
export const GLIDE_STEP = "0.012"

/** xdotool argv for one op on a resolved window id (undefined: the screen). list, wait and sleep return []. */
export function winArgs(plan: WinPlan, id?: string, mode: InputMode = {}): string[] {
  const human = mode.human
  let pointer = human?.from
  // Never `mousemove --sync`: it hangs when the pointer already sits on the target.
  const at = (x: number, y: number, slow = 1): string[] => {
    if (!human) return id ? ["mousemove", "--window", id, String(x), String(y)] : ["mousemove", String(x), String(y)]
    const target = { x: human.origin.x + x, y: human.origin.y + y }
    const path = glidePath(pointer!, target, human.random, slow)
    pointer = target
    return path.flatMap((point, index) => [...(index ? ["sleep", GLIDE_STEP] : []), "mousemove", String(point.x), String(point.y)])
  }
  const point = plan.x !== undefined && plan.y !== undefined ? at(plan.x, plan.y) : []
  // With a window manager, activation keeps its focus, title bar and taskbar in step.
  const focus = id ? (mode.managed ? ["windowactivate", "--sync", id] : ["windowfocus", id]) : []
  const button = String(plan.button)
  // A person lands, then presses and releases; xdotool's click is instantaneous.
  const press = (count: number) =>
    human
      ? [...(point.length ? ["sleep", "0.07"] : []), ...Array.from({ length: count }, (_, index) => [...(index ? ["sleep", "0.09"] : []), "mousedown", button, "sleep", "0.05", "mouseup", button]).flat()]
      : ["click", "--repeat", String(count), button]
  switch (plan.op) {
    case "focus":
      return mode.managed ? ["windowactivate", "--sync", id!] : ["windowraise", id!, "windowfocus", id!]
    case "close":
      // windowquit asks the window manager to close it gracefully; without one it would silently do nothing.
      return [mode.managed ? "windowquit" : "windowclose", id!]
    case "move":
      return ["windowmove", id!, String(plan.x), String(plan.y)]
    case "resize":
      return ["windowsize", id!, String(plan.w), String(plan.h)]
    case "mousemove":
      return point
    case "click":
      return [...point, ...press(plan.count)]
    case "scroll":
      return [...point, ...(human ? ["sleep", "0.05", "click", "--repeat", String(plan.count), "--delay", "70", button] : ["click", "--repeat", String(plan.count), button])]
    case "mousedown":
    case "mouseup":
      return [...point, ...(human && point.length ? ["sleep", "0.05"] : []), plan.op, button]
    case "drag": {
      if (human) return [...point, "sleep", "0.08", "mousedown", button, "sleep", "0.1", ...at(plan.x2!, plan.y2!, 1.4), "sleep", "0.08", "mouseup", button]
      // Intermediate moves with short pauses: apps (and HTML drag and drop) need motion to start a drag.
      const lerp = (t: number) => at(Math.round(plan.x! + (plan.x2! - plan.x!) * t), Math.round(plan.y! + (plan.y2! - plan.y!) * t))
      return [...point, "mousedown", button, ...lerp(1 / 3), "sleep", "0.03", ...lerp(2 / 3), "sleep", "0.03", ...lerp(1), "sleep", "0.05", "mouseup", button]
    }
    case "type":
      // Human speed for what a person would type; long pastes still go fast.
      return [...focus, "type", ...(human && plan.text!.length <= 400 ? ["--delay", "38"] : []), "--", plan.text!]
    case "key":
      return [...focus, "key", ...(human ? ["--delay", "110"] : []), "--repeat", String(plan.count), ...plan.keys!]
    case "keydown":
    case "keyup":
      return [...focus, plan.op, ...plan.keys!]
    default:
      return []
  }
}

/** Best-effort click-to-focus after a press when no window manager does it, so the next type/key
 * lands where the agent clicked. A separate call: the click may have closed the window it targeted. */
export function focusAfterArgs(plan: WinPlan, id?: string, mode: InputMode = {}): string[] | undefined {
  if (mode.managed || !["click", "mousedown", "drag"].includes(plan.op)) return undefined
  return id ? ["windowfocus", id] : ["getmouselocation", "windowfocus"]
}

/** Where a pointer op lands on screen, for the live view's click marks. */
export function screenPoint(plan: WinPlan, origin: Point = { x: 0, y: 0 }): { at?: Point; to?: Point } {
  const at = plan.x !== undefined && plan.y !== undefined ? { x: origin.x + plan.x, y: origin.y + plan.y } : undefined
  const to = plan.x2 !== undefined && plan.y2 !== undefined ? { x: origin.x + plan.x2, y: origin.y + plan.y2 } : undefined
  return { at, to }
}

/** What the live view's caption says while an op runs. */
export function caption(plan: WinPlan, title = ""): string {
  const name = title ? ` in ${title.length > 40 ? `${title.slice(0, 39)}…` : title}` : ""
  const quote = (text: string) => `“${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`
  const target = plan.label ? ` ${quote(plan.label)}` : ""
  switch (plan.op) {
    case "click":
      return `${plan.count === 2 ? "Double-clicking" : plan.button === 3 ? "Right-clicking" : "Clicking"}${target}${name}`
    case "find":
      return plan.label ? `Looking for ${quote(plan.label)}` : "Reading the screen"
    case "type":
      return `Typing ${quote(plan.text!.replace(/\s+/g, " "))}${name}`
    case "key":
    case "keydown":
      return `Pressing ${plan.keys!.join(" ")}${name}`
    case "keyup":
      return `Releasing ${plan.keys!.join(" ")}`
    case "scroll":
      return `Scrolling ${{ 4: "up", 5: "down", 6: "left", 7: "right" }[plan.button as 4 | 5 | 6 | 7]}${name}`
    case "drag":
      return `Dragging${name}`
    case "mousemove":
      return plan.label ? `Pointing at ${quote(plan.label)}` : "Moving the pointer"
    case "mousedown":
      return "Holding the mouse button"
    case "mouseup":
      return "Releasing the mouse button"
    case "focus":
      return `Switching to ${title || "a window"}`
    case "close":
      return `Closing ${title || "a window"}`
    case "move":
      return `Moving ${title || "a window"}`
    case "resize":
      return `Resizing ${title || "a window"}`
    case "wait":
      return `Waiting for ${quote(plan.label ?? plan.window)}`
    case "sleep":
      return "Waiting"
    default:
      return "Looking at the windows"
  }
}

/** Short human/permission summary of one op. */
export function describePlan(plan: WinPlan): string {
  const where = plan.window ? ` in ${/^\d+$/.test(plan.window) ? plan.window : JSON.stringify(plan.window)}` : ""
  const label = plan.label ? ` “${plan.label.length > 40 ? `${plan.label.slice(0, 39)}…` : plan.label}”` : ""
  const xy = label || (plan.x !== undefined && plan.y !== undefined ? ` ${plan.x},${plan.y}` : "")
  const clip = (text: string) => JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text)
  switch (plan.op) {
    case "list":
      return plan.window ? `list ${JSON.stringify(plan.window)}` : "list"
    case "find":
      return `find${label || " (all text)"}${where}`
    case "wait":
      return label ? `wait for text${label}${where} (${plan.timeout}s)` : `wait for ${JSON.stringify(plan.window)} (${plan.timeout}s)`
    case "sleep":
      return `sleep ${plan.ms}ms`
    case "move":
      return `move${where} to ${plan.x},${plan.y}`
    case "resize":
      return `resize${where} to ${plan.w}x${plan.h}`
    case "click":
      return `click${xy}${where}${plan.button === 1 ? "" : ` button ${plan.button}`}${plan.count > 1 ? ` x${plan.count}` : ""}`
    case "scroll":
      return `scroll ${{ 4: "up", 5: "down", 6: "left", 7: "right" }[plan.button as 4 | 5 | 6 | 7]} x${plan.count}${xy ? ` at${xy}` : ""}${where}`
    case "drag":
      return `drag ${plan.x},${plan.y}→${plan.x2},${plan.y2}${where}`
    case "type":
      return `type ${clip(plan.text!)}${where}`
    case "key":
    case "keydown":
    case "keyup":
      return `${plan.op} ${plan.keys!.join(" ")}${plan.count > 1 ? ` x${plan.count}` : ""}${where}`
    default:
      return `${plan.op}${xy}${where}`
  }
}

export type Geometry = { w: number; h: number; x: number; y: number }
export type WindowInfo = { id: string; title: string; clazz: string; geometry?: Geometry }

/** Parse `xdotool getwindowgeometry --shell ID getwindowname ID getwindowclassname ID` output.
 * `complete` is false when the chain stopped early (no WM_CLASS): then everything after
 * the geometry is the title. */
export function parseWindowInfo(id: string, output: string, complete: boolean): WindowInfo {
  const lines = output.replace(/\n$/, "").split("\n")
  const values: Record<string, number> = {}
  let index = 0
  for (; index < lines.length; index++) {
    const match = /^(WINDOW|X|Y|WIDTH|HEIGHT|SCREEN)=(-?\d+)$/.exec(lines[index])
    if (!match) break
    values[match[1]] = Number(match[2])
  }
  const rest = lines.slice(index)
  const clazz = complete && rest.length > 1 ? rest.pop()! : ""
  const geometry = "WIDTH" in values && "HEIGHT" in values ? { w: values.WIDTH, h: values.HEIGHT, x: values.X ?? 0, y: values.Y ?? 0 } : undefined
  // xdotool prints "(null)" for a window without WM_CLASS (the root window).
  return { id, title: rest.join(" ").trim(), clazz: clazz.trim() === "(null)" ? "" : clazz.trim(), geometry }
}

/** The root window and 1x1 helper windows match every search; they are never what the agent means. */
export const isRealWindow = (info: WindowInfo) =>
  !!info.geometry && info.geometry.w > 1 && info.geometry.h > 1 && !!(info.title || info.clazz) && !DESKTOP_CLASSES.includes(info.clazz.toLowerCase())
// The desktop's own windows (the taskbar) are scenery, not something the agent works in.
const DESKTOP_CLASSES = ["tint2"]

/** The window a fragment means: the largest match (an app's main window beats its popups). */
export function pickWindow(windows: WindowInfo[]): WindowInfo | undefined {
  return windows.reduce<WindowInfo | undefined>((best, info) => (!best || area(info) > area(best) ? info : best), undefined)
}
const area = (info: WindowInfo) => (info.geometry ? info.geometry.w * info.geometry.h : 0)

export const geometryText = (geometry?: Geometry) => (geometry ? `${geometry.w}x${geometry.h}+${geometry.x}+${geometry.y}` : "")

/** "id: title | class | WxH+X+Y" lines. Newlines are flattened so titles cannot forge lines. */
export function formatWindowList(windows: WindowInfo[]): string {
  const clean = (value: string) => value.replace(/[\r\n]+/g, " ")
  return windows
    .map((entry) => [`${entry.id}: ${entry.title ? clean(entry.title) : "(no title)"}`, ...(entry.clazz ? [clean(entry.clazz)] : []), ...(entry.geometry ? [geometryText(entry.geometry)] : [])].join(" | "))
    .join("\n")
}

/** Parse `xdotool getmouselocation --shell`. */
export function parsePointer(output: string): { x: number; y: number } | undefined {
  const x = /^X=(-?\d+)$/m.exec(output)
  const y = /^Y=(-?\d+)$/m.exec(output)
  return x && y ? { x: Number(x[1]), y: Number(y[1]) } : undefined
}

/** Last lines of a spawned app's log, for exits and windows that never appear. */
export function logTail(text: string, lines = 12): string {
  return text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").split(/\r?\n/).filter((line) => line.trim()).slice(-lines).map((line) => (line.length > 200 ? `${line.slice(0, 199)}…` : line)).join("\n")
}

export type KillInput = { pid?: unknown }
/** Validated kill input, or the refusal message. Only pids tracked in Apps are killable (see plugin). */
export function validateKill(input: KillInput): { pid: number } | { error: string } {
  const pid = input.pid
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return { error: "kill needs a pid (an integer from the Apps line of status)." }
  return { pid }
}

/** Live viewer: loopback only, OS-assigned port. One shared capture at 30fps, cursor drawn in. */
export const streamHost = "127.0.0.1"
export const streamRate = 30
export function ffmpegStreamArgs(display: string): string[] {
  return [
    "-v",
    "error",
    "-f",
    "x11grab",
    "-draw_mouse",
    "1",
    "-framerate",
    String(streamRate),
    "-video_size",
    `${WIDTH}x${HEIGHT}`,
    "-i",
    display,
    "-f",
    "mpjpeg",
    "-pix_fmt",
    "yuvj420p",
    "-q:v",
    "4",
    "-",
  ]
}

/** Splits ffmpeg's mpjpeg output into whole JPEG frames by each part's Content-length. Pipe chunks do
 * not line up with frames (a busy 1280x800 frame spans several), and handing a viewer part of a frame
 * tears the picture. */
export function mpjpegFrames(onFrame: (frame: Buffer) => void) {
  let pending: Buffer = Buffer.alloc(0)
  return (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    for (;;) {
      const headerEnd = pending.indexOf("\r\n\r\n")
      if (headerEnd < 0) break
      const length = /content-length:\s*(\d+)/i.exec(pending.subarray(0, headerEnd).toString("latin1"))
      const start = headerEnd + 4
      if (!length) {
        pending = pending.subarray(start)
        continue
      }
      if (pending.length < start + Number(length[1])) break
      onFrame(Buffer.from(pending.subarray(start, start + Number(length[1]))))
      pending = pending.subarray(start + Number(length[1]))
    }
    // A stream that never completes a part must not grow without bound.
    if (pending.length > 16 * 1024 * 1024) pending = Buffer.alloc(0)
  }
}

// ---- reading the screen: OCR for label clicks and find ------------------------------------------
// Two tesseract passes over one capture: the screenshot as is (dark text on light) and a top-hat
// filtered copy that keeps only thin bright strokes, inverted (light text on buttons, dark themes).
// One pass alone misses white-on-blue button labels entirely.

export type OcrWord = { text: string; conf: number; left: number; top: number; width: number; height: number }
export type Box = { left: number; top: number; width: number; height: number }

/** Screens are read at 1.5x: small UI text reads markedly better, and it costs ~50% more time, not 4x. */
export const OCR_SCALE = 1.5
// -alpha off: an alpha channel would go through the filters too and blank the result.
export const ocrScaleArgs = (input: string, output: string) => [input, "-alpha", "off", "-resize", `${OCR_SCALE * 100}%`, output]
export const ocrLightArgs = (input: string, output: string) => [input, "-alpha", "off", "-colorspace", "gray", "-morphology", "TopHat", "Disk:4", "-threshold", "18%", "-negate", output]
/** Sparse text mode finds scattered UI labels; TSV gives each word's box and confidence. */
export const tesseractArgs = (input: string) => [input, "stdout", "--psm", "11", "tsv"]

/** Words from tesseract TSV (level 5 rows) in screen pixels (`scale`: how much the image was enlarged);
 * empty and failed rows dropped. */
export function parseOcrTsv(tsv: string, scale = 1): OcrWord[] {
  const words: OcrWord[] = []
  for (const row of tsv.split("\n").slice(1)) {
    const cols = row.split("\t")
    if (cols.length < 12 || cols[0] !== "5") continue
    const text = cols.slice(11).join(" ").trim()
    const conf = Number(cols[10])
    if (!text || !(conf >= 0)) continue
    const [left, top, width, height] = cols.slice(6, 10).map((value) => Math.round(Number(value) / scale))
    words.push({ text, conf, left, top, width, height })
  }
  return words
}

const overlap = (a: Box, b: Box) => {
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
  if (width <= 0 || height <= 0) return 0
  const inter = width * height
  return inter / (a.width * a.height + b.width * b.height - inter)
}
export const union = (boxes: Box[]): Box => {
  const left = Math.min(...boxes.map((box) => box.left))
  const top = Math.min(...boxes.map((box) => box.top))
  return { left, top, width: Math.max(...boxes.map((box) => box.left + box.width)) - left, height: Math.max(...boxes.map((box) => box.top + box.height)) - top }
}

/** The plain pass's words, plus the light-text pass's only where the plain pass read nothing: over
 * ordinary text the filtered copy is noise, its job is the light text the plain pass cannot see. */
export function mergeOcrWords(plain: OcrWord[], light: OcrWord[]): OcrWord[] {
  return [...plain, ...light.filter((word) => !plain.some((other) => overlap(word, other) > 0))]
}

/** Words grouped into lines by position (sparse mode does not group reliably): same row, small gaps. */
export function ocrLines(words: OcrWord[]): OcrWord[][] {
  const lines: OcrWord[][] = []
  for (const word of [...words].sort((a, b) => a.left - b.left)) {
    const middle = word.top + word.height / 2
    const line = lines.find((candidate) => {
      const last = candidate.at(-1)!
      const size = Math.max(last.height, word.height)
      const gap = word.left - (last.left + last.width)
      return Math.abs(last.top + last.height / 2 - middle) < size * 0.6 && gap > -size * 0.3 && gap < size * 1.6
    })
    if (line) line.push(word)
    else lines.push([word])
  }
  return lines.sort((a, b) => a[0].top - b[0].top || a[0].left - b[0].left)
}

export type TextMatch = { text: string; score: number; whole: boolean; exact: boolean; x: number; y: number; box: Box }
const normalize = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
const similarity = (a: string, b: string) => {
  if (a === b) return 1
  if (Math.min(a.length, b.length) <= 3) return 0
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return 1 - row[b.length] / Math.max(a.length, b.length)
}

/** Where `label` appears: exact or near (OCR slips like "Consenl") token runs within a line. Ranked by
 * spelling plus a bonus for being the whole line, so a button or link beats the same word inside a
 * sentence even when OCR slipped a letter ("Consenl" the button over "consent" in the heading); then
 * exact case, then top to bottom. Only matches centered inside `within` (a window's box) count. */
export function matchLabel(lines: OcrWord[][], label: string, within?: Box): TextMatch[] {
  const query = normalize(label).split(" ").filter(Boolean)
  if (!query.length) return []
  const matches: TextMatch[] = []
  for (const line of lines) {
    const tokens = line.flatMap((word) => normalize(word.text).split(" ").filter(Boolean).map((token) => ({ token, word })))
    for (let start = 0; start + query.length <= tokens.length; start++) {
      const run = tokens.slice(start, start + query.length)
      const score = run.reduce((sum, item, index) => sum + similarity(item.token, query[index]), 0) / query.length
      if (score < 0.75) continue
      const words = [...new Set(run.map((item) => item.word))]
      const box = union(words)
      const x = Math.round(box.left + box.width / 2)
      const y = Math.round(box.top + box.height / 2)
      if (within && !(x >= within.left && x < within.left + within.width && y >= within.top && y < within.top + within.height)) continue
      const text = words.map((word) => word.text).join(" ")
      const whole = run.length === tokens.length
      const exact = normalize(label) === normalize(text) && text.replace(/[^\p{L}\p{N} ]+/gu, "").trim() === label.replace(/[^\p{L}\p{N} ]+/gu, "").trim()
      matches.push({ text, score, whole, exact, x, y, box })
    }
  }
  const rank = (match: TextMatch) => [-(match.score + (match.whole ? 0.3 : 0)), match.exact ? 0 : 1, row(match.box), match.box.left]
  const unique: TextMatch[] = []
  for (const match of matches.sort((a, b) => compare(rank(a), rank(b))))
    if (!unique.some((other) => overlap(match.box, other.box) > 0.5)) unique.push(match)
  return unique
}

const row = (box: Box) => Math.round((box.top + box.height / 2) / 12)
const compare = (a: number[], b: number[]) => {
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index]
  return 0
}

/** Visible text in reading order, a line per row with its center to click: `“Consent” 620,604`.
 * Icon noise (a lone "x" or "+" read off a glyph) is left out. */
export function formatText(lines: OcrWord[][], limit = 150): string {
  // Low-confidence readings (logos, images, icons) are dropped from the listing; matching still sees them.
  const readable = lines
    .map((line) => line.filter((word) => word.conf >= 55))
    .filter((line) => line.length && normalize(line.map((word) => word.text).join(" ")).replace(/ /g, "").length >= 2)
    .sort((a, b) => compare([row(union(a)), union(a).left], [row(union(b)), union(b).left]))
  const rows = readable.slice(0, limit).map((line) => {
    const box = union(line)
    return `“${line.map((word) => word.text).join(" ")}” ${Math.round(box.left + box.width / 2)},${Math.round(box.top + box.height / 2)}`
  })
  return rows.join("\n") + (readable.length > limit ? `\n… ${readable.length - limit} more lines` : "")
}

// ---- outputs: the virtual camera and recordings ----------------------------------------------
// Both are detached ffmpeg processes that read the agent's X screen; started by the TUI (/display) or
// the server, they outlive whoever started them and end when the display stops.

/** The v4l2loopback device the camera feeds, as apps (Discord, OBS, browsers) list it. */
export const CAMERA_LABEL = "InfiniteOC agent display"
export const CAMERA_NR = 42
/** Root loads the module once per boot; exclusive_caps makes Chromium-based apps (Discord) list it. */
export const cameraLoadArgs = () => ["modprobe", "v4l2loopback", `video_nr=${CAMERA_NR}`, `card_label=${CAMERA_LABEL}`, "exclusive_caps=1"]

/** The camera device (/dev/videoN), found by its label; undefined until the module is loaded. */
export function findCamera(sys = "/sys/class/video4linux"): string | undefined {
  try {
    for (const entry of readdirSync(sys).sort()) {
      try {
        if (readFileSync(path.join(sys, entry, "name"), "utf8").trim() === CAMERA_LABEL) return `/dev/${entry}`
      } catch {}
    }
  } catch {}
  return undefined
}

const grab = (display: string) => ["-v", "error", "-f", "x11grab", "-draw_mouse", "1", "-framerate", String(streamRate), "-video_size", `${WIDTH}x${HEIGHT}`, "-i", display]
/** 16:9 for video calls: the 16:10 screen scaled into 1280x720 with dark side bars, never stretched. */
export function cameraArgs(display: string, device: string): string[] {
  const height = 720
  const width = Math.round((WIDTH * height) / HEIGHT / 2) * 2
  return [...grab(display), "-vf", `scale=${width}:${height}:flags=bicubic,pad=1280:${height}:${(1280 - width) / 2}:0:color=0x07060d,format=yuv420p`, "-f", "v4l2", device]
}
/** H.264 MP4, fragmented at a keyframe every 2s and flushed as it goes, so a recording cut off by the
 * display stopping (ffmpeg dies with the X server) keeps all but its last two seconds. */
export function recordArgs(display: string, file: string): string[] {
  return [
    ...grab(display),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(streamRate * 2),
    "-flush_packets",
    "1",
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    file,
  ]
}

/** The user's videos folder (localized names come from user-dirs.dirs), else ~/Videos. */
export function videosDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  if (env.XDG_VIDEOS_DIR) return env.XDG_VIDEOS_DIR
  try {
    const dirs = readFileSync(path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "user-dirs.dirs"), "utf8")
    const match = /^XDG_VIDEOS_DIR="([^"]+)"/m.exec(dirs)
    if (match) return match[1].replace(/^\$HOME/, home)
  } catch {}
  return path.join(home, "Videos")
}
export function recordingFile(dir: string, at = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return path.join(dir, `agent-display-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}_${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}.mp4`)
}

/** A detached ffmpeg on the agent display; its pid, or undefined when it could not start. */
export function spawnFfmpeg(args: string[], display: string): number | undefined {
  const child = spawn("ffmpeg", args, { detached: true, stdio: "ignore", env: { ...process.env, DISPLAY: display } })
  child.on("error", () => {})
  child.unref()
  return child.pid
}

/** Loads the camera module through pkexec (the desktop asks for the password); resolves to the device or why not. */
export function loadCamera(): Promise<{ device: string } | { error: string }> {
  return new Promise((resolve) => {
    const child = spawn("pkexec", cameraLoadArgs(), { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr?.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => resolve({ error: `pkexec could not run (${error.message}); load it yourself: sudo ${cameraLoadArgs().join(" ")}` }))
    child.on("close", (code) => {
      const device = findCamera()
      if (device) return resolve({ device })
      if (code === 126 || code === 127) return resolve({ error: "The password prompt was dismissed; nothing was loaded." })
      if (existsSync("/sys/module/v4l2loopback"))
        return resolve({ error: `v4l2loopback is already loaded with other devices. Unload it (sudo modprobe -r v4l2loopback) or add a device labeled “${CAMERA_LABEL}”.` })
      resolve({ error: `Loading v4l2loopback failed${stderr.trim() ? `: ${stderr.trim().split("\n")[0]}` : ` (exit ${code})`}. Your kernel may need the v4l2loopback-dkms package.` })
    })
  })
}

/** Starts the camera feed when the user turned it on, the display runs and the device exists. */
export function ensureCamera(status: Status, env: Record<string, string | undefined> = process.env, find = findCamera, start = spawnFfmpeg): Status {
  if (!readSettings(env).camera || !status.running || (status.camera && pidAlive(status.camera.pid))) return status
  const device = find()
  if (!device) return status
  const pid = start(cameraArgs(status.display, device), status.display)
  return pid ? { ...status, camera: { pid, device } } : status
}

/** The live page with this display's name and size filled in. */
export const viewerHtml = (template: string, display: string) =>
  template.replaceAll("__DISPLAY__", display).replaceAll("__WIDTH__", String(WIDTH)).replaceAll("__HEIGHT__", String(HEIGHT))

export function describeStatus(status: Status): string {
  const lines = [`Agent display ${status.display}: ${status.running ? `running${status.pid ? ` (pid ${status.pid})` : ""}` : "stopped"}`]
  if (status.resolution) lines[0] += ` · ${status.resolution}`
  if (status.running && status.startedAt) lines[0] += ` · since ${new Date(status.startedAt).toISOString()}`
  if (status.running)
    lines.push(
      status.desktop && pidAlive(status.desktop.wm)
        ? `Desktop: openbox window manager${status.desktop.panel ? " + taskbar (bottom 36px)" : ""}`
        : "Desktop: bare X (install openbox and tint2 for title bars, a taskbar and a wallpaper)",
    )
  lines.push(readSettings().realistic ? "Input: realistic (pointer glides, human typing; /display turns it off)" : "Input: instant (/display turns on realistic input)")
  if (status.camera) lines.push(`Virtual camera: on (${status.camera.device}, “${CAMERA_LABEL}”)`)
  if (status.recording) lines.push(`Recording: ${status.recording.file} (since ${new Date(status.recording.startedAt).toISOString()})`)
  lines.push(status.apps.length ? `Apps (${status.apps.length}): ${status.apps.map((app) => `${app.command} (pid ${app.pid})`).join(", ")}` : "Apps: none")
  lines.push(status.lastFrameAt ? `Last frame: ${new Date(status.lastFrameAt).toISOString()}${status.framePath ? ` (${status.framePath})` : ""}` : "Last frame: none yet (screenshot or show takes one)")
  lines.push(status.streamPort ? `Live: http://${streamHost}:${status.streamPort}/ (started ${status.streamStartedAt ? new Date(status.streamStartedAt).toISOString() : "just now"})` : "Live: off (stream starts it on this machine only)")
  return lines.join("\n")
}
