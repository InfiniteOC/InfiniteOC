// InfiniTokenSave: lossless request rewriting. Pure (no imports): written to
// packages/core/src/plugin/infinitokensave-lib.ts by mods/infinitokensave and loaded directly by tests.
//
// Every rewrite is a function of one tool output (and, for duplicates, of earlier ones), so a request's
// prefix is identical from step to step and the provider's prompt cache keeps working:
// - terminal noise in command output: ANSI color/cursor codes and progress lines redrawn with \r
//   become what the terminal finally showed;
// - runs of an identical line become the line once plus its exact repeat count;
// - an output identical to an earlier one becomes a reference to that call.
// File-content tools (read, edit, write, patch) are never rewritten: an edit must match their text
// byte for byte. They can still be references to an identical earlier output.

// Outputs whose exact characters the model copies into edits.
export const EXACT = new Set(["read", "edit", "write", "patch", "multiedit", "apply_patch"])

// Below this an identical output is cheaper to repeat than to reference.
export const DUPLICATE_MIN = 400

// CSI (colors, cursor moves, erase), OSC (titles, hyperlinks) and two-character escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

/** A line as a terminal finally shows it after \r redraws (progress bars, spinners). */
function settle(line: string) {
  if (!line.includes("\r")) return line
  const body = line.endsWith("\r") ? line.slice(0, -1) : line
  if (!body.includes("\r")) return body
  // Each \r returns to column 0 and the next segment overwrites from there.
  let shown = ""
  for (const segment of body.split("\r")) shown = segment + shown.slice(segment.length)
  return shown
}

const repeatNote = (count: number) => `[same line ${count} more time${count === 1 ? "" : "s"}]`

/** Command output as a terminal shows it, with runs of identical lines counted. Lossless for meaning. */
export function cleanOutput(text: string): string {
  const lines = text.replace(ANSI, "").split("\n").map(settle)
  const out: string[] = []
  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!
    let end = index + 1
    while (end < lines.length && lines[end] === line) end++
    const extra = end - index - 1
    // Collapse only when the note is shorter than the repeats it replaces.
    if (line.length > 0 && extra >= 2 && extra * (line.length + 1) > repeatNote(extra).length + 1) out.push(line, repeatNote(extra))
    else for (let copy = index; copy < end; copy++) out.push(line)
    index = end
  }
  return out.join("\n")
}

export const duplicateNote = (id: string) => `[Identical, word for word, to the output of tool call ${id} earlier in this conversation.]`

type Item = { readonly type: string; readonly text?: string }
type Result = { readonly type: string; readonly value: unknown }
type ResultPart = { readonly type: "tool-result"; readonly id: string; readonly name: string; readonly result: Result }
type Part = { readonly type: string }
export type MessageLike = { readonly role: string; readonly content: ReadonlyArray<Part> }

const isResult = (part: Part): part is ResultPart => part.type === "tool-result"

/** Plain text of a result; undefined for errors, structured JSON, images and media. */
function textOf(result: Result): string | undefined {
  if (result.type === "text") return typeof result.value === "string" ? result.value : undefined
  if (result.type === "content" && Array.isArray(result.value)) {
    const items = result.value as Item[]
    if (items.length === 0 || items.some((item) => item.type !== "text" || typeof item.text !== "string")) return undefined
    return items.map((item) => item.text).join("\n")
  }
  return undefined
}

/**
 * Rewrites the request's tool outputs in place (see the header). `rebuild` makes a message with new
 * content. Returns how many outputs changed and how many characters left the request.
 */
export function shrinkRequest<M extends MessageLike>(
  messages: M[],
  rebuild: (message: M, content: Part[]) => M = (message, content) => ({ ...message, content }) as M,
) {
  const seen = new Map<string, string>()
  let outputs = 0
  let chars = 0
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    let changed = false
    const content = message.content.map((part) => {
      if (!isResult(part)) return part
      const text = textOf(part.result)
      if (text === undefined) return part
      const first = text.length >= DUPLICATE_MIN ? seen.get(text) : undefined
      if (text.length >= DUPLICATE_MIN && first === undefined) seen.set(text, part.id)
      const next = first !== undefined ? duplicateNote(first) : EXACT.has(part.name) ? text : cleanOutput(text)
      if (next === text || next.length >= text.length) return part
      changed = true
      outputs++
      chars += text.length - next.length
      return { ...part, result: { type: "text", value: next } }
    })
    if (changed) messages[index] = rebuild(message, content)
  }
  return { outputs, chars }
}
