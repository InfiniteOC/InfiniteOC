// session-import lib: discover and convert foreign harness sessions
// (Claude Code JSONL, Antigravity CLI transcript JSONL) into normalized turns
// and InfiniteOC session-import payloads. Node built-ins only, no sqlite here
// (summaries live in summaries.mjs, used by the CLI only), so the TUI command
// can reuse this file directly. Read-only against foreign data: never writes
// outside the payload it returns.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

export const MAX_SCAN_BYTES = 50 * 1024 * 1024
export const MAX_IMPORT_CHARS = 60_000
export const MAX_THINKING_CHARS = 1000
export const MAX_TOOL_CHARS = 1000

const homeDir = (home) => home ?? homedir()
export const claudeDir = (home) => path.join(homeDir(home), ".claude", "projects")
export const antigravityDir = (home) => path.join(homeDir(home), ".gemini", "antigravity-cli")

const safeStat = (file) => {
  try {
    return statSync(file)
  } catch {
    return undefined
  }
}

const listDirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

const listFiles = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return []
  }
}

/** First user text, turn counts and time range of a Claude Code .jsonl file. */
export function summarizeClaudeFile(file) {
  const stat = safeStat(file)
  if (!stat || stat.size > MAX_SCAN_BYTES) return undefined
  let raw
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  let user = 0
  let assistant = 0
  let firstText
  let firstTime
  let lastTime
  let cwd
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.cwd && !cwd) cwd = entry.cwd
    if (entry.timestamp) {
      const ms = Date.parse(entry.timestamp)
      if (Number.isFinite(ms)) {
        if (firstTime === undefined || ms < firstTime) firstTime = ms
        if (lastTime === undefined || ms > lastTime) lastTime = ms
      }
    }
    if (entry.type === "user" && !entry.isSidechain) {
      user++
      if (firstText === undefined) firstText = claudeText(entry.message?.content)
    } else if (entry.type === "assistant" && !entry.isSidechain) {
      assistant++
    }
  }
  if (!user && !assistant) return undefined
  return {
    id: path.basename(file, ".jsonl"),
    file,
    title: (firstText ?? "untitled").slice(0, 80),
    userTurns: user,
    assistantTurns: assistant,
    cwd,
    firstTime,
    lastTime,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}

export function listClaudeSessions(home) {
  const base = claudeDir(home)
  const out = []
  for (const project of listDirs(base)) {
    for (const name of listFiles(path.join(base, project))) {
      if (!name.endsWith(".jsonl") || name.startsWith("agent-")) continue // main sessions only, not subagent forks
      const summary = summarizeClaudeFile(path.join(base, project, name))
      if (summary) out.push({ harness: "claude", project, ...summary })
    }
  }
  return out.sort((a, b) => (b.lastTime ?? b.mtimeMs) - (a.lastTime ?? a.mtimeMs))
}

/** Text of Claude content blocks; tool/image blocks become short markers. */
export function claudeText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text)
    else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim())
      parts.push(`[reasoning: ${block.thinking.slice(0, MAX_THINKING_CHARS)}]`)
    else if (block.type === "tool_use")
      parts.push(`[used ${block.name ?? "a tool"}${block.input ? `: ${JSON.stringify(block.input).slice(0, MAX_TOOL_CHARS)}` : ""}]`)
    else if (block.type === "tool_result")
      parts.push(`[tool result: ${claudeText(block.content).slice(0, MAX_TOOL_CHARS)}]`)
    else if (block.type === "image") parts.push("[image omitted]")
  }
  return parts.join("\n\n")
}

/** Full Claude Code session to normalized turns (oldest first). */
export function readClaudeSession(file) {
  const stat = safeStat(file)
  if (!stat) throw new Error(`Claude session not found: ${file}`)
  if (stat.size > MAX_SCAN_BYTES) throw new Error(`Claude session too large (${(stat.size / 1048576).toFixed(0)}MB > 50MB)`)
  const turns = []
  let cwd
  let requestedModel
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.cwd && !cwd) cwd = entry.cwd
    if (entry.type === "user" && !entry.isSidechain) {
      const text = claudeText(entry.message?.content).trim()
      if (text) turns.push({ role: "user", text, time: timeMs(entry.timestamp) })
    } else if (entry.type === "assistant" && !entry.isSidechain) {
      const text = claudeText(entry.message?.content).trim()
      if (text) {
        const model = typeof entry.message?.model === "string" ? entry.message.model : entry.requestedModel
        if (typeof model === "string" && !requestedModel) requestedModel = model
        turns.push({ role: "assistant", text, model: typeof model === "string" ? model : undefined, time: timeMs(entry.timestamp) })
      }
    }
  }
  return { turns, cwd, requestedModel }
}

