// Shared project walker for the quality tools. Synchronous and bounded: these are small, one-shot scans.
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

export const SKIP = new Set([
  "node_modules", ".git", ".runtime", ".upstream", ".tools", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
  ".turbo", ".cache", "coverage", "target", "vendor", "__pycache__", ".venv", "venv",
])
export interface Source {
  path: string
  text: string
}

/** Relative paths of files under root whose name matches `pattern`, sorted, at most `max`. */
export function walk(root: string, pattern: RegExp, max = 3000): string[] {
  const found: string[] = []
  const visit = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= max) return
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) visit(path.join(dir, entry.name))
      } else if (entry.isFile() && pattern.test(entry.name)) found.push(path.relative(root, path.join(dir, entry.name)))
    }
  }
  visit(root)
  return found
}

/** Reads the walked files, skipping any larger than maxBytes (bundles, fixtures). */
export function load(root: string, pattern: RegExp, maxBytes = 300_000, max = 3000): Source[] {
  return walk(root, pattern, max).flatMap((file) => {
    try {
      const full = path.join(root, file)
      return statSync(full).size > maxBytes ? [] : [{ path: file, text: readFileSync(full, "utf8") }]
    } catch {
      return []
    }
  })
}
