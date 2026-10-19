// InfiniteOCTX paging: old, bulky tool outputs leave the request in large batches and come back word
// for word through the recall tool. Pure (no imports): written to
// packages/core/src/plugin/infiniteoctx-lib.ts by mods/infiniteoctx and loaded directly by node tests.
//
// Every request resends the whole conversation, and in long sessions tool outputs are most of it
// (measured: ~38% of all context tokens read, ~110k tokens per request on average). A paged output is
// replaced by a stub with its first and last lines and a recall id; nothing is summarized or lost.
// Decisions are batched and sticky so the cached prompt prefix moves rarely: once paged, always paged
// (in this session), and a batch only happens when it frees a lot at once.

export type Policy = {
  /** Outputs of the newest this-many assistant steps always stay. */
  readonly keepSteps: number
  /** Smaller outputs always stay: their stub would save little. */
  readonly minChars: number
  /** Page only when the candidates free at least this many tokens together. */
  readonly batchTokens: number
}

// Measured on the stored sessions: ~21% fewer context tokens per request, 76 batches in total.
export const DEFAULT_POLICY: Policy = { keepSteps: 15, minChars: 1500, batchTokens: 25_000 }

export const RECALL = "recall"

// Outputs the model keeps acting on (instructions, plans, its own notes, answers) are never paged.
export const PINNED = new Set([
  "skill",
  "tool_guide",
  "load_tools",
  "question",
  "goal_progress",
  "todowrite",
  "todoread",
  "todo",
  "memory",
  "workflow",
  "subagent",
  "task",
  "infiniteoc",
])

type Item = { readonly type: string; readonly text?: string }
type Result = { readonly type: string; readonly value: unknown }
export type ResultPart = { readonly type: "tool-result"; readonly id: string; readonly name: string; readonly result: Result }
type Part = { readonly type: string }
export type MessageLike = { readonly role: string; readonly content: ReadonlyArray<Part> }

const isResult = (part: Part): part is ResultPart => part.type === "tool-result"

/** The text a model sees for a result, or undefined when it is not plain text (errors, images, media). */
export function resultText(result: Result): string | undefined {
  if (result.type === "text") return typeof result.value === "string" ? result.value : undefined
  if (result.type === "json") {
    try {
      return JSON.stringify(result.value) ?? undefined
    } catch {
      return undefined
    }
  }
  if (result.type === "content" && Array.isArray(result.value)) {
    const items = result.value as Item[]
    if (items.length === 0 || items.some((item) => item.type !== "text" || typeof item.text !== "string")) return undefined
    return items.map((item) => item.text).join("\n")
  }
  return undefined
}

export type Candidate = { readonly id: string; readonly name: string; readonly text: string; readonly step: number }

/** Tool outputs old enough, big enough and not pinned, in conversation order. */
export function candidates(messages: ReadonlyArray<MessageLike>, paged: ReadonlySet<string>, policy: Policy = DEFAULT_POLICY): Candidate[] {
  const found: Candidate[] = []
  let step = 0
  for (const message of messages) {
    if (message.role === "assistant") step++
    for (const part of message.content) {
      if (!isResult(part) || paged.has(part.id) || PINNED.has(part.name)) continue
      const text = resultText(part.result)
      if (text === undefined || text.length < policy.minChars) continue
      found.push({ id: part.id, name: part.name, text, step })
    }
  }
  return found.filter((candidate) => candidate.step <= step - policy.keepSteps)
}

const tokens = (chars: number) => Math.round(chars / 4)

/** The candidates to page now: all of them once they free a batch's worth of tokens, else none. */
export function nextBatch(found: ReadonlyArray<Candidate>, policy: Policy = DEFAULT_POLICY): Candidate[] {
  const freed = found.reduce((sum, candidate) => sum + tokens(candidate.text.length - stub(candidate.id, candidate.name, candidate.text).length), 0)
  return freed >= policy.batchTokens ? [...found] : []
}

const HEAD = 4
const TAIL = 2
const LINE = 200
const cut = (line: string) => (line.length > LINE ? `${line.slice(0, LINE)}…` : line)

/** What the model sees instead of a paged output: what it was, how to get it back, its first and last lines. */
export function stub(id: string, name: string, text: string): string {
  const lines = text.split("\n")
  const header = `[InfiniteOC paged this ${name} output out of the context (${text.length.toLocaleString("en-US")} chars, ${lines.length.toLocaleString("en-US")} lines). recall {"id":${JSON.stringify(id)}} returns it word for word; do not re-run the tool to see it again.]`
  const excerpt =
    lines.length <= HEAD + TAIL
      ? lines.map(cut)
      : [...lines.slice(0, HEAD).map(cut), `… ${(lines.length - HEAD - TAIL).toLocaleString("en-US")} more lines …`, ...lines.slice(-TAIL).map(cut)]
  return [header, ...excerpt].join("\n")
}

/**
 * Replaces every paged output in the request with its stub, in place. `rebuild` makes a message with
 * new content (upstream messages are immutable classes). Returns how many outputs and characters left
 * the request.
 */
export function applyPaging<M extends MessageLike>(
  messages: M[],
  paged: ReadonlySet<string>,
  rebuild: (message: M, content: Part[]) => M = (message, content) => ({ ...message, content }) as M,
) {
  let outputs = 0
  let chars = 0
  if (paged.size === 0) return { outputs, chars }
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (!message.content.some((part) => isResult(part) && paged.has(part.id))) continue
    const content = message.content.map((part) => {
      if (!isResult(part) || !paged.has(part.id)) return part
      const text = resultText(part.result)
      if (text === undefined) return part
      const replacement = stub(part.id, part.name, text)
      outputs++
      chars += text.length - replacement.length
      return { ...part, result: { type: "text", value: replacement } }
    })
    messages[index] = rebuild(message, content)
  }
  return { outputs, chars }
}
