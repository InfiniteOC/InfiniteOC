// InfiniteOC path-repair: some models (seen with opencode/beam-free) leak an XML-style `">` and the
// whole file body into the `path` argument while also sending that body correctly in `content`.
// Upstream then fails the write or, when the leaked text contains slashes, creates junk directories.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim()

// The leaked copy must match another string argument, so a real path is never rewritten on a guess.
const MIN_ECHO = 8

/** Strip a leaked `">` + body from `path` when that body is also present in another argument. */
export function repairLeakedPath(input: unknown): unknown {
  if (!isRecord(input) || typeof input.path !== "string") return input
  const match = /^([^\r\n"<>]+)"?\s*>([\s\S]*)$/.exec(input.path)
  if (!match) return input
  const tail = normalize(match[2])
  if (tail.length < MIN_ECHO) return input
  const echoed = Object.entries(input).some(([key, value]) => {
    if (key === "path" || typeof value !== "string") return false
    const other = normalize(value)
    return other.length >= MIN_ECHO && (other === tail || other.startsWith(tail) || tail.startsWith(other))
  })
  const path = match[1].trimEnd()
  return echoed && path ? { ...input, path } : input
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
  return `Invalid path ${JSON.stringify(preview)}: it ${problem}, so file text probably leaked into the path argument. No file was changed. Pass only the file path in "path" (for example "src/app.js") and the text in the content argument. If your calls keep arriving this way, write the file with the shell tool instead (cat > file <<'EOF' ... EOF).`
}
