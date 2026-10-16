// InfiniteOC context store: per-project memory, glossary, per-session pins, config and the /context snapshot.
// Pure node module (no upstream imports) shared by the core plugin and the TUI commands; mods/ctx-context
// writes it to packages/core/src/plugin/infiniteoc-ctx-store.ts and packages/tui/src/infiniteoc-features/ctx-store.ts.
// Everything lives under $XDG_DATA_HOME/infiniteoc/ctx, never in the repository.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const dataRoot = () => path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "infiniteoc", "ctx")

/** Nearest ancestor holding .git (a file in worktrees); the start directory when there is none. */
export function projectRoot(start: string) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return dir
    if (path.dirname(dir) === dir) return path.resolve(start)
  }
}

export const projectDir = (root: string) => path.join(dataRoot(), "projects", `${path.basename(root)}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`)

const MAX_ITEM = 400
const MAX_ITEMS = 100
export const MAX_PIN_BYTES = 64 * 1024
const MAX_PINS_TOTAL = 160 * 1024

const tidy = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM)

function save(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, file)
}

const readLines = (file: string) => {
  try {
    return readFileSync(file, "utf8").split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim()).filter(Boolean)
  } catch {
    return []
  }
}
const writeLines = (file: string, items: string[]) => save(file, items.map((item) => `- ${item}`).join("\n") + (items.length ? "\n" : ""))

// A recognizable credential is never stored: memory is injected into every prompt.
const SECRET = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,})/
export const looksSecret = (text: string) => SECRET.test(text) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)

// Memory and glossary share one shape: a markdown bullet list, one single-line item per entry.
export const memoryFile = (root: string) => path.join(projectDir(root), "memory.md")
export const glossaryFile = (root: string) => path.join(projectDir(root), "glossary.md")
export const listItems = readLines

export function addItem(file: string, text: string, key = (item: string) => item.toLowerCase()) {
  const item = tidy(text)
  if (!item) throw new Error("Nothing to save: the text is empty.")
  if (looksSecret(item)) throw new Error("Refused: that looks like a credential. Secrets are never stored.")
  const items = readLines(file)
  const same = items.findIndex((existing) => key(existing) === key(item))
  if (same >= 0) {
    items[same] = item
  } else {
    if (items.length >= MAX_ITEMS) throw new Error(`Full: ${MAX_ITEMS} entries. Remove or edit some first.`)
    items.push(item)
  }
  writeLines(file, items)
  return { items, replaced: same >= 0 }
}

/** Removes by 1-based position or by a unique case-insensitive substring. */
export function removeItem(file: string, which: string | number) {
  const items = readLines(file)
  const index = typeof which === "number" || /^\d+$/.test(which) ? Number(which) - 1 : items.findIndex((item) => item.toLowerCase().includes(String(which).toLowerCase()))
  if (!Number.isInteger(index) || index < 0 || index >= items.length) throw new Error(`No entry matches "${which}".`)
  const [removed] = items.splice(index, 1)
  writeLines(file, items)
  return removed
}

export function replaceItem(file: string, position: number, text: string) {
  const items = readLines(file)
  if (position < 1 || position > items.length) throw new Error(`No entry ${position}.`)
  const item = tidy(text)
  if (!item) throw new Error("The text is empty.")
  if (looksSecret(item)) throw new Error("Refused: that looks like a credential. Secrets are never stored.")
  items[position - 1] = item
  writeLines(file, items)
}

export const termKey = (item: string) => item.split(":")[0].trim().toLowerCase()
export const addTerm = (root: string, term: string, meaning: string) => addItem(glossaryFile(root), `${term.trim()}: ${meaning.trim()}`, termKey)

// Pins: files whose current content goes into every turn of one session.
export const pinsFile = (sessionID: string) => path.join(dataRoot(), "pins", `${sessionID.replace(/[^\w-]/g, "_")}.json`)

export function listPins(sessionID: string): string[] {
  try {
    const value = JSON.parse(readFileSync(pinsFile(sessionID), "utf8"))
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : []
  } catch {
    return []
  }
}

export function addPin(sessionID: string, file: string) {
  const info = statSync(file)
  if (!info.isFile()) throw new Error(`Not a file: ${file}`)
  if (info.size > MAX_PIN_BYTES) throw new Error(`Too large to pin: ${file} is ${Math.ceil(info.size / 1024)} KB (limit ${MAX_PIN_BYTES / 1024} KB).`)
  const pins = listPins(sessionID)
  if (!pins.includes(file)) save(pinsFile(sessionID), JSON.stringify([...pins, file]))
  return { pins: listPins(sessionID), tokens: Math.ceil(info.size / 4) }
}

