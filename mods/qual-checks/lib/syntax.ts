// Parse a file right after a write, edit or patch, so a file that no longer parses is reported on the call
// that broke it. Upstream v2 has no post-edit diagnostics yet. Syntax only: no types, imports or lint. JS and
// TS go through the runtime's own transpiler (Bun's, so nothing is installed); JSON is parsed leniently.

type Loader = "jsx" | "ts" | "tsx"
// .js parses as JSX: many React projects keep JSX in .js files, and JSX is a superset of plain JS.
const LOADERS: Record<string, Loader> = { ".js": "jsx", ".mjs": "jsx", ".cjs": "jsx", ".jsx": "jsx", ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx" }

export type Transpile = (loader: Loader, text: string) => void

/** Bun's transpiler, or undefined outside Bun. */
export const bunTranspile: Transpile | undefined = (globalThis as { Bun?: any }).Bun?.Transpiler
  ? (loader, text) => void new (globalThis as { Bun?: any }).Bun.Transpiler({ loader }).transformSync(text)
  : undefined

const extension = (file: string) => /\.[^./\\]+$/.exec(file)?.[0].toLowerCase() ?? ""

/** True for files this check parses. */
export const checkable = (file: string) => extension(file) === ".json" || extension(file) in LOADERS

/** JSON with comments and trailing commas, as tsconfig, VS Code and other tools accept. */
function lenientJson(text: string) {
  try {
    JSON.parse(text)
    return
  } catch {}
  let out = "", inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      out += char
      if (char === "\\") out += text[++i] ?? ""
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      out += text.slice(i, end === -1 ? text.length : end + 2).replace(/[^\n]/g, " ")
      i = end === -1 ? text.length : end + 1
    } else out += char
  }
  try {
    JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function location(error: unknown) {
  const first = (error as { errors?: unknown[] })?.errors?.[0] ?? error
  const position = (first as { position?: { line?: number; lineText?: string } })?.position
  const message = (first as { message?: string })?.message ?? (error instanceof Error ? error.message : String(error))
  return { message, line: position?.line, text: position?.lineText?.trim() }
}

/** A short model-facing note when the saved file does not parse, or undefined. */
export function syntaxProblem(name: string, text: string, transpile: Transpile | undefined = bunTranspile): string | undefined {
  const ext = extension(name)
  let message: string | undefined, line: number | undefined, snippet: string | undefined
  if (ext === ".json") {
    if (!text.trim()) return undefined
    message = lenientJson(text)
  } else {
    const loader = LOADERS[ext]
    // Flow annotations are not TypeScript; such files would always look broken.
    if (!loader || !transpile || /@flow\b/.test(text.slice(0, 2000))) return undefined
    try {
      transpile(loader, text)
    } catch (error) {
      ;({ message, line, text: snippet } = location(error))
    }
  }
  if (!message) return undefined
  const where = line ? ` at line ${line}${snippet ? ` (\`${snippet.length > 80 ? `${snippet.slice(0, 77)}...` : snippet}\`)` : ""}` : ""
  return `Syntax check: ${name} does not parse: ${message}${where}. The file was saved as written; fix it before anything else uses it.`
}
