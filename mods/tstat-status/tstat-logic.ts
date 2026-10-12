// InfiniteOC tstat: pure helpers for the status and feedback surfaces. No imports on purpose, so
// node:test can load this file directly. Copied to packages/tui/src/feature-plugins/system/ by
// mods/tstat-status.

export type Settings = {
  /** Desktop notification when a run ends, a /goal ends, or something waits for input. */
  notify: boolean
  /** Distinct system sounds for done, error and waiting. */
  sound: boolean
  /** "auto" detects terminals that bundle Nerd Font symbols (or NERD_FONT=1). */
  nerd: "auto" | "on" | "off"
  /** Cap large tool bodies (writes, diffs) to a few lines; click or /expand opens them. */
  compact: boolean
  /** Tokens and budget segment in the prompt footer. */
  meter: boolean
  /** Session cost budget in USD; 0 means none. */
  budget: number
}

export const defaults: Settings = { notify: true, sound: false, nerd: "auto", compact: true, meter: true, budget: 0 }

/** Keep only well-typed saved values so a hand-edited file cannot break the UI. */
export function sanitize(saved: Partial<Record<keyof Settings, unknown>> | undefined): Settings {
  const out = { ...defaults }
  if (!saved) return out
  for (const key of ["notify", "sound", "compact", "meter"] as const) if (typeof saved[key] === "boolean") out[key] = saved[key]
  if (saved.nerd === "auto" || saved.nerd === "on" || saved.nerd === "off") out.nerd = saved.nerd
  if (typeof saved.budget === "number" && Number.isFinite(saved.budget) && saved.budget >= 0) out.budget = saved.budget
  return out
}

export type Focus = "focused" | "blurred" | "unknown"
/** Notify unless the terminal is known to be focused. */
export const shouldNotify = (focus: Focus) => focus !== "focused"

export type Cue = "done" | "error" | "waiting"

/** Command that raises a desktop notification, or undefined on platforms without one. */
export function notifyCommand(platform: string, title: string, message: string) {
  if (platform === "darwin")
    return {
      cmd: "osascript",
      // Title and message travel as argv so quotes in them cannot break out of the script.
      args: ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run", message, title],
    }
  if (platform === "linux") return { cmd: "notify-send", args: ["--app-name=InfiniteOC", title, message] }
}

const MAC_SOUNDS: Record<Cue, string> = {
  done: "/System/Library/Sounds/Glass.aiff",
  error: "/System/Library/Sounds/Basso.aiff",
  waiting: "/System/Library/Sounds/Ping.aiff",
}
const LINUX_SOUNDS: Record<Cue, string> = {
  done: "/usr/share/sounds/freedesktop/stereo/complete.oga",
  error: "/usr/share/sounds/freedesktop/stereo/dialog-error.oga",
  waiting: "/usr/share/sounds/freedesktop/stereo/message.oga",
}

export function soundCommand(platform: string, cue: Cue) {
  if (platform === "darwin") return { cmd: "afplay", args: [MAC_SOUNDS[cue]] }
  if (platform === "linux") return { cmd: "paplay", args: [LINUX_SOUNDS[cue]] }
}

export function formatTokens(count: number) {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}K`
  return `${(count / 1_000_000).toFixed(1)}M`
}

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

/** Tokens a family of sessions has used: prompt side (input plus cache) and generated side. */
export function sumTokens(sessions: ReadonlyArray<{ tokens?: Tokens } | undefined>) {
  let input = 0
  let output = 0
  for (const session of sessions) {
    if (!session?.tokens) continue
    input += session.tokens.input + session.tokens.cache.read + session.tokens.cache.write
    output += session.tokens.output + session.tokens.reasoning
  }
  return { input, output }
}

export type BudgetLevel = "ok" | "warn" | "over"
export function budgetState(cost: number, budget: number) {
  if (!(budget > 0)) return undefined
  const percent = Math.round((cost / budget) * 100)
  return { percent, level: (percent >= 100 ? "over" : percent >= 80 ? "warn" : "ok") as BudgetLevel }
}

/** Subagent fan-out: how many children exist, are running, and have finished. */
export function fanout(statuses: ReadonlyArray<"idle" | "running">) {
  const running = statuses.filter((status) => status === "running").length
  return { total: statuses.length, running, done: statuses.length - running }
}

export function progressBar(done: number, total: number, width = 8) {
  if (total <= 0) return ""
  const filled = Math.min(width, Math.round((done / total) * width))
  return "▰".repeat(filled) + "▱".repeat(width - filled)
}

export function relativeTime(ms: number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - ms) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Parses `git status --porcelain=v1 --branch`. */
export function parseGitStatus(output: string) {
  const lines = output.split("\n").filter(Boolean)
  const head = lines.find((line) => line.startsWith("## ")) ?? ""
  const branch = head.slice(3).split("...")[0].split(" ")[0] || "HEAD"
  const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0)
  let staged = 0
  let changed = 0
  let untracked = 0
  for (const line of lines) {
    if (line.startsWith("## ")) continue
    if (line.startsWith("??")) untracked++
    else {
      if (line[0] !== " ") staged++
      if (line[1] !== " ") changed++
    }
  }
  return { branch, ahead, behind, staged, changed, untracked, clean: staged + changed + untracked === 0 }
}

/** Identifies what "allow for this session" covers: the action plus the patterns "always" would save. */
export function permissionKey(request: { action: string; resources: readonly string[]; save?: readonly string[] }) {
  return `${request.action}\u0000${(request.save?.length ? request.save : request.resources).join("\u0001")}`
}

export type Icons = Record<"ok" | "error" | "waiting" | "branch" | "dirty" | "session" | "update" | "agent", string>
const PLAIN: Icons = { ok: "ok", error: "x", waiting: "!", branch: "branch", dirty: "*", session: "-", update: "update", agent: "agents" }
const NERD: Icons = {
  ok: "",
  error: "",
  waiting: "",
  branch: "",
  dirty: "",
  session: "",
  update: "",
  agent: "",
}

export function nerdEnabled(setting: Settings["nerd"], env: Record<string, string | undefined>) {
  if (setting !== "auto") return setting === "on"
  if (env.NERD_FONT === "1" || env.INFINITEOC_NERD_FONT === "1") return true
  // These terminals ship a Nerd Font symbols fallback.
  return env.TERM === "xterm-kitty" || env.TERM_PROGRAM === "WezTerm" || env.TERM_PROGRAM === "ghostty"
}
export const iconsFor = (nerd: boolean): Icons => (nerd ? NERD : PLAIN)

/** Light or dark from a terminal background such as "#fdf6e3". */
export function modeFromBackground(hex: string | undefined) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? "")
  if (!match) return undefined
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => parseInt(part, 16) / 255)
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? ("light" as const) : ("dark" as const)
}