/** Removes one pin by absolute path or unique path suffix; "all" clears the session. Returns what was removed. */
export function removePin(sessionID: string, which: string) {
  const pins = listPins(sessionID)
  const gone = which === "all" ? pins : pins.filter((pin) => pin === which || pin.endsWith(`/${which.replace(/^\.\//, "")}`))
  if (!gone.length) throw new Error(`No pin matches "${which}".`)
  save(pinsFile(sessionID), JSON.stringify(pins.filter((pin) => !gone.includes(pin))))
  return gone
}

/** Current content of every pinned file as [label, block], capped in total; missing files are reported, not dropped. */
export function pinBlocks(sessionID: string, root: string): Array<[string, string]> {
  let budget = MAX_PINS_TOTAL
  return listPins(sessionID).map((file) => {
    const label = path.relative(root, file) || file
    try {
      if (statSync(file).size > MAX_PIN_BYTES) return [label, `<pinned path="${label}">(skipped: file grew past ${MAX_PIN_BYTES / 1024} KB)</pinned>`]
      const text = readFileSync(file, "utf8")
      if (text.length > budget) return [label, `<pinned path="${label}">(skipped: pinned files exceed the ${MAX_PINS_TOTAL / 1024} KB total)</pinned>`]
      budget -= text.length
      return [label, `<pinned path="${label}">\n${text}\n</pinned>`]
    } catch {
      return [label, `<pinned path="${label}">(file no longer exists)</pinned>`]
    }
  })
}

// Project config (committable): .infiniteoc/context.json.
export interface Config {
  sqlite?: string
  openapi?: string
  docs?: string[]
  logs?: Record<string, string>
  repos?: string[]
}

export function readConfig(root: string): Config {
  try {
    const value = JSON.parse(readFileSync(path.join(root, ".infiniteoc", "context.json"), "utf8"))
    if (!value || typeof value !== "object") return {}
    const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : undefined)
    return {
      sqlite: typeof value.sqlite === "string" ? value.sqlite : undefined,
      openapi: typeof value.openapi === "string" ? value.openapi : undefined,
      docs: strings(value.docs),
      repos: strings(value.repos),
      logs: value.logs && typeof value.logs === "object" ? Object.fromEntries(Object.entries(value.logs).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined,
    }
  } catch {
    return {}
  }
}

export const resolveIn = (root: string, file: string) => path.resolve(root, file.replace(/^~(?=$|\/)/, homedir()))

// The /context snapshot: what the last model request of a session was made of.
export const snapshotFile = (sessionID: string) => path.join(dataRoot(), "snapshots", `${sessionID.replace(/[^\w-]/g, "_")}.json`)

interface Part { type: string; text?: string; name?: string; input?: unknown; result?: { value?: unknown } }
export interface RequestShape {
  system: ReadonlyArray<{ text: string }>
  messages: ReadonlyArray<{ role: string; content: ReadonlyArray<Part> }>
  tools: Record<string, { description: string; input: unknown }>
}

// Data URIs count as one image (about 1000 tokens) instead of their base64 length, and nothing is
// stringified twice: this runs on every step over the whole history.
const IMAGE_CHARS = 4000
const chars = (value: unknown): number => {
  if (typeof value === "string") return value.startsWith("data:") ? IMAGE_CHARS : value.length
  if (value === null || typeof value !== "object") return String(value ?? "").length
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + chars(item), 0)
  let sum = 0
  for (const [key, item] of Object.entries(value)) sum += key.length + chars(item)
  return sum
}
const FILE_TOOLS = new Set(["read"])

// System parts are not labelled upstream: the first is the model's base prompt; the rest are recognized by content.
const systemLabel = (text: string, index: number) =>
  index === 0 ? "System prompt"
  : text.includes("<available_skills>") ? "Skills list"
  : text.startsWith("[InfiniteOC") ? "InfiniteOC guidance"
  : /Today's date|<env>/.test(text) ? "Environment and date"
  : "Instructions (AGENTS.md, rules)"

const OURS = "InfiniteOC context (memory, pins, ...)"

