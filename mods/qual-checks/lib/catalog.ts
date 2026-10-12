// Component catalog: exported UI components with their props and how widely they are used, so the agent reuses them.
import type { Source } from "./scan.ts"

export interface Component {
  name: string
  file: string
  props: string[]
  used: number
}

const PASCAL = /^[A-Z][A-Za-z0-9]*$/

/** Keys of the first `interface NameProps {` or `type NameProps = {` block. */
function propsOf(text: string, name: string): string[] {
  const head = new RegExp(`(?:interface|type)\\s+${name}Props\\b[^{]*\\{`).exec(text)
  if (head) {
    let depth = 1
    let i = head.index + head[0].length
    const start = i
    for (; i < text.length && depth > 0; i++) depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0
    const body = text.slice(start, i - 1)
    const keys: string[] = []
    let level = 0
    for (const line of body.split("\n")) {
      if (level === 0) {
        const key = /^\s*(?:readonly\s+)?['"]?([\w-]+)['"]?\??\s*:/.exec(line)?.[1]
        if (key) keys.push(key)
      }
      level += (line.match(/[{(\[]/g)?.length ?? 0) - (line.match(/[})\]]/g)?.length ?? 0)
    }
    return keys
  }
  const destructured = new RegExp(`(?:function\\s+${name}|const\\s+${name}\\s*=\\s*(?:\\([^)]*\\)\\s*=>|function)?)\\s*\\(\\s*\\{([^}]*)\\}`).exec(text)?.[1]
  return destructured ? destructured.split(",").map((item) => item.trim().split(/[:=\s]/)[0]).filter(Boolean) : []
}

export function catalog(files: Source[]): Component[] {
  const found: Component[] = []
  for (const file of files) {
    const ext = file.path.split(".").at(-1)
    const base = (file.path.split("/").at(-1) ?? "").replace(/\.[^.]+$/, "")
    if (ext === "vue" || ext === "svelte" || ext === "astro") {
      if (PASCAL.test(base)) found.push({ name: base, file: file.path, props: [...file.text.matchAll(/(?:defineProps|export let)\s*[<(]?\s*\{?\s*(\w+)/g)].map((m) => m[1]).slice(0, 12), used: 0 })
      continue
    }
    if (ext !== "tsx" && ext !== "jsx") continue
    const names = new Set<string>()
    for (const m of file.text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const)\s+([A-Z]\w*)/g)) names.add(m[1])
    for (const m of file.text.matchAll(/export\s*\{([^}]*)\}/g))
      for (const item of m[1].split(",")) {
        const exported = item.trim().split(/\s+as\s+/).at(-1) ?? ""
        if (PASCAL.test(exported)) names.add(exported)
      }
    const fallback = /export\s+default\s+([A-Z]\w*)\s*$/m.exec(file.text)?.[1]
    if (fallback) names.add(fallback)
    for (const name of names) found.push({ name, file: file.path, props: propsOf(file.text, name), used: 0 })
  }
  const usage = new Map<string, Set<string>>()
  for (const file of files)
    for (const m of file.text.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) usage.set(m[1], (usage.get(m[1]) ?? new Set()).add(file.path))
  for (const item of found) item.used = [...(usage.get(item.name) ?? [])].filter((file) => file !== item.file).length
  return found.sort((a, b) => b.used - a.used || a.name.localeCompare(b.name))
}

export function formatCatalog(items: Component[], limit = 120) {
  if (items.length === 0) return "No exported components found (looked at .tsx, .jsx, .vue, .svelte, .astro). Check how the UI is built before adding new ones."
  const lines = items.slice(0, limit).map((item) => `${item.name}  ${item.file}${item.props.length ? `  props: ${item.props.slice(0, 12).join(", ")}` : ""}  used in ${item.used} file${item.used === 1 ? "" : "s"}`)
  if (items.length > limit) lines.push(`... ${items.length - limit} more`)
  return `${items.length} components, most used first. Reuse or extend one of these before creating a new component.\n${lines.join("\n")}`
}
