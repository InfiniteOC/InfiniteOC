// InfiniteOC safety gates: protected paths, command allow/ask lists, secret scan, /readonly, diff
// budget, commit conventions and user hooks. Written to packages/core/src/plugin/infiniteoc-safety.ts
// by mods/safe-guard. Everything above the Plugin definition is pure (or reads files) and is unit
// tested by mods/safe-guard/test.mjs.
// Settings live in the `safety` key of the InfiniteOC settings file (INFINITEOC_SETTINGS_FILE or
// ~/.config/infiniteoc/settings.json). A project file .infiniteoc/safety.json may only tighten
// (protectedPaths, ask): a checked-in repo must never grant commands or run hooks on its own.
import { define } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { TuiEvent } from "@opencode/schema/tui-event"
import type { Session } from "@opencode/schema/session"
import { Effect, Stream } from "effect"
import { execFileSync, spawn } from "child_process"
import { readFileSync } from "fs"
import { homedir } from "os"
import path from "path"
import { Bus } from "../bus.js"

export type Config = {
  protectedPaths: string[]
  allow: string[]
  ask: string[]
  secretScan: boolean
  diffBudget: { files: number; lines: number }
  hooks: Record<string, string[]>
  autoCommit: boolean
  commitCheck: boolean
}

export const DEFAULT_PROTECTED = [
  ".env*",
  "*.lock",
  "package-lock.json",
  "bun.lockb",
  "go.sum",
  "migrations/",
]

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [])
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const count = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback)

/** Pure: effective config from the global `safety` block, its per-project block and the project's tightening-only file. */
export function mergeConfig(global: unknown, projectDir: string, projectFile: unknown): Config {
  const base = record(global)
  const own = record(record(base.projects)[projectDir])
  const pick = (key: string) => (key in own ? own[key] : base[key])
  const file = record(projectFile)
  const budget = record(pick("diffBudget"))
  return {
    protectedPaths: [...new Set([...(Array.isArray(pick("protectedPaths")) ? strings(pick("protectedPaths")) : DEFAULT_PROTECTED), ...strings(file.protectedPaths)])],
    allow: [...strings(base.allow), ...strings(own.allow)],
    ask: [...strings(base.ask), ...strings(own.ask), ...strings(file.ask)],
    secretScan: pick("secretScan") !== false,
    diffBudget: { files: count(budget.files, 15), lines: count(budget.lines, 500) },
    hooks: Object.fromEntries(Object.entries(record(pick("hooks"))).map(([name, value]) => [name, strings(typeof value === "string" ? [value] : value)])),
    autoCommit: pick("autoCommit") === true,
    commitCheck: pick("commitCheck") !== false,
  }
}

const settingsPath = () => process.env.INFINITEOC_SETTINGS_FILE || path.join(homedir(), ".config/infiniteoc/settings.json")
const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

/** Read on every use: small files, and edits apply to the running server without a restart. */
export const loadConfig = (projectDir: string): Config =>
  mergeConfig(record(readJson(settingsPath())).safety, projectDir, readJson(path.join(projectDir, ".infiniteoc/safety.json")))

// --- matching -------------------------------------------------------------------------------

const escapeRe = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&")

