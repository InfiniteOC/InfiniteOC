// Design token extraction: CSS custom properties and Tailwind config, grouped so new UI can match them.
import type { Source } from "./scan.ts"

export interface Token {
  name: string
  value: string
  file: string
  /** Other declarations of the same name (dark mode, themes). */
  alternates: string[]
}

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl|hwb|lab|lch|oklab|oklch|color|color-mix)\(|(transparent|currentcolor)$)/i
export const category = (name: string, value: string) => {
  if (COLOR.test(value.trim()) || /(^|-)(color|colour|bg|background|fg|foreground|surface|border|ring|accent|primary|secondary|muted|text)(-|$)/.test(name)) return "color"
  if (/font|leading|tracking|line-height|letter/.test(name) || /(sans-serif|serif|monospace|system-ui)/.test(value)) return "type"
  if (/radius|rounded/.test(name)) return "radius"
  if (/shadow|elevation/.test(name)) return "shadow"
  if (/duration|ease|transition|animation/.test(name)) return "motion"
  if (/space|spacing|gap|padding|margin|size|width|height|inset/.test(name) || /^-?[\d.]+(px|rem|em)$/.test(value.trim())) return "space"
  return "other"
}

export function extractTokens(files: Source[]) {
  const tokens = new Map<string, Token>()
  const tailwind: { file: string; excerpt: string; v4: boolean }[] = []
  for (const file of files) {
    const base = file.path.split("/").at(-1) ?? ""
    if (/^tailwind\.config\./.test(base)) {
      const lines = file.text.split("\n")
      const at = Math.max(0, lines.findIndex((line) => /\btheme\b/.test(line)))
      tailwind.push({ file: file.path, excerpt: lines.slice(at, at + 60).join("\n"), v4: false })
      continue
    }
    if (/@import\s+["']tailwindcss/.test(file.text)) tailwind.push({ file: file.path, excerpt: "", v4: true })
    // Definitions only: a declaration inside a rule, not the var(--x) reads.
    for (const match of file.text.matchAll(/(?:^|[;{\s"'`])(--[\w-]+)\s*:\s*([^;}\n"'`][^;}\n]*)/g)) {
      const name = match[1]
      const value = match[2].trim().replace(/\s*!important$/, "")
      if (!value || value.startsWith("var(--") && value.endsWith(")") && value.includes(name)) continue
      const known = tokens.get(name)
      if (!known) tokens.set(name, { name, value, file: file.path, alternates: [] })
      else if (known.value !== value && !known.alternates.includes(value)) known.alternates.push(value)
    }
  }
  return { tokens: [...tokens.values()], tailwind }
}

export function formatTokens(result: ReturnType<typeof extractTokens>, limit = 150) {
  if (result.tokens.length === 0 && result.tailwind.length === 0) return "No CSS custom properties or Tailwind config found. Read the existing styles directly and match their values."
  const groups = new Map<string, Token[]>()
  for (const token of result.tokens) {
    const key = category(token.name, token.value)
    groups.set(key, [...(groups.get(key) ?? []), token])
  }
  const out: string[] = []
  let shown = 0
  for (const key of ["color", "type", "space", "radius", "shadow", "motion", "other"]) {
    const list = groups.get(key)
    if (!list) continue
    out.push(`## ${key} (${list.length})`)
    for (const token of list) {
      if (shown++ >= limit) break
      out.push(`${token.name}: ${token.value}${token.alternates.length ? `  | also: ${token.alternates.slice(0, 3).join(" | ")}` : ""}  (${token.file})`)
    }
  }
  if (shown >= limit) out.push(`... truncated at ${limit} tokens of ${result.tokens.length}`)
  for (const item of result.tailwind)
    out.push(item.v4 ? `## tailwind v4 (CSS-first): theme tokens are the --* variables above (${item.file})` : `## tailwind config ${item.file}\n${item.excerpt}`)
  out.push("Use these variables and scales for new UI instead of inventing values; reuse a token when one is close.")
  return out.join("\n")
}
