const core = "packages/core/src"

// Faster core file tools with identical behavior. Deliberately NOT changed:
// - edit's permission-first ordering: tool-edit.test.ts "denied edit does not
//   disclose whether oldString matches" requires permission.assert to run even
//   on doomed edits, so denied callers learn nothing. Reordering would break a
//   security test for one saved prompt.
// - the provider transport: route/executor.ts builds one shared HttpClient over
//   FetchHttpClient (pooled keep-alive); per-request connections are already
//   reused and latency is server-side inference. No safe change exists there.
// - read/grep/glob/shell: paged reads, ripgrep binary with timeout, output
//   spilling are already optimal; no safe win found.
export const patches = [
  [`${core}/tool/plugin/edit.ts`, `const findLineOccurrences = (content: string, search: string) => {
  const trailingNewline = search.endsWith("\\n")
  const expected = search.split("\\n")
  if (trailingNewline) expected.pop()
  const lines = [...content.matchAll(/[^\\n]*(?:\\n|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => {
      const newline = match[0].endsWith("\\n")
      const text = newline ? match[0].slice(0, -1) : match[0]
      return {
        start: match.index,
        end: match.index + match[0].length,
        text,
        contentEnd: match.index + text.length - (text.endsWith("\\r") ? 1 : 0),
        newline,
      }
    })
  const candidates = lines.flatMap((line, index) => {
    const actual = lines.slice(index, index + expected.length)
    if (actual.length !== expected.length) return []
    if (
      !actual.every(
        (item, lineIndex) =>
          normalizeForMatch(item.text.trimEnd()) === normalizeForMatch(expected[lineIndex].trimEnd()),
      )
    )
      return []
    const last = actual.at(-1)!
    if (trailingNewline && !last.newline) return []
    return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }]
  })`, `const findLineOccurrences = (content: string, search: string) => {
  const trailingNewline = search.endsWith("\\n")
  const expected = search.split("\\n")
  if (trailingNewline) expected.pop()
  // Normalized once up front: the comparison below runs per candidate window,
  // so this turns repeated whole-line normalization into a single pass with
  // identical comparisons.
  const expectedNorm = expected.map((line) => normalizeForMatch(line.trimEnd()))
  const lines = [...content.matchAll(/[^\\n]*(?:\\n|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => {
      const newline = match[0].endsWith("\\n")
      const text = newline ? match[0].slice(0, -1) : match[0]
      return {
        start: match.index,
        end: match.index + match[0].length,
        norm: normalizeForMatch(text.trimEnd()),
        contentEnd: match.index + text.length - (text.endsWith("\\r") ? 1 : 0),
        newline,
      }
    })
  const candidates = lines.flatMap((line, index) => {
    const actual = lines.slice(index, index + expected.length)
    if (actual.length !== expected.length) return []
    if (!actual.every((item, lineIndex) => item.norm === expectedNorm[lineIndex])) return []
    const last = actual.at(-1)!
    if (trailingNewline && !last.newline) return []
    return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }]
  })`],
  [`${core}/tool/plugin/edit.ts`, `              const replaced = (input.replaceAll === true ? matches : matches.slice(0, 1))
                .toReversed()
                .reduce(
                  (content, match) => \`\${content.slice(0, match.start)}\${newString}\${content.slice(match.end)}\`,
                  source,
                )`, `              // Single forward pass: matches are ascending and non-overlapping,
              // so joining segments is O(n) instead of re-slicing per replacement.
              const selected = input.replaceAll === true ? matches : matches.slice(0, 1)
              let replaced = source
              if (selected.length > 0) {
                const parts: string[] = []
                let cursor = 0
                for (const match of selected) {
                  parts.push(source.slice(cursor, match.start), newString)
                  cursor = match.end
                }
                parts.push(source.slice(cursor))
                replaced = parts.join("")
              }`],
  [`${core}/tool/plugin/write.ts`, `              const result = yield* fileMutation.writeTextPreservingBom({ target, content: input.content })
              const bom = (yield* FileMutation.readText(environment.files, target.absolute)).bom
              if (yield* formatter.file(target.absolute)) {
                yield* FileMutation.syncTextBom(environment.files, target.absolute, bom)
              }
              return result`, `              const result = yield* fileMutation.writeTextPreservingBom({ target, content: input.content })
              // The sync needs the pre-format BOM flag. It is derived from values
              // already in scope (preview read + split input) instead of re-reading:
              // writeTextPreservingBom just wrote Bom.join(next.text, existingBom
              // || next.bom), so outside racy external writes no fresh read can
              // observe anything different. This also drops the post-write read
              // entirely, including its racy failure path on unformatted writes.
              if (yield* formatter.file(target.absolute)) {
                yield* FileMutation.syncTextBom(
                  environment.files,
                  target.absolute,
                  (current?.bom ?? false) || next.bom,
                )
              }
              return result`],
]

export default {
  id: "tool-perf",
  version: "1.0.0",
  async setup(api) {
    for (const [path, before, after] of patches) await api.patchExact(path, before, after)
  },
}