/** Path glob: * stays inside a segment, ** crosses them. */
export const pathRegExp = (pattern: string) =>
  new RegExp("^" + escapeRe(pattern).replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*").replace(/\?/g, "[^/]") + "$")

/** Command glob (like permission rules): * matches anything, a trailing " *" also matches the bare command. */
export function commandMatch(command: string, pattern: string) {
  let source = escapeRe(pattern).replace(/\*/g, ".*").replace(/\?/g, ".")
  if (source.endsWith(" .*")) source = source.slice(0, -3) + "( .*)?"
  return new RegExp("^" + source + "$", "s").test(command.trim())
}

/** "dir/" matches anywhere in the path, a bare glob matches the file name, a glob with / the whole path. */
export function isProtected(file: string, patterns: ReadonlyArray<string>) {
  const rel = file.replaceAll("\\", "/").replace(/^\.\//, "")
  const base = rel.split("/").at(-1) ?? rel
  return patterns.some((pattern) => {
    if (pattern.endsWith("/")) return rel.startsWith(pattern) || rel.includes("/" + pattern)
    return pathRegExp(pattern).test(pattern.includes("/") ? rel : base)
  })
}

const WRITES = /(>|\btee\b|\bsed\s+-\w*i|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bdd\b)/
/** A shell command that writes to a protected path (redirect, tee, rm, mv, cp, sed -i). */
export const shellTouchesProtected = (command: string, patterns: ReadonlyArray<string>) =>
  WRITES.test(command) && command.split(/[\s=<>|;&]+/).some((token) => token.length > 0 && isProtected(token.replace(/^["']|["']$/g, ""), patterns))

export const DANGEROUS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brm\s+(-\w*[rR]\w*|--recursive)\b/, "recursive delete"],
  [/\bgit\s+push\b/, "git push publishes commits"],
  [/\bgit\s+reset\s+--hard\b/, "git reset --hard discards work"],
  [/\bgit\s+clean\b[^|;&]*\s-\w*[fdx]/, "git clean deletes untracked files"],
  [/\bgit\s+(checkout|restore)\b[^|;&]*\s\.(\s|$)/, "discards all working tree changes"],
  [/\bgit\s+branch\b[^|;&]*\s-D\b/, "force-deletes a branch"],
  [/\bgit\s+(stash\s+(drop|clear)|(rebase|merge)(?![\w-])|filter-branch|reflog\s+expire|commit\b[^|;&]*--amend)/, "rewrites or merges history"],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, "destructive SQL"],
  [/\bsudo\b|\bmkfs\b|\bdd\b[^|;&]*\bof=|\bchmod\s+-R\b|\bchown\s+-R\b/, "privileged or bulk system change"],
  [/\|\s*(sudo\s+)?(ba|z)?sh\b/, "pipes a download into a shell"],
  [/\bgh\s+(pr\s+(create|merge|close|comment|review|edit)|issue\s+(create|comment|close|edit)|release|repo\s+(delete|create))\b/, "publishes to GitHub"],
  [/\b(npm|pnpm|yarn|cargo)\s+publish\b|\bdocker\s+system\s+prune\b|\bkubectl\s+delete\b/, "publishes or deletes remote resources"],
]

/** Why a command must always be confirmed, or undefined. User `ask` globs add to the built-in list. */
export function dangerous(command: string, extra: ReadonlyArray<string> = []): string | undefined {
  const hit = DANGEROUS.find(([pattern]) => pattern.test(command))
  if (hit) return hit[1]
  return extra.some((pattern) => commandMatch(command, pattern)) ? "listed in your ask commands" : undefined
}

// --- secrets --------------------------------------------------------------------------------

const SECRETS: ReadonlyArray<readonly [string, RegExp]> = [
  ["private key block", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Anthropic or OpenAI key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe secret key", /\b[sr]k_live_[0-9A-Za-z]{20,}\b/],
  ["credential assignment", /\b(?:api[_-]?key|secret|token|passw(?:or)?d|auth)\w*["']?\s*[:=]\s*["'][A-Za-z0-9/+_=.-]{20,}["']/i],
]
const PLACEHOLDER = /example|placeholder|your[_-]|xxxx|<[^>]+>|\{env:|\$\{|process\.env|changeme|dummy|fake|test[_-]?key|infiniteoc:allow-secret/i

/** Pure: likely secrets in text (1-based lines). Placeholders and lines marked `infiniteoc:allow-secret` pass. */
export function findSecrets(text: string): Array<{ name: string; line: number }> {
  const found: Array<{ name: string; line: number }> = []
  text.split("\n").forEach((line, index) => {
    if (PLACEHOLDER.test(line)) return
    const hit = SECRETS.find(([, pattern]) => pattern.test(line))
    if (hit) found.push({ name: hit[0], line: index + 1 })
  })
  return found
}

// --- tool inputs ----------------------------------------------------------------------------

export const EDIT_TOOLS = new Set(["edit", "write", "patch"])

/** Files an edit, write or patch call would create or change. */
export function targets(tool: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return []
  const value = input as { path?: unknown; patchText?: unknown }
  if ((tool === "edit" || tool === "write") && typeof value.path === "string") return [value.path]
  if (tool === "patch" && typeof value.patchText === "string")
    return [...value.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((match) => (match[1] ?? match[2]).trim())
  return []
}

/** The text a call would write: the whole file, the replacement, or a patch's added lines. */
export function written(tool: string, input: unknown): string {
  const value = (input ?? {}) as { content?: unknown; newString?: unknown; patchText?: unknown }
  if (tool === "write" && typeof value.content === "string") return value.content
  if (tool === "edit" && typeof value.newString === "string") return value.newString
  if (tool === "patch" && typeof value.patchText === "string")
    return value.patchText.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n")
  return ""
}

const lineCount = (text: unknown) => (typeof text === "string" && text.length > 0 ? text.split("\n").length : 0)

/** Pure: changed-line estimate of one edit, write or patch call (removed plus added lines). */
export function changedLines(tool: string, input: unknown): number {
  const value = (input ?? {}) as { content?: unknown; oldString?: unknown; newString?: unknown; patchText?: unknown }
  if (tool === "write") return lineCount(value.content)
  if (tool === "edit") return lineCount(value.oldString) + lineCount(value.newString)
  if (tool === "patch" && typeof value.patchText === "string")
    return value.patchText.split("\n").filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)).length
  return 0
}

/** Pure: lines an edit adds to the diff budget. Creating a new file is not widening a change to existing code, so it counts as a file only. */
export function budgetLines(tool: string, input: unknown, result: unknown): number {
  const created = tool === "write" && (result as { output?: { existed?: unknown } } | undefined)?.output?.existed === false
  return created ? 0 : changedLines(tool, input)
}

// --- readonly -------------------------------------------------------------------------------

const READ_COMMANDS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "egrep", "rg", "pwd", "echo", "printf", "which", "stat", "file", "du", "df", "date", "whoami", "uname", "sort", "uniq", "diff", "cmp", "tree", "realpath", "dirname", "basename", "cut", "tr", "nl", "id", "hostname", "fd", "bat", "cd", "true", "false", "test", "[", "env", "printenv", "sed", "find", "git", "gh"])
const READ_GIT = new Set(["status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "ls-tree", "describe", "shortlog", "grep", "cat-file", "rev-list", "merge-base", "name-rev", "show-ref", "diff-tree", "count-objects", "check-ignore", "for-each-ref", "worktree-list", "reflog"])

/** Pure, best effort: true when a shell command can only read. Anything unclear counts as mutating. */
export function isReadOnlyCommand(command: string): boolean {
  if (/\$\(|`|<\(|<<|\beval\b/.test(command)) return false
  const plain = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "Q")
  if (/>/.test(plain.replace(/\d?>&\d|&?>\s*\/dev\/null|\d>\s*\/dev\/null/g, ""))) return false
  return plain.split(/&&|\|\||[;|\n]/).every((segment) => {
    const words = segment.trim().split(/\s+/).filter((word) => !/^[A-Za-z_]\w*=/.test(word))
    const [name, first, second] = words
    if (!name) return true
    if (!READ_COMMANDS.has(name)) return false
    if (name === "sed") return !words.some((word) => /^-\w*i|^--in-place/.test(word))
    if (name === "find") return !words.some((word) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(word))
    if (name === "env") return words.length === 1
    if (name === "git") {
      if (first === "branch" || first === "tag") return words.slice(2).every((word) => /^(-a|-r|-v|-vv|--list|-l|--merged|--no-merged|--contains|--show-current)$/.test(word))
      if (first === "remote") return !second || second === "-v"
      if (first === "stash") return second === "list" || second === "show"
      if (first === "config") return second === "--get" || second === "--list" || second === "-l"
      if (first === "worktree") return second === "list"
      return READ_GIT.has(first ?? "") && !words.some((word) => /^--(output|ext-diff)/.test(word))
    }
    if (name === "gh") return /^(pr|issue)$/.test(first ?? "") && /^(view|diff|list|status|checks)$/.test(second ?? "")
    return true
  })
}

export const readonlyRefusal = (what: string) =>
  `Refused: this session is in /readonly mode, so ${what} is not allowed. Read, search and explain only; tell the user what you would change instead, and that /readonly off lets you edit.`

// --- commit conventions ---------------------------------------------------------------------

const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: \S/

/** Pure: the subject of a `git commit` command (first -m, or the first line of a heredoc message), or undefined. */
export function commitSubject(command: string): string | undefined {
  if (!/\bgit\s+(?:-\S+\s+)*commit\b/.test(command) || /\s--amend\b[^|;&]*--no-edit/.test(command)) return undefined
  const heredoc = /<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\b/.exec(command)
  if (heredoc && /-m\b/.test(command.slice(0, heredoc.index))) return heredoc[2].split("\n").find((line) => line.trim())?.trim()
  const message = /\s(?:-\w*m|--message)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/.exec(command)
  const text = message?.[1] ?? message?.[2] ?? message?.[3]
  return text?.split("\n").find((line) => line.trim())?.trim()
}

/** Pure: does the history use Conventional Commits (at least 60% of recent subjects)? */
export const usesConventional = (subjects: ReadonlyArray<string>) => subjects.length >= 5 && subjects.filter((subject) => CONVENTIONAL.test(subject)).length / subjects.length >= 0.6

/** Pure: refusal text when a commit subject breaks the repo's learned style, else undefined. */
export function commitProblem(subject: string, recent: ReadonlyArray<string>): string | undefined {
  if (usesConventional(recent) && !CONVENTIONAL.test(subject))
    return `Refused: this repository uses Conventional Commits (type(scope): subject) but "${subject}" does not. Recent subjects:\n${recent.slice(0, 5).map((line) => `  ${line}`).join("\n")}\nRetry git commit with a message in that style.`
  return undefined
}

// --- user hooks -----------------------------------------------------------------------------

/** Run user hook commands with the event as JSON on stdin; resolves with the first failure's output. */
export function runHooks(commands: ReadonlyArray<string>, event: unknown, cwd: string, timeoutMs = 30000): Promise<{ ok: boolean; output: string }> {
  const payload = JSON.stringify(event)
  const one = (command: string) =>
    new Promise<{ ok: boolean; output: string }>((resolve) => {
      const child = spawn("sh", ["-c", command], { cwd, env: { ...process.env, INFINITEOC_HOOK_EVENT: String((event as { event?: string }).event ?? "") }, stdio: ["pipe", "pipe", "pipe"] })
      let output = ""
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
      child.stdout.on("data", (chunk) => (output += chunk))
      child.stderr.on("data", (chunk) => (output += chunk))
      child.stdin.on("error", () => {})
      child.stdin.end(payload)
      child.on("error", (error) => resolve({ ok: false, output: String(error) }))
      child.on("close", (code, signal) => {
        clearTimeout(timer)
        resolve({ ok: code === 0, output: (output.trim() || (signal ? `killed by ${signal} after ${timeoutMs / 1000}s` : `exit code ${code}`)).slice(0, 2000) })
      })
    })
  return commands.reduce<Promise<{ ok: boolean; output: string }>>(async (previous, command) => {
    const result = await previous
    return result.ok ? one(command) : result
  }, Promise.resolve({ ok: true, output: "" }))
}

// --- git helpers (sync: tiny commands, run from the project directory) -----------------------

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 })
const gitOk = (cwd: string, ...args: string[]) => {
  try {
    git(cwd, ...args)
    return true
  } catch {
    return false
  }
}

/** True when git would ignore the path (so a secret there never reaches the repository). */
export const isIgnored = (cwd: string, file: string) => gitOk(cwd, "check-ignore", "-q", "--", file)
const recentSubjects = (cwd: string): string[] => {
  try {
    return git(cwd, "log", "-n", "30", "--format=%s").split("\n").filter(Boolean)
  } catch {
    return []
  }
}

export const Plugin = define({
  id: "infiniteoc.safety",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const dir = ctx.location.directory
    const toast = (message: string, variant: "info" | "warning" | "error" = "warning", title = "Safety") =>
      bus.publish(TuiEvent.ToastShow, { title, message, variant, duration: 8000 })

    // Readonly sessions persist in plugin storage so a restart keeps the mode.
    const KEY = "readonly"
    const readonly = new Set<string>(strings(yield* ctx.storage.get(KEY)))
    const turns = new Map<string, { files: Set<string>; lines: number; warned: boolean }>()
    const turnOf = (sessionID: string) => turns.get(sessionID) ?? turns.set(sessionID, { files: new Set(), lines: 0, warned: false }).get(sessionID)!

    // 1 + 2: permission evaluation. A rule that already denies never reaches this hook, and the hook
    // only turns allow into ask (or ask into allow for the user's own allow list), never past a deny.
    // A gated ask always carries its message, even when it was already ask: the TUI's auto-approve
    // (--auto, /yolo) recognizes these messages and leaves the request to the user.
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.sync(() => {
        const config = loadConfig(dir)
        if (event.action === "edit") {
          const hit = event.resources.find((resource) => isProtected(resource, config.protectedPaths))
          if (hit && event.effect !== "deny") {
            event.effect = "ask"
            event.message = `${hit} is a protected path (InfiniteOC safety settings). Confirm to edit it.`
          }
          return
        }
        if (event.action !== "shell") return
        const touched = event.resources.find((resource) => shellTouchesProtected(resource, config.protectedPaths))
        const why = touched ? "writes to a protected path" : event.resources.map((resource) => dangerous(resource, config.ask)).find(Boolean)
        if (why) {
          if (event.effect !== "deny") {
            event.effect = "ask"
            event.message = `Always confirmed by InfiniteOC safety: ${why}.`
          }
          return
        }
        if (event.effect === "ask" && config.allow.length > 0 && event.resources.every((resource) => config.allow.some((pattern) => commandMatch(resource, pattern)))) event.effect = "allow"
      }),
    )

    // 3, 4, 8, 13: gates before a tool runs.
    yield* ctx.tool.hook("execute.before", (event) => {
      const sessionID = event.sessionID as string
      const edits = EDIT_TOOLS.has(event.tool)
      const command = event.tool === "shell" ? String((event.input as { command?: unknown })?.command ?? "") : ""
      if (readonly.has(sessionID)) {
        if (edits) return Effect.fail(new Tool.Error({ message: readonlyRefusal(`${event.tool} (${targets(event.tool, event.input).join(", ") || "files"})`) }))
        if (event.tool === "shell" && !isReadOnlyCommand(command)) return Effect.fail(new Tool.Error({ message: readonlyRefusal("this shell command, which may change files or state,") }))
        const agent = String((event.input as { agent?: unknown })?.agent ?? "")
        if (event.tool === "subagent" && !["explore", "reviewer", "researcher"].includes(agent)) return Effect.fail(new Tool.Error({ message: readonlyRefusal(`the ${agent || "general"} subagent (it can edit)`) }))
      }
      const config = loadConfig(dir)
      if (command && config.commitCheck) {
        const subject = commitSubject(command)
        const problem = subject === undefined ? undefined : commitProblem(subject, recentSubjects(dir))
        if (problem) return Effect.fail(new Tool.Error({ message: problem }))
      }
      if (!edits) return Effect.void
      const files = targets(event.tool, event.input)
      if (config.secretScan) {
        const found = findSecrets(written(event.tool, event.input))
        const tracked = found.length > 0 && files.some((file) => !isIgnored(dir, path.resolve(dir, file)))
        if (tracked)
          return Effect.fail(new Tool.Error({ message: `Refused: ${found.map((item) => `${item.name} (line ${item.line} of the new text)`).join(", ")} looks like a secret and ${files.join(", ")} is not git-ignored. Read it from an environment variable or a git-ignored file instead. If this is a harmless fixture, put "infiniteoc:allow-secret" on that line.` }))
      }
      const hooks = config.hooks["before-edit"] ?? []
      if (hooks.length === 0) return Effect.void
      return Effect.promise(() => runHooks(hooks, { event: "before-edit", sessionID, tool: event.tool, files, input: event.input }, dir)).pipe(
        Effect.flatMap((result) => (result.ok ? Effect.void : Effect.fail(new Tool.Error({ message: `Blocked by your before-edit hook: ${result.output}` })))),
      )
    })

    // 5, 8: after an edit lands, count it against the turn's budget and run after-edit hooks.
    yield* ctx.tool.hook("execute.after", (event) => {
      if (!EDIT_TOOLS.has(event.tool) || event.status !== "completed") return Effect.void
      const config = loadConfig(dir)
      const turn = turnOf(event.sessionID as string)
      const files = targets(event.tool, event.input)
      files.forEach((file) => turn.files.add(file))
      turn.lines += budgetLines(event.tool, event.input, event.result)
      const hooks = config.hooks["after-edit"] ?? []
      const ran = hooks.length > 0 ? Effect.promise(() => runHooks(hooks, { event: "after-edit", sessionID: event.sessionID, tool: event.tool, files }, dir)).pipe(Effect.asVoid) : Effect.void
      const { files: maxFiles, lines: maxLines } = config.diffBudget
      const over = !turn.warned && ((maxFiles > 0 && turn.files.size > maxFiles) || (maxLines > 0 && turn.lines > maxLines))
      if (!over) return ran
      turn.warned = true
      const note = `[InfiniteOC diff budget] This turn has touched ${turn.files.size} files and about ${turn.lines} changed lines in existing files (budget ${maxFiles} files, ${maxLines} lines). If that is more than the request needs, stop widening the change: finish the current step, summarize what you changed, and ask the user before continuing. If the user asked for this much (a whole feature or a new project), carry on.`
      const content = event.result.content
      event.result = { ...event.result, content: typeof content === "string" ? `${content}\n\n${note}` : [...(content ?? []), { type: "text" as const, text: note }] }
      return ran.pipe(Effect.andThen(toast(`This turn touched ${turn.files.size} files and about ${turn.lines} lines (budget ${maxFiles} files / ${maxLines} lines).`, "warning", "Diff budget")))
    })

    // 8: prompt-submit hooks (cannot block: the prompt hook has no failure channel) and turn reset.
    yield* ctx.session.hook("prompt", (event) => {
      const id = event.sessionID as string
      turns.set(id, { files: new Set(), lines: 0, warned: false })
      const hooks = loadConfig(dir).hooks["prompt-submit"] ?? []
      return hooks.length === 0 ? Effect.void : Effect.promise(() => runHooks(hooks, { event: "prompt-submit", sessionID: id, prompt: event.prompt.text }, dir)).pipe(Effect.asVoid)
    })

    // 8: session-end hooks run when an agent run finishes.
    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        if (event.type !== "session.execution.succeeded" && event.type !== "session.execution.failed" && event.type !== "session.execution.interrupted") return Effect.void
        const hooks = loadConfig(dir).hooks["session-end"] ?? []
        if (hooks.length === 0) return Effect.void
        return Effect.promise(() => runHooks(hooks, { event: "session-end", sessionID: event.data.sessionID, outcome: event.type.split(".").at(-1) }, dir)).pipe(Effect.asVoid)
      }),
      Effect.forkScoped({ startImmediately: true }),
    )

    // 4: /readonly [on|off|status]
    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "readonly",
        description: "refuse every edit and mutating command in this session · /readonly off",
        execute: (input) => {
          const id = input.sessionID as Session.ID
          const arg = input.prompt.text.trim().toLowerCase()
          const next = arg === "on" ? true : arg === "off" ? false : arg === "status" ? readonly.has(id) : !readonly.has(id)
          if (arg !== "status") {
            if (next) readonly.add(id)
            else readonly.delete(id)
          }
          const text = next ? "Readonly mode is ON: edits, writes, patches and mutating shell commands are refused. /readonly off to lift it." : "Readonly mode is OFF: edits are allowed again."
          return ctx.storage.set(KEY, [...readonly]).pipe(
            Effect.andThen(toast(text, next ? "warning" : "info", "Readonly")),
            Effect.andThen(arg === "status" ? Effect.void : ctx.session.synthetic({ sessionID: id, text: `[InfiniteOC readonly: ${next ? "on" : "off"}]\n${text}`, description: text, resume: false })),
            Effect.asVoid,
          )
        },
      })
    })
  }),
})
