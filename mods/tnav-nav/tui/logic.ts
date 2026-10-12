// Pure helpers for the tnav plugin. No JSX and no imports, so Node loads this file directly in tests.

export type Part = {
  type: string
  text?: string
  name?: string
  state?: { status?: string; input?: unknown; error?: { message?: string } }
}
export type Message = {
  id: string
  type: string
  text?: string
  command?: string
  output?: { output?: string }
  content?: Part[]
  error?: unknown
  snapshot?: { files?: string[] }
  time?: { created?: number }
}
export type SessionLike = {
  id: string
  title?: string
  parentID?: string
  fork?: { sessionID: string; boundary: { type: string; messageID: string } }
  time: { created: number; updated: number }
}
export type FileDiff = { file: string; patch?: string; additions: number; deletions: number; status: string }

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "patch", "multiedit"])

export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

/** Text a message contributes to full-text search; reasoning is left out. */
export function messageText(message: Message): string {
  if (message.type === "user" || message.type === "synthetic") return message.text ?? ""
  if (message.type === "shell") return `${message.command ?? ""}\n${message.output?.output ?? ""}`
  if (message.type !== "assistant") return ""
  return (message.content ?? [])
    .flatMap((part) => {
      if (part.type === "text") return [part.text ?? ""]
      if (part.type !== "tool") return []
      const input = part.state?.input
      return [`${part.name ?? "tool"} ${typeof input === "string" ? input : JSON.stringify(input ?? {})}`]
    })
    .join("\n")
}

export const searchTerms = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean)

/** A text matches when it contains every term (case-insensitive). */
export function matchesTerms(text: string, terms: string[]) {
  if (!terms.length) return false
  const lower = text.toLowerCase()
  return terms.every((term) => lower.includes(term))
}

/** About `width` characters of context around the first term hit, on one line. */
export function snippet(text: string, terms: string[], width = 90) {
  const flat = oneLine(text)
  const lower = flat.toLowerCase()
  const hit = Math.min(...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0), Infinity)
  if (!Number.isFinite(hit)) return flat.slice(0, width)
  const start = Math.max(0, Math.min(hit - Math.floor(width / 4), flat.length - width))
  const end = Math.min(flat.length, start + width)
  return `${start > 0 ? "..." : ""}${flat.slice(start, end)}${end < flat.length ? "..." : ""}`
}

export type Hit = { messageID?: string; role: string; snippet: string }
export type Entry = { id: string; type: string; text: string }

/** Searchable form of a message, or undefined when it has no text. */
export function toEntry(message: Message): Entry | undefined {
  const text = messageText(message)
  return text ? { id: message.id, type: message.type, text } : undefined
}

/** Matching entries of one session, in conversation order, at most `max`. */
export function searchEntries(entries: Entry[], query: string, max = 3): Hit[] {
  const terms = searchTerms(query)
  const hits: Hit[] = []
  for (const entry of entries) {
    if (!matchesTerms(entry.text, terms)) continue
    hits.push({ messageID: entry.id, role: entry.type, snippet: snippet(entry.text, terms) })
    if (hits.length >= max) break
  }
  return hits
}

export const searchMessages = (messages: Message[], query: string, max = 3) =>
  searchEntries(messages.flatMap((message) => toEntry(message) ?? []), query, max)

export type TreeRow = { session: SessionLike; depth: number; prefix: string }

/**
 * Fork tree of the family containing `focus` (or every family with a fork when `focus` is absent).
 * A session whose fork parent is missing from `sessions` is a root.
 */
export function forkTree(sessions: SessionLike[], focus?: string): TreeRow[] {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const children = new Map<string, SessionLike[]>()
  const roots: SessionLike[] = []
  for (const session of sessions) {
    const parent = session.fork?.sessionID
    if (parent && byID.has(parent)) children.set(parent, [...(children.get(parent) ?? []), session])
    else roots.push(session)
  }
  const sort = (list: SessionLike[]) => list.sort((a, b) => a.time.created - b.time.created)
  const rootOf = (id: string) => {
    let current = byID.get(id)
    for (let guard = 0; current?.fork && byID.has(current.fork.sessionID) && guard < 1000; guard++)
      current = byID.get(current.fork.sessionID)
    return current
  }
  const selected = focus ? [rootOf(focus)].filter((root): root is SessionLike => !!root) : sort(roots).filter((root) => children.has(root.id))
  const rows: TreeRow[] = []
  const walk = (session: SessionLike, depth: number, lead: string, last: boolean) => {
    rows.push({ session, depth, prefix: depth === 0 ? "" : `${lead}${last ? "└─ " : "├─ "}` })
    const kids = sort([...(children.get(session.id) ?? [])])
    kids.forEach((kid, index) => walk(kid, depth + 1, depth === 0 ? "" : `${lead}${last ? "   " : "│  "}`, index === kids.length - 1))
  }
  for (const root of selected) walk(root, 0, "", true)
  return rows
}

