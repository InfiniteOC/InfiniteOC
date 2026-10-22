// InfiniteOC workflows: steps that run on the user's logged-in Claude Code CLI (`claude -p`).
// workflows.claudeMode picks what a worker may do: readonly (search, read, web), auto (all tools,
// Claude Code's classifier blocks risky actions, nothing asks) or bypass (all tools, no checks).
// Pure helpers (argv, environment, stream-json parsing); the plugin spawns the process.
// Written to packages/core/src/plugin/infiniteoc-wf-claude.ts by mods/workflows.
import { existsSync } from "node:fs"
import path from "node:path"

export const PROVIDER = "claude-code"
export const MODELS = ["haiku", "sonnet", "opus"]
export const TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"]

export const isClaude = (model: string | undefined) => model?.startsWith(`${PROVIDER}/`) === true

/** The claude binary on PATH, or undefined. */
export function findBinary(pathVar = process.env.PATH ?? "") {
  for (const dir of pathVar.split(path.delimiter).filter(Boolean))
    for (const name of process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"]) {
      const file = path.join(dir, name)
      if (existsSync(file)) return file
    }
}

/**
 * How to spawn the binary: an npm install on Windows is a claude.cmd shim, which only runs through cmd.exe (Node
 * refuses to spawn it without a shell). The arguments from args() are plain tokens, so only the path is quoted.
 */
export const command = (bin: string) => (/\.cmd$/i.test(bin) ? { file: `"${bin}"`, shell: true } : { file: bin, shell: false })

export type Mode = "readonly" | "auto" | "bypass"

/**
 * Headless and lean: no MCP servers and no user-level hooks or plugins (with them a one-line task
 * cost ~465k cache tokens instead of ~16k), no saved session. Editing modes keep Claude Code from
 * spawning its own (slow) subagents: the workflow is the parallelism. The prompt goes on stdin
 * because --tools / --disallowedTools take every argument after them.
 */
export const args = (model: string, mode: Mode = "readonly") => [
  "-p",
  "--output-format", "stream-json",
  "--verbose",
  "--model", model,
  "--no-session-persistence",
  "--strict-mcp-config",
  "--setting-sources", "project,local",
  ...(mode === "readonly"
    ? ["--tools", ...TOOLS]
    : ["--permission-mode", mode === "auto" ? "auto" : "bypassPermissions", "--permission-prompts", "none", "--disallowedTools", "Task", "Agent"]),
]

/** The server's environment minus API credentials, so the CLI uses the user's own login. */
export function env(source: Record<string, string | undefined>) {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(source))
    if (value !== undefined && !["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDECODE"].includes(key)) out[key] = value
  return out
}

export const preamble = (mode: Mode = "readonly") =>
  mode === "readonly"
    ? "You are a read-only worker: you can search, read files and the web, but cannot edit files or run commands. Do not ask questions; finish with the complete answer as your final message."
    : "You are a worker in a team running in parallel: change only the files your task owns. Do not ask questions; finish with a short report of what you did and checked as your final message."

/** What a running step is doing, for the TUI. */
export type Activity = { tool?: string; detail?: string; tools: number; text?: string }

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}

/** A short label for a tool call's input: its path, pattern, query, URL or command. */
export function describe(input: unknown) {
  if (!input || typeof input !== "object") return undefined
  const value = input as Record<string, unknown>
  for (const key of ["file_path", "filePath", "path", "pattern", "query", "url", "command", "description", "prompt"])
    if (typeof value[key] === "string" && value[key]) return oneLine(value[key] as string, 80)
}

/**
 * One stream-json line: updates `activity` and returns the outcome when the line is the final
 * result. Lines that are not JSON or not interesting return undefined.
 */
export function parse(line: string, activity: Activity): { result: string } | { error: string } | undefined {
  let event: any
  try {
    event = JSON.parse(line)
  } catch {
    return
  }
  if (event?.type === "assistant" && Array.isArray(event.message?.content))
    for (const block of event.message.content) {
      if (block?.type === "tool_use") {
        activity.tools++
        activity.tool = String(block.name ?? "tool")
        activity.detail = describe(block.input)
      } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) activity.text = oneLine(block.text, 160)
    }
  if (event?.type === "result") {
    if (event.is_error || event.subtype !== "success") return { error: String(event.result || event.subtype || "Claude Code failed") }
    return { result: String(event.result ?? "") }
  }
}
