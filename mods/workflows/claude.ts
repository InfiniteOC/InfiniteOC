// InfiniteOC workflows: steps that run on the user's logged-in Claude Code CLI (`claude -p`).
// workflows.claudeMode picks what a worker may do: readonly (search, read, web), auto (all tools,
// Claude Code's classifier blocks risky actions, nothing asks) or bypass (all tools, no checks).
// Pure helpers (argv, environment, stream-json parsing); the plugin spawns the process.
// Written to packages/core/src/plugin/infiniteoc-wf-claude.ts by mods/workflows.
import { createHash } from "node:crypto"
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

/**
 * A chat turn of the Claude Code model picker entries (claude-code.ts). Claude Code runs as itself: its own
 * system prompt, tools and login; InfiniteOC passes neither its prompt nor its tools. Chats keep their
 * Claude Code session (`--resume`). Tool lists are variadic, so they stay last; the prompt goes on stdin.
 */
export const chatArgs = (model: string, mode: Mode, run: { resume?: string; effort?: string }) => [
  "-p",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--model", model,
  ...(run.effort ? ["--effort", run.effort] : []),
  ...(run.resume ? ["--resume", run.resume] : []),
  "--strict-mcp-config",
  "--setting-sources", "project,local",
  ...(mode === "readonly"
    ? ["--tools", ...TOOLS]
    : ["--permission-mode", mode === "auto" ? "auto" : "bypassPermissions", "--permission-prompts", "none"]),
]

/** A session title made locally from the newest user message's first line (at most 50 characters). */
export const titleOf = (messages: readonly Message[]) => {
  const line = textOf([...messages].reverse().find((m) => m.role === "user") ?? { role: "user", content: "" }).trim().split("\n")[0] ?? ""
  return oneLine(line, 50) || "Claude Code"
}

type Message = { role: string; content: unknown }

/** A message's text parts (files and tool parts left out). */
export const textOf = (message: Message) =>
  typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
      : ""

const fingerprint = (texts: string[]) => createHash("sha256").update(JSON.stringify(texts)).digest("hex").slice(0, 24)

/** The Claude Code session behind an InfiniteOC session, and which user messages it has seen. */
export type Chat = { claude: string; users: string }

/**
 * What a chat turn sends. When the stored Claude Code session has seen every earlier user message, it is
 * resumed with the newest one ("Continue." when there is none). Otherwise (first turn, rewind, fork,
 * compaction, turns by another model) a new session gets the conversation so far as text.
 */
export function chatInput(messages: readonly Message[], prior?: Chat) {
  const users = messages.filter((m) => m.role === "user").map(textOf)
  const seen = fingerprint(users)
  const last = messages.at(-1)
  if (prior?.users === seen) return { resume: prior.claude, text: "Continue.", users: seen }
  if (prior && last?.role === "user" && prior.users === fingerprint(users.slice(0, -1))) return { resume: prior.claude, text: textOf(last), users: seen }
  return { text: transcript(messages), users: seen }
}

/** The conversation as one prompt, for a new Claude Code session. */
export function transcript(messages: readonly Message[]) {
  const turns = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, text: textOf(m).trim() }))
    .filter((t) => t.text)
  const ask = turns.at(-1)?.role === "user" ? turns.pop()!.text : "Continue."
  if (turns.length === 0) return ask
  return `[The conversation so far]\n\n${turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n")}\n\n[The new message]\n${ask}`
}

/** The finish part, with the newest call's input (the context size) and the run's output tokens. */
export const finish = (raw = "stop", input = { input: 0, cacheRead: 0, cacheWrite: 0 }, output?: number) => ({
  type: "finish" as const,
  finishReason: { unified: "stop" as const, raw },
  usage: {
    inputTokens: { total: input.input + input.cacheRead + input.cacheWrite, noCache: input.input, cacheRead: input.cacheRead, cacheWrite: input.cacheWrite },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  },
})

/** Claude Code tool names as InfiniTUI renders them (it reads snake_case inputs too). */
export const toolName = (name: string) => (name === "Agent" ? "task" : name.toLowerCase())

export type Stream = { message: number; open: Map<string, "text" | "reasoning">; names: Record<string, string>; session?: string; input?: { input: number; cacheRead: number; cacheWrite: number }; done?: boolean }
export const stream = (): Stream => ({ message: 0, open: new Map(), names: {} })

const resultText = (content: unknown) => {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part?.type === "text" ? part.text : "")).join("\n") : ""
  return text.length > 20_000 ? text.slice(0, 20_000) + "\n…" : text
}

/**
 * One stream-json event as AI SDK stream parts: text and thinking deltas, Claude Code's own tool calls and
 * results (provider-executed: InfiniteOC shows them and never runs them), and the finish with usage.
 * Events of Claude Code's own subagents (parent_tool_use_id) stay inside their task.
 */
export function toParts(event: any, state: Stream): any[] {
  if (event?.type === "system" && event.subtype === "init") {
    state.session = event.session_id
    return []
  }
  if (!event || event.parent_tool_use_id) return []
  if (event.type === "stream_event") {
    const e = event.event ?? {}
    if (e.type === "message_start") {
      state.message++
      const u = e.message?.usage
      if (u) state.input = { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 }
      return []
    }
    const id = `${state.message}:${e.index}`
    if (e.type === "content_block_start") {
      const kind = e.content_block?.type === "text" ? "text" : e.content_block?.type === "thinking" ? "reasoning" : undefined
      if (!kind) return []
      state.open.set(id, kind)
      return [{ type: `${kind}-start`, id }]
    }
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta") return [{ type: "text-delta", id, delta: e.delta.text }]
    if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta") return [{ type: "reasoning-delta", id, delta: e.delta.thinking }]
    if (e.type === "content_block_stop" && state.open.has(id)) {
      const kind = state.open.get(id)
      state.open.delete(id)
      return [{ type: `${kind}-end`, id }]
    }
    return []
  }
  const blocks: any[] = Array.isArray(event.message?.content) ? event.message.content : []
  if (event.type === "assistant")
    return blocks
      .filter((b) => b?.type === "tool_use")
      .map((b) => {
        state.names[b.id] = toolName(String(b.name))
        return { type: "tool-call", toolCallId: b.id, toolName: state.names[b.id], input: JSON.stringify(b.input ?? {}), providerExecuted: true }
      })
  if (event.type === "user")
    return blocks
      .filter((b) => b?.type === "tool_result")
      .map((b) => ({ type: "tool-result", toolCallId: b.tool_use_id, toolName: state.names[b.tool_use_id] ?? "tool", result: resultText(b.content), isError: b.is_error === true }))
  if (event.type !== "result") return []
  state.done = true
  if (event.is_error || event.subtype !== "success") return [{ type: "error", error: new Error(String(event.result || event.subtype || "Claude Code failed")) }]
  return [finish(event.subtype, state.input, event.usage?.output_tokens)]
}

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
