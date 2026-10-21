// InfiniteOC path-repair: some models (seen with opencode/beam-free) leak an XML-style `">` plus the
// next argument's text into the `path` argument. Upstream then fails the write or, when the leaked text
// contains slashes, creates junk directories; models fall back to shell heredocs that skip edit gates.
// Observed: for edits the leak repeats oldString; for writes it is the intended file body, while
// `content` sometimes holds unrelated text.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim()

/** Repair a `path` of the form `file">` + leaked text; anything else is returned unchanged. */
export function repairLeakedPath(input: unknown): unknown {
  if (!isRecord(input) || typeof input.path !== "string") return input
  // `">` never belongs in a real path, so its presence alone marks the leak.
  const match = /^([^\r\n"<>]+)"\s*>([\s\S]*)$/.exec(input.path)
  const path = match?.[1].trimEnd()
  if (!match || !path) return input
  const raw = match[2].replace(/^[ \t]*\r?\n/, "")
  const tail = normalize(raw)
  if (!tail) return { ...input, path }
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

/** A model-facing error for paths that hold file text rather than a file name, or undefined. */
export function pathProblem(path: string): string | undefined {
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