export type CellKind = "user" | "assistant" | "edit" | "error" | "shell"
export type Cell = { kind: CellKind; messageID: string; marked: boolean }

const PRIORITY: Record<CellKind, number> = { assistant: 0, shell: 1, user: 2, edit: 3, error: 4 }

export function messageKind(message: Message): CellKind | undefined {
  if (message.type === "user") return "user"
  if (message.type === "shell") return "shell"
  if (message.type !== "assistant") return undefined
  const parts = message.content ?? []
  if (message.error || parts.some((part) => part.type === "tool" && part.state?.status === "error")) return "error"
  if (parts.some((part) => part.type === "tool" && EDIT_TOOLS.has(part.name ?? "")) || message.snapshot?.files?.length) return "edit"
  return "assistant"
}

/** One cell per message; the most notable kind wins when `width` forces cells to share. */
export function minimap(messages: Message[], marks: ReadonlySet<string>, width: number): Cell[] {
  const cells = messages.flatMap((message): Cell[] => {
    const kind = messageKind(message)
    return kind ? [{ kind, messageID: message.id, marked: marks.has(message.id) }] : []
  })
  if (width <= 0 || cells.length <= width) return cells
  return Array.from({ length: width }, (_, index) => {
    const bucket = cells.slice(Math.floor((index * cells.length) / width), Math.floor(((index + 1) * cells.length) / width) || undefined)
    const best = bucket.reduce((top, cell) => (PRIORITY[cell.kind] > PRIORITY[top.kind] ? cell : top), bucket[0]!)
    const marked = bucket.find((cell) => cell.marked)
    return { kind: best.kind, messageID: (marked ?? best).messageID, marked: !!marked }
  })
}

export const minimapCounts = (messages: Message[]) => {
  const kinds = messages.map(messageKind)
  const count = (kind: CellKind) => kinds.filter((value) => value === kind).length
  return { turns: count("user"), edits: count("edit"), errors: count("error") }
}

/** Next (or previous) bookmark after `current` in conversation order, wrapping around. */
export function stepBookmark(order: string[], marks: ReadonlySet<string>, current: string | undefined, direction: 1 | -1) {
  const ids = order.filter((id) => marks.has(id))
  if (!ids.length) return undefined
  const index = current ? ids.indexOf(current) : -1
  if (index === -1) return direction === 1 ? ids[0] : ids[ids.length - 1]
  return ids[(index + direction + ids.length) % ids.length]
}

const stamp = (ms?: number) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "")
const fence = (text: string, lang = "") => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length))
  const ticks = "`".repeat(longest + 1)
  return `${ticks}${lang}\n${text.replace(/\n$/, "")}\n${ticks}`
}

/** Unified-diff-like text for an edit/write tool call, taken from its input. */
export function toolDiff(part: Part): string | undefined {
  const input = part.state?.input
  if (!input || typeof input !== "object") return undefined
  const value = input as Record<string, unknown>
  const path = String(value.path ?? value.filePath ?? "")
  if (part.name === "edit" && typeof value.oldString === "string" && typeof value.newString === "string")
    return [`--- ${path}`, `+++ ${path}`, ...value.oldString.split("\n").map((line) => `-${line}`), ...value.newString.split("\n").map((line) => `+${line}`)].join("\n")
  if (part.name === "write" && typeof value.content === "string")
    return [`--- /dev/null`, `+++ ${path}`, ...value.content.replace(/\n$/, "").split("\n").map((line) => `+${line}`)].join("\n")
  if (part.name === "apply_patch" && typeof value.patchText === "string") return value.patchText
  return undefined
}

export type Transcript = { title: string; id: string; created?: number; updated?: number; messages: Message[]; diffs: FileDiff[] }