/** Antigravity sessions: transcript.jsonl under brain/<id>, newest first. */
export function listAntigravitySessions(home) {
  const base = antigravityDir(home)
  const brain = path.join(base, "brain")
  const out = []
  for (const id of listDirs(brain)) {
    const transcript = path.join(brain, id, ".system_generated", "logs", "transcript.jsonl")
    const stat = safeStat(transcript)
    if (!stat) continue
    let user = 0
    let assistant = 0
    try {
      for (const line of readFileSync(transcript, "utf8").split("\n")) {
        if (!line.trim()) continue
        const entry = JSON.parse(line)
        if (entry.source === "USER_EXPLICIT") user++
        else if (entry.source === "MODEL") assistant++
      }
    } catch {
      continue
    }
    out.push({ harness: "antigravity", id, file: transcript, title: id, userTurns: user, assistantTurns: assistant, mtimeMs: stat.mtimeMs, bytes: stat.size })
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

const unwrapUserRequest = (content) => {
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(String(content ?? ""))
  return (match ? match[1] : String(content ?? "")).trim()
}

const settingsModel = (content) => {
  const match = /`Model Selection` from .*? to `([^`]+)`/.exec(String(content ?? ""))
  return match ? match[1] : undefined
}

/** Antigravity transcript.jsonl to normalized turns (step order). */
export function readAntigravitySession(file) {
  const stat = safeStat(file)
  if (!stat) throw new Error(`Antigravity transcript not found: ${file}`)
  if (stat.size > MAX_SCAN_BYTES) throw new Error("Antigravity transcript too large (> 50MB)")
  const turns = []
  let model
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.status && entry.status !== "DONE") continue
    const time = timeMs(entry.created_at)
    if (entry.source === "USER_EXPLICIT") {
      const text = unwrapUserRequest(entry.content)
      if (!text) continue
      turns.push({ role: "user", text, time })
      const pinned = settingsModel(entry.content)
      if (pinned && !model) model = pinned
    } else if (entry.source === "MODEL") {
      const parts = []
      if (typeof entry.content === "string" && entry.content.trim()) parts.push(entry.content.trim())
      if (typeof entry.thinking === "string" && entry.thinking.trim())
        parts.push(`[reasoning: ${entry.thinking.slice(0, MAX_THINKING_CHARS)}]`)
      for (const call of Array.isArray(entry.tool_calls) ? entry.tool_calls : [])
        parts.push(`[used ${call?.name ?? "a tool"}${call?.arguments ? `: ${JSON.stringify(call.arguments).slice(0, MAX_TOOL_CHARS)}` : ""}]`)
      if (parts.length) turns.push({ role: "assistant", text: parts.join("\n\n"), model, time })
    } else if (entry.source === "SYSTEM" && entry.type === "SYSTEM_MESSAGE" && typeof entry.content === "string" && entry.content.trim()) {
      turns.push({ role: "system", text: entry.content.trim(), time })
    }
    // CONVERSATION_HISTORY (null content), EPHEMERAL_MESSAGE and unknown
    // future step types are intentionally dropped: they are compaction input
    // or transient notices, not conversation to continue.
  }
  return { turns, model }
}

const timeMs = (value) => {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

const hexId = (prefix) => `${prefix}${randomUUID().replace(/-/g, "")}`

/**
 * Normalized turns to a session-import payload ({info, messages}).
 * Assistant turns become synthetic messages (no fabricated model refs);
 * the whole import is capped and the cap is disclosed in the transcript.
 */
export function toImportPayload(turns, { harness, sourceId, title, directory }) {
  const usable = turns.filter((t) => (t.role === "user" || t.role === "assistant") && t.text?.trim())
  if (!usable.length) throw new Error("Nothing importable: no user or assistant turns found")
  const now = Date.now()
  const created = usable.find((t) => t.time)?.time ?? now
  const messages = []
  let chars = 0
  let truncated = false
  for (const turn of usable) {
    const text = turn.role === "user" ? turn.text : `Originally from ${harness}${turn.model ? ` (${turn.model})` : ""}:\n\n${turn.text}`
    if (chars + text.length > MAX_IMPORT_CHARS) {
      truncated = true
      break
    }
    chars += text.length
    messages.push(
      turn.role === "user"
        ? { id: hexId("msg_"), time: { created: turn.time ?? now }, text, type: "user" }
        : {
            id: hexId("msg_"),
            time: { created: turn.time ?? now },
            text,
            description: `imported from ${harness} session ${sourceId}`,
            type: "synthetic",
          },
    )
  }
  if (truncated)
    messages.push({
      id: hexId("msg_"),
      time: { created: now },
      text: `[import note: the source session continues beyond ${MAX_IMPORT_CHARS} characters; the remainder was not imported]`,
      description: "import truncation note",
      type: "synthetic",
    })
  if (!messages.length) throw new Error("Nothing importable within the size cap")
  return {
    info: {
      id: hexId("ses_"),
      projectID: "global",
      title: title ?? `imported from ${harness} ${sourceId}`,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, updated: now },
      location: { directory },
    },
    messages,
  }
}
