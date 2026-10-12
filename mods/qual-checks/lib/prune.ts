// /prune: unused files and exports in a JS/TS project, by a simple static import-graph scan.
// ponytail: textual regex scan, no tsconfig paths or bundler aliases beyond a suffix match; the report lists
// candidates to verify, never a deletion list.
import type { Source } from "./scan.ts"

export const CODE = /\.(?:[mc]?[jt]sx?)$/
const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"]
const ENTRY = /(^|\/)(index|main|cli|server|app)\.[mc]?[jt]sx?$|\.(test|spec|stories|d)\.[mc]?[jt]sx?$|\.config\.[mc]?[jt]s$|(^|\/)(test|tests|__tests__|bin|scripts|e2e|examples|migrations)\//

const dirname = (file: string) => file.split("/").slice(0, -1).join("/")
function join(base: string, spec: string) {
  const out = base ? base.split("/") : []
  for (const part of spec.split("/")) {
    if (part === "..") out.pop()
    else if (part !== ".") out.push(part)
  }
  return out.join("/")
}

export function prune(files: Source[]) {
  const code = files.filter((file) => CODE.test(file.path))
  const known = new Set(code.map((file) => file.path))
  const resolve = (from: string, spec: string): string | undefined => {
    const clean = spec.replace(/\?.*$/, "")
    const alias = /^(?:@|~|#)\//.test(clean) || clean.startsWith("src/")
    if (!clean.startsWith(".") && !alias) return undefined
    const bare = clean.replace(/\.(m|c)?js$/, "")
    if (!alias) {
      const target = join(dirname(from), clean)
      for (const candidate of [target, join(dirname(from), bare)])
        for (const ext of EXTS) if (known.has(candidate + ext)) return candidate + ext
      return undefined
    }
    const tail = clean.replace(/^(?:@|~|#)\//, "").replace(/^src\//, "")
    return code.find((file) => EXTS.some((ext) => file.path.endsWith(`${tail}${ext}`) || file.path.endsWith(`${bare.replace(/^(?:@|~|#)\//, "")}${ext}`)))?.path
  }

  const exported = new Map<string, Set<string>>()
  const used = new Map<string, Set<string>>() // target file -> imported names ("*" = everything)
  const use = (file: string | undefined, name: string) => {
    if (file) used.set(file, (used.get(file) ?? new Set()).add(name))
  }
  for (const file of code) {
    const names = new Set<string>()
    const text = file.text
    for (const m of text.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|class|abstract\s+class|const|let|var|enum|interface|type)\s+(\w+)/g)) names.add(m[1])
    if (/export\s+default\b/.test(text)) names.add("default")
    for (const m of text.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}(?!\s*from)/g))
      for (const item of m[1].split(",")) {
        const name = item.trim().split(/\s+as\s+/).at(-1)?.trim()
        if (name) names.add(name)
      }
    exported.set(file.path, names)

    for (const m of text.matchAll(/(?:import|export)\s+(type\s+)?([^"'`;]*?)\s*from\s*["']([^"']+)["']/g)) {
      const target = resolve(file.path, m[3])
      const clause = m[2].trim()
      if (!target) continue
      if (clause.startsWith("*") || clause === "") {
        use(target, "*")
        continue
      }
      const braces = /\{([^}]*)\}/.exec(clause)?.[1]
      if (braces) for (const item of braces.split(",")) use(target, item.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, "").trim())
      if (/^[\w$]+(\s*,|$)/.test(clause)) use(target, "default")
      // A re-export makes the name part of this file's own API; leave the chain conservative.
      if (/^export/.test(m[0])) use(target, "*")
    }
    for (const m of text.matchAll(/(?:import\s*["']([^"']+)["'])|(?:(?:require|import)\s*\(\s*["']([^"']+)["']\s*\))/g)) use(resolve(file.path, m[1] ?? m[2]), "*")
  }

  // Path strings elsewhere (new URL("./x.ts", import.meta.url), readFile("tui/x.tsx"), package.json "main") keep a file alive.
  const strings = files.map((file) => file.text).join("\n")
  const referenced = (file: string) => {
    const base = file.split("/").at(-1) ?? file
    return new RegExp(`["'\`/]${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`).test(strings)
  }

  const unusedFiles = code.filter((file) => !used.has(file.path) && !ENTRY.test(file.path) && !referenced(file.path)).map((file) => file.path)
  const unusedExports = code.flatMap((file) => {
    if (ENTRY.test(file.path) || used.get(file.path)?.has("*")) return []
    const names = [...(exported.get(file.path) ?? [])].filter((name) => !used.get(file.path)?.has(name))
    return names.length && used.has(file.path) ? [{ file: file.path, names }] : []
  })
  return { unusedFiles, unusedExports, scanned: code.length }
}

export function formatPrune(result: ReturnType<typeof prune>) {
  const out = [`Scanned ${result.scanned} JS/TS files.`]
  out.push(result.unusedFiles.length ? `Files nothing imports (${result.unusedFiles.length}):\n${result.unusedFiles.map((file) => `  ${file}`).join("\n")}` : "No unreferenced files.")
  out.push(result.unusedExports.length ? `Exports nothing imports (${result.unusedExports.reduce((n, item) => n + item.names.length, 0)}):\n${result.unusedExports.map((item) => `  ${item.file}: ${item.names.join(", ")}`).join("\n")}` : "No unused exports.")
  out.push("Static scan only: dynamic imports with computed paths, framework file routing, package entry points, public library APIs and code used from other repositories can look unused. Verify each candidate before deleting; do not delete without the user's go-ahead.")
  return out.join("\n")
}