export function toMarkdown(input: Transcript, options: { thinking?: boolean } = {}) {
  const out = [`# ${input.title}`, "", `Session ${input.id}`, `Created ${stamp(input.created)}  Updated ${stamp(input.updated)}`, ""]
  for (const message of input.messages) {
    if (message.type === "user") out.push("## User", "", message.text ?? "", "")
    else if (message.type === "shell") out.push("## Shell", "", fence(`$ ${message.command ?? ""}\n${message.output?.output ?? ""}`), "")
    else if (message.type === "assistant") {
      const body = (message.content ?? []).flatMap((part) => {
        if (part.type === "text") return [part.text ?? ""]
        if (part.type === "reasoning") return options.thinking ? [`_Thinking:_\n\n${part.text ?? ""}`] : []
        const diff = toolDiff(part)
        const status = part.state?.status === "error" ? ` (failed: ${part.state.error?.message ?? "error"})` : ""
        return [`**Tool: ${part.name}**${status}` + (diff ? `\n\n${fence(diff, "diff")}` : "")]
      })
      if (body.length) out.push("## Assistant", "", body.join("\n\n"), "")
    }
  }
  if (input.diffs.length) {
    const add = input.diffs.reduce((sum, file) => sum + file.additions, 0)
    const del = input.diffs.reduce((sum, file) => sum + file.deletions, 0)
    out.push(`## Changes (${input.diffs.length} files, +${add} -${del})`, "")
    for (const file of input.diffs) out.push(`### ${file.file} (${file.status}, +${file.additions} -${file.deletions})`, "", fence(file.patch ?? "", "diff"), "")
  }
  return out.join("\n")
}

export const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const diffHtml = (patch: string) =>
  patch
    .split("\n")
    .map((line) => {
      const kind = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "ctx"
      return `<span class="${kind}">${escapeHtml(line)}</span>`
    })
    .join("\n")

export function toHtml(input: Transcript, options: { thinking?: boolean } = {}) {
  const blocks = input.messages.flatMap((message) => {
    if (message.type === "user") return [`<section class="user"><h2>User</h2><pre class="text">${escapeHtml(message.text ?? "")}</pre></section>`]
    if (message.type === "shell")
      return [`<section class="shell"><h2>Shell</h2><pre>${escapeHtml(`$ ${message.command ?? ""}\n${message.output?.output ?? ""}`)}</pre></section>`]
    if (message.type !== "assistant") return []
    const body = (message.content ?? []).flatMap((part) => {
      if (part.type === "text") return [`<pre class="text">${escapeHtml(part.text ?? "")}</pre>`]
      if (part.type === "reasoning") return options.thinking ? [`<pre class="thinking">${escapeHtml(part.text ?? "")}</pre>`] : []
      const diff = toolDiff(part)
      const failed = part.state?.status === "error" ? ` <em>failed: ${escapeHtml(part.state.error?.message ?? "error")}</em>` : ""
      return [`<div class="tool"><strong>${escapeHtml(part.name ?? "tool")}</strong>${failed}${diff ? `<pre class="diff">${diffHtml(diff)}</pre>` : ""}</div>`]
    })
    return body.length ? [`<section class="assistant"><h2>Assistant</h2>${body.join("")}</section>`] : []
  })
  const changes = input.diffs.length
    ? `<section class="changes"><h2>Changes (${input.diffs.length} files)</h2>${input.diffs
        .map((file) => `<h3>${escapeHtml(file.file)} <small>${escapeHtml(file.status)} +${file.additions} -${file.deletions}</small></h3><pre class="diff">${diffHtml(file.patch ?? "")}</pre>`)
        .join("")}</section>`
    : ""
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
:root{--bg:#fffaff;--fg:#21102b;--muted:#60416f;--card:#f7eefb;--line:#d8b4fe;--add:#166534;--addbg:#dcfce7;--del:#991b1b;--delbg:#fee2e2;--accent:#7e22ce}
@media(prefers-color-scheme:dark){:root{--bg:#0e0913;--fg:#fff5ff;--muted:#cfb8df;--card:#211629;--line:#654777;--add:#86efac;--addbg:#12301f;--del:#fca5a5;--delbg:#3a1414;--accent:#c084fc}}
body{margin:0 auto;max-width:56rem;padding:1.5rem 1rem 4rem;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
h1{font-size:1.4rem;margin:0}.meta{color:var(--muted);font-size:.85rem;margin:.25rem 0 1.5rem}
section{background:var(--card);border-left:3px solid var(--line);border-radius:6px;padding:.25rem 1rem .75rem;margin:.75rem 0}
section.user{border-left-color:var(--accent)}h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:.6rem 0 .3rem}
h3{font-size:.95rem;margin:1rem 0 .3rem}pre{white-space:pre-wrap;word-break:break-word;margin:.3rem 0;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.thinking{color:var(--muted);font-style:italic}.tool{margin:.4rem 0;font-size:.9rem}.diff{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:.4rem .6rem;overflow-x:auto}
.diff span{display:block}.diff .add{color:var(--add);background:var(--addbg)}.diff .del{color:var(--del);background:var(--delbg)}.diff .hunk{color:var(--accent)}
</style></head><body>
<h1>${escapeHtml(input.title)}</h1>
<p class="meta">Session ${escapeHtml(input.id)} &middot; created ${escapeHtml(stamp(input.created))} &middot; updated ${escapeHtml(stamp(input.updated))}</p>
${blocks.join("\n")}
${changes}
</body></html>
`
}

export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session"