/** Character-based token estimates (about 4 characters per token) per kind of context content. */
export function breakdown(request: RequestShape, injected: ReadonlyArray<string> = []) {
  const rows = new Map<string, number>()
  const add = (label: string, count: number) => rows.set(label, (rows.get(label) ?? 0) + Math.ceil(count / 4))
  request.system.forEach((part, index) => {
    // Our block may be the whole part or one section of upstream's combined instruction text.
    const ours = injected.filter((text) => text && part.text.includes(text)).reduce((sum, text) => sum + text.length, 0)
    if (ours) add(OURS, ours)
    if (part.text.length > ours) add(systemLabel(part.text, index), part.text.length - ours)
  })
  add("Tool definitions", Object.entries(request.tools).reduce((sum, [name, tool]) => sum + name.length + tool.description.length + chars(tool.input), 0))
  for (const message of request.messages)
    for (const part of message.content) {
      if (part.type === "text" || part.type === "reasoning")
        add(message.role === "system" ? "Instructions" : message.role === "user" ? "User messages" : "Assistant replies", part.text?.length ?? 0)
      else if (part.type === "tool-call") add("Tool calls", chars(part.input))
      else if (part.type === "tool-result") add(FILE_TOOLS.has(part.name ?? "") ? "Files read" : "Tool output", chars(part.result?.value))
      else if (part.type === "media") add("Attachments", IMAGE_CHARS)
      else if (part.type === "compaction") add("Compaction summary", part.text?.length ?? 0)
    }
  const list = [...rows].map(([label, tokens]) => ({ label, tokens })).sort((a, b) => b.tokens - a.tokens)
  return { total: list.reduce((sum, row) => sum + row.tokens, 0), rows: list }
}

// ---- request slimming ----

/** Tool images above this much base64 are re-encoded (JPEG) at the same dimensions; upstream allows 5 MB. */
export const TOOL_IMAGE_BYTES = 256 * 1024
/** Screenshots kept in a request: always the newest KEEP_IMAGES, older ones dropped BATCH at a time. */
export const KEEP_IMAGES = 4
export const IMAGE_BATCH = 8
export const IMAGE_DROPPED = "[Older screenshot dropped to keep requests small. Take a new one if you need to see it again.]"

interface ImageItem { type: string; mime?: string }
const isImage = (item: ImageItem) => item.type === "file" && typeof item.mime === "string" && item.mime.startsWith("image/")
type ResultPart = { type: string; result?: { type?: string; value?: unknown } }
const imagesIn = (part: ResultPart) =>
  part.type === "tool-result" && part.result?.type === "content" && Array.isArray(part.result.value) ? (part.result.value as ImageItem[]).filter(isImage).length : 0

/**
 * Replaces images in tool results older than the newest `keep` with a note, in place. The cut point moves
 * only every `batch` images, so the prompt prefix (and the provider's cache of it) changes once per batch
 * instead of on every new screenshot. Images the user attached are never touched. Returns how many it dropped.
 */
export function trimToolImages<M extends { content: ReadonlyArray<any> }>(
  messages: M[],
  rebuild: (message: M, content: any[]) => M = (message, content) => ({ ...message, content }),
  keep = KEEP_IMAGES,
  batch = IMAGE_BATCH,
) {
  const total = messages.reduce((sum, message) => sum + message.content.reduce((count: number, part: ResultPart) => count + imagesIn(part), 0), 0)
  const cut = total <= keep ? 0 : Math.floor((total - keep) / batch) * batch
  let seen = 0
  for (let index = 0; index < messages.length && seen < cut; index++) {
    const message = messages[index]
    if (!message.content.some((part: ResultPart) => imagesIn(part) > 0)) continue
    const content = message.content.map((part: ResultPart) => {
      if (imagesIn(part) === 0 || seen >= cut) return part
      const value = (part.result!.value as ImageItem[]).map((item) => (isImage(item) && seen++ < cut ? { type: "text", text: IMAGE_DROPPED } : item))
      return { ...part, result: { ...part.result, value } }
    })
    messages[index] = rebuild(message, content)
  }
  return cut
}

export interface Snapshot { at: number; agent: string; total: number; rows: { label: string; tokens: number }[] }
export const writeSnapshot = (sessionID: string, snapshot: Snapshot) => save(snapshotFile(sessionID), JSON.stringify(snapshot))
export function readSnapshot(sessionID: string): Snapshot | undefined {
  try {
    return JSON.parse(readFileSync(snapshotFile(sessionID), "utf8"))
  } catch {
    return undefined
  }
}

export function formatSnapshot(snapshot: Snapshot) {
  const width = Math.max(...snapshot.rows.map((row) => row.label.length))
  const bar = (tokens: number) => "#".repeat(Math.max(tokens > 0 ? 1 : 0, Math.round((tokens / Math.max(snapshot.total, 1)) * 24)))
  return [
    `Estimated context of the last request (agent ${snapshot.agent}): ~${snapshot.total.toLocaleString("en-US")} tokens`,
    "",
    ...snapshot.rows.map((row) => `${row.label.padEnd(width)}  ${String(row.tokens.toLocaleString("en-US")).padStart(8)}  ${String(Math.round((row.tokens / Math.max(snapshot.total, 1)) * 100)).padStart(3)}%  ${bar(row.tokens)}`),
    "",
    "Estimates use about 4 characters per token; the provider's own count differs a little.",
  ].join("\n")
}
