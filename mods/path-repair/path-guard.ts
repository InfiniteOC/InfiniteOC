// InfiniteOC path-repair: some models (seen with opencode/beam-free) leak an XML-style `">` plus the
// next argument's text into the `path` argument. Upstream then fails the write or, when the leaked text
// contains slashes, creates junk directories; models fall back to shell heredocs that skip edit gates.
// Observed: for edits the leak repeats oldString, or is the intended oldString while oldString repeats
// newString (arguments shifted left); for writes it is the intended file body, while `content`
// sometimes holds unrelated text.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim()

// Several tool calls that reached us as one: after the first file's text and the model's own notes comes its
// raw chat stream (`<|end|><|start|>assistant to=write ... <rfl:parameter name="path">`) with the next calls.
// Seen in 8 of 30 eval runs; written as is, the junk broke the page and cost dozens of steps.
const PACKED = [/<\|end\|>\s*<\|start\|>/, /<rfl:parameter name=/]

/** A model-facing refusal when any text holds tool calls run together, or undefined. */
export function packedProblem(...texts: unknown[]): string | undefined {
  const packed = texts.some((text) => typeof text === "string" && PACKED.every((marker) => marker.test(text)))
  if (!packed) return undefined
  return 'Refused: this call holds several tool calls run together (raw "<|end|><|start|>" and "<rfl:parameter" text), so nothing was written. Make one tool call per file, each with only that file\'s path and text.'
}

/** Repair a `path` of the form `file">` + leaked text; anything else is returned unchanged. */
export function repairLeakedPath(input: unknown): unknown {
  if (!isRecord(input) || typeof input.path !== "string") return input
  // Packed calls are refused by the tool, never repaired into one file.
  if (packedProblem(...Object.values(input))) return input
  // `">` never belongs in a real path, so its presence alone marks the leak.
  const match = /^([^\r\n"<>]+)"\s*>([\s\S]*)$/.exec(input.path)
  const path = match?.[1].trimEnd()
  if (!match || !path) return input
  // Some leaks start with the next argument's own name (`oldString">`); several such markers mean the
  // model packed more than one value into the call, which cannot be split back safely.
  const names = Object.keys(input).filter((key) => key !== "path").map((key) => key.replace(/[^\w-]/g, "\\$&")).join("|")
  let raw = match[2].replace(/^[ \t]*\r?\n/, "")
  if (names) {
    raw = raw.replace(new RegExp(`^\\s*(?:${names})"\\s*>[ \\t]*\\r?\\n?`), "")
    if (new RegExp(`\\n\\s*(?:${names})"\\s*>`).test(raw)) return input
  }
  const tail = normalize(raw)
  if (!tail) return { ...input, path }
  // An edit whose arguments shifted left: the leak is the intended oldString and oldString repeats newString
  // (an edit that could never apply). A wrong guess only fails with "oldString not found".
  if (typeof input.oldString === "string" && input.oldString === input.newString && normalize(input.oldString) !== tail)
    return { ...input, path, oldString: raw }
  // The leak repeats another argument (either may be cut short): keep the arguments as sent.
  const echoed = Object.entries(input).some(([key, value]) => {
    if (key === "path" || typeof value !== "string") return false
    const other = normalize(value)
    return other.length > 0 && (other === tail || other.startsWith(tail) || tail.startsWith(other))
  })
  if (echoed) return { ...input, path }
  // A write whose content does not match: the leaked text is the body the model meant to write.
  if (typeof input.content === "string") return { ...input, path, content: raw }
  return input
}

// A write whose content ends like a shell heredoc (`EOF`, then maybe `echo done`): the model wrote the file as
// if through `cat <<'EOF'`, and the tail made the file unparseable (eval5/b-1 wrote six files this way).
const HEREDOC_TAIL = /\r?\n([A-Z][A-Z0-9_]*_)?EOF[ \t]*(?:\r?\n[ \t]*echo\b[^\n]{0,60})?\s*$/
const SHELL_FILE = /\.(?:sh|bash|zsh|ksh|fish)$/i

/** The input with a heredoc tail removed from a write's content; anything else is returned unchanged. */
export function stripHeredocTail(input: unknown): unknown {
  if (!isRecord(input) || typeof input.path !== "string" || typeof input.content !== "string" || SHELL_FILE.test(input.path)) return input
  const match = HEREDOC_TAIL.exec(input.content)
  if (!match) return input
  // A file that opens this heredoc itself (a script inside a template string, docs) keeps its text.
  const delimiter = `${match[1] ?? ""}EOF`
  if (new RegExp(`<<-?\\s*['"]?${delimiter}\\b`).test(input.content)) return input
  return { ...input, content: `${input.content.slice(0, match.index)}\n` }
}

/** A model-facing error for paths that hold file text rather than a file name, or for calls packed together. */
export function pathProblem(path: string, ...texts: unknown[]): string | undefined {
  const packed = packedProblem(path, ...texts)
  if (packed) return packed
  const problem = /[\r\n\0]/.test(path)
    ? "contains a line break"
    : /<\/?[A-Za-z!]|["'`]\s*>/.test(path)
      ? "contains markup"
      : path.split(/[\\/]/).some((part) => new TextEncoder().encode(part).length > 255)
        ? "has a name longer than 255 bytes"
        : undefined
  if (!problem) return undefined
  const preview = path.length > 80 ? `${path.slice(0, 77)}...` : path
  return `Invalid path ${JSON.stringify(preview)}: it ${problem}, so file text probably leaked into the path argument. No file was changed. Retry with only the file path in "path" (for example "src/app.js") and the text in its own argument.`
}
