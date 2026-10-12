// InfiniteOC context knowledge: the read-only lookups behind the ctx tools. Pure node module (no upstream
// imports) so node --test can exercise it; mods/ctx-context writes it to
// packages/core/src/plugin/infiniteoc-ctx-knowledge.ts. Nothing here writes outside the data directory.
import { execFileSync } from "node:child_process"
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

const read = (file: string) => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".next", ".venv", "venv", "__pycache__", "vendor", "coverage", ".turbo", ".cache", ".runtime", ".upstream"])

/** Tracked files (git), else a bounded walk. Relative paths, sorted. */
export function listFiles(root: string, limit = 20_000): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 })
    return out.toString().split("\0").filter(Boolean).filter((file) => existsSync(path.join(root, file))).slice(0, limit).sort()
  } catch {
    const found: string[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > 8 || found.length >= limit) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") && entry.isDirectory()) continue
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), depth + 1)
        } else if (entry.isFile()) found.push(path.relative(root, path.join(dir, entry.name)))
      }
    }
    walk(root, 0)
    return found.sort()
  }
}

// --- machine profile -------------------------------------------------------------------------------

const TOOLS: ReadonlyArray<readonly [string, string, string[]]> = [
  ["node", "node", ["-v"]], ["bun", "bun", ["-v"]], ["deno", "deno", ["-v"]], ["npm", "npm", ["-v"]], ["pnpm", "pnpm", ["-v"]],
  ["python", "python3", ["-V"]], ["go", "go", ["version"]], ["rust", "rustc", ["-V"]], ["git", "git", ["--version"]],
]
const WEEK = 7 * 24 * 3600 * 1000

/** One line naming the detected tool versions; probed once and cached for a week under the data directory. */
export function machineProfile(cache: string, now = Date.now()): string {
  let found: Record<string, string | null> | undefined
  try {
    const saved = JSON.parse(readFileSync(cache, "utf8"))
    if (now - saved.at < WEEK && saved.tools) found = saved.tools
  } catch {}
  if (!found) {
    found = {}
    for (const [label, bin, args] of TOOLS) {
      try {
        const out = execFileSync(bin, args, { timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }).toString()
        found[label] = /\d+\.\d+(?:\.\d+)?/.exec(out)?.[0] ?? null
      } catch {
        found[label] = null
      }
    }
    try {
      mkdirSync(path.dirname(cache), { recursive: true })
      writeFileSync(cache, JSON.stringify({ at: now, tools: found }))
    } catch {}
  }
  const have = Object.entries(found).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`)
  const missing = Object.entries(found).filter(([, v]) => !v).map(([k]) => k)
  return `Installed tools on this machine: ${have.join(", ") || "none detected"}${missing.length ? `. Not installed: ${missing.join(", ")}` : ""}.`
}

// --- library versions ------------------------------------------------------------------------------

const MAX_LIBS = 40

/** Main dependencies with the version actually installed (node_modules, Cargo.lock) or declared. */
export function libraries(root: string): string | undefined {
  const lines: string[] = []
  const pkg = read(path.join(root, "package.json"))
  if (pkg) {
    try {
      const manifest = JSON.parse(pkg)
      const names = [...Object.entries<string>(manifest.dependencies ?? {}), ...Object.entries<string>(manifest.devDependencies ?? {})]
      lines.push(
        ...names.slice(0, MAX_LIBS).map(([name, range]) => {
          const installed = read(path.join(root, "node_modules", name, "package.json"))
          const version = installed ? (JSON.parse(installed).version as string) : undefined
          return version ? `${name} ${version}` : `${name} ${range} (declared, not installed)`
        }),
      )
    } catch {}
  }
  const mod = read(path.join(root, "go.mod"))
  if (mod) {
    const requires = [...mod.matchAll(/^\s*(?:require\s+)?([\w.\-/]+\.[\w.\-/]+)\s+(v[\w.+-]+)\s*$/gm)].filter((m) => !/\/\/ indirect/.test(m[0]))
    lines.push(...requires.slice(0, MAX_LIBS).map((m) => `${m[1]} ${m[2]}`))
  }
  const cargo = read(path.join(root, "Cargo.toml"))
  if (cargo) {
    const lock = new Map([...(read(path.join(root, "Cargo.lock")) ?? "").matchAll(/name = "([^"]+)"\nversion = "([^"]+)"/g)].map((m) => [m[1], m[2]]))
    const section = /\[dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(cargo)?.[1] ?? ""
    for (const m of section.matchAll(/^([\w-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) lines.push(`${m[1]} ${lock.get(m[1]) ?? m[2] ?? m[3]}`)
  }
  const requirements = read(path.join(root, "requirements.txt"))
  if (requirements) for (const m of requirements.matchAll(/^([A-Za-z0-9_.-]+)\s*(==|>=|~=|<=)\s*([\w.]+)/gm)) lines.push(`${m[1]} ${m[2] === "==" ? "" : m[2]}${m[3]}`)
  if (!lines.length) return undefined
  return `Dependency versions in this project (installed where known; check these before using an API from memory): ${lines.slice(0, MAX_LIBS * 2).join(", ")}.`
}

// --- repo map --------------------------------------------------------------------------------------

const CODE = /\.(tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|c|h|cc|cpp|hpp|lua|sh)$/
const SYMBOLS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/\.(tsx?|jsx?|mjs|cjs)$/, /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace|const|let|var)\s+([A-Za-z_$][\w$]*)/],
  [/\.py$/, /^(?:async\s+)?(?:def|class)\s+(\w+)/],
  [/\.go$/, /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+|var\s+|const\s+)(\w+)/],
  [/\.rs$/, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod|const|static|type)\s+(\w+)/],
  [/./, /^\s*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|final\s+|sealed\s+|open\s+|data\s+)*(?:class|interface|enum|struct|object|trait|module|def|func|fun|function)\s+(\w+)/],
]

export function symbolsOf(file: string, text: string): string[] {
  const pattern = SYMBOLS.find(([ext]) => ext.test(file))?.[1]
  if (!pattern) return []
  const names = new Set<string>()
  for (const line of text.split("\n")) {
    const name = pattern.exec(line)?.[1]
    if (name) names.add(name)
    if (names.size >= 40) break
  }
  return [...names]
}

type MapCache = Record<string, [number, number, string[]]>

/** Files and their top-level symbols; unchanged files come from the cache file (keyed by mtime and size). */
export function repoMap(root: string, cacheFile: string, options: { path?: string; query?: string; maxChars?: number } = {}) {
  let cache: MapCache = {}
  try {
    cache = JSON.parse(readFileSync(cacheFile, "utf8"))
  } catch {}
  const prefix = (options.path ?? "").replace(/^\.\//, "").replace(/\/$/, "")
  const query = options.query?.toLowerCase()
  const fresh: MapCache = {}
  const lines: string[] = []
  let files = 0
  for (const file of listFiles(root)) {
    if (!CODE.test(file) || (prefix && file !== prefix && !file.startsWith(`${prefix}/`))) continue
    let info
    try {
      info = statSync(path.join(root, file))
    } catch {
      continue
    }
    if (info.size > 300 * 1024) continue
    const hit = cache[file]
    const symbols = hit && hit[0] === info.mtimeMs && hit[1] === info.size ? hit[2] : symbolsOf(file, read(path.join(root, file)) ?? "")
    fresh[file] = [info.mtimeMs, info.size, symbols]
    files += 1
    if (query && !file.toLowerCase().includes(query) && !symbols.some((s) => s.toLowerCase().includes(query))) continue
    lines.push(symbols.length ? `${file}: ${symbols.join(", ")}` : file)
  }
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(fresh))
  } catch {}
  const limit = options.maxChars ?? 14_000
  let used = 0
  const shown = lines.filter((line) => (used += line.length + 1) <= limit)
  const note = shown.length < lines.length ? `\n(${lines.length - shown.length} more files not shown; pass path or query to narrow.)` : ""
  return `${shown.length ? shown.join("\n") : "No matching files."}${note}\n[${files} code files indexed]`
}

// --- stack traces ----------------------------------------------------------------------------------

export interface Frame { file: string; line: number; text: string }
const FRAME_PATTERNS: RegExp[] = [
  /\bat\s+(?:.*?\s+\()?((?:file:\/\/)?[^\s()]+?\.[A-Za-z]{1,5}):(\d+)(?::\d+)?\)?/, // JS/TS, Bun, Node, Deno
  /File "([^"]+)", line (\d+)/, // Python
  /^\s*(\S+\.go):(\d+)/, // Go
  /(?:-->|at)\s+(\S+\.rs):(\d+)(?::\d+)?/, // Rust
  /\(([\w$]+\.(?:java|kt|scala|cs)):(\d+)\)/, // JVM, .NET by bare file name
  /([^\s:()'"]+\.(?:tsx?|jsx?|mjs|py|rb|php|go|rs|java|kt|c|cc|cpp|h|swift)):(\d+)/, // anything path:line
]

export function parseFrames(text: string): Frame[] {
  const frames: Frame[] = []
  for (const raw of text.split("\n")) {
    for (const pattern of FRAME_PATTERNS) {
      const m = pattern.exec(raw)
      if (!m) continue
      frames.push({ file: m[1].replace(/^file:\/\//, ""), line: Number(m[2]), text: raw.trim() })
      break
    }
  }
  return frames
}

/** Maps trace frames to files in the project, with the surrounding source lines. */
export function lookupTrace(root: string, trace: string, context = 2, maxFrames = 12) {
  const frames = parseFrames(trace).slice(0, maxFrames * 3)
  let all: string[] | undefined
  const files = () => (all ??= listFiles(root))
  const out: string[] = []
  const seen = new Set<string>()
  for (const frame of frames) {
    if (out.length >= maxFrames) break
    const key = `${frame.file}:${frame.line}`
    if (seen.has(key)) continue
    seen.add(key)
    if (/(^|\/)node_modules\/|^node:|^\/\$bunfs\//.test(frame.file)) {
      out.push(`${key}  (dependency or runtime, not project code)`)
      continue
    }
    let resolved: string | undefined
    let ambiguous: string[] = []
    const direct = path.isAbsolute(frame.file) ? frame.file : path.join(root, frame.file)
    if (existsSync(direct) && statSync(direct).isFile()) resolved = direct
    else {
      const segments = frame.file.split("/").filter(Boolean)
      // Longest matching path suffix among project files (paths from CI, containers or other machines).
      for (let n = Math.min(segments.length, 6); n >= 1; n--) {
        const tail = segments.slice(-n).join("/")
        const matches = files().filter((file) => file === tail || file.endsWith(`/${tail}`))
        if (matches.length === 1) resolved = path.join(root, matches[0])
        else if (matches.length > 1) ambiguous = matches
        if (matches.length) break
      }
    }
    if (ambiguous.length) {
      out.push(`${key}  ambiguous: ${ambiguous.slice(0, 5).join(", ")}`)
      continue
    }
    if (!resolved) {
      out.push(`${key}  not found in this project`)
      continue
    }
    const lines = (read(resolved) ?? "").split("\n")
    const from = Math.max(1, frame.line - context)
    const to = Math.min(lines.length, frame.line + context)
    const snippet = lines.slice(from - 1, to).map((l, i) => `${from + i === frame.line ? ">" : " "} ${String(from + i).padStart(5)}  ${l}`).join("\n")
    out.push(`${path.relative(root, resolved)}:${frame.line}${lines.length < frame.line ? "  (file is shorter than this line: it changed since the trace)" : ""}\n${snippet}`)
  }
  return out.length ? out.join("\n\n") : "No file:line frames recognized in that text."
}

// --- type definitions and docs ---------------------------------------------------------------------

function* walkTyped(dir: string, depth = 0): Generator<string> {
  if (depth > 5) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") yield* walkTyped(full, depth + 1)
    } else if (/\.d\.[cm]?ts$/.test(entry.name)) yield full
  }
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Declaration block starting at line index `start`, until braces balance (or a statement ends). */
function block(lines: string[], start: number, max = 50) {
  let depth = 0
  let seen = false
  const out: string[] = []
  for (let i = start; i < lines.length && out.length < max; i++) {
    out.push(lines[i])
    for (const ch of lines[i].replace(/\/\/.*$/, "")) {
      if (ch === "{") (depth++, (seen = true))
      else if (ch === "}") depth--
    }
    if (seen ? depth <= 0 : /;\s*$/.test(lines[i])) break
  }
  return out.join("\n")
}

/** Looks up a type or function by name in node_modules/@types, the named package, and configured docs folders. */
export function lookupTypes(root: string, options: { name: string; pkg?: string; docs?: string[]; limit?: number }) {
  const limit = options.limit ?? 6
  const name = options.name.trim()
  if (!/^[\w$.]+$/.test(name)) throw new Error("name must be an identifier such as Request or useState")
  const last = name.split(".").pop() as string
  const declaration = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|const|let|var|enum|namespace)\\s+${escape(last)}\\b`)
  const member = new RegExp(`^\\s{2,}(?:readonly\\s+|static\\s+|public\\s+)*${escape(last)}\\??\\s*[:(<]`)
  const modules = path.join(root, "node_modules")
  const roots: string[] = []
  if (options.pkg) {
    roots.push(path.join(modules, options.pkg))
    roots.push(path.join(modules, "@types", options.pkg.replace(/^@/, "").replace("/", "__")))
  } else {
    try {
      for (const dir of readdirSync(path.join(modules, "@types"))) roots.push(path.join(modules, "@types", dir))
    } catch {}
    const manifest = read(path.join(root, "package.json"))
    try {
      for (const dep of Object.keys({ ...JSON.parse(manifest ?? "{}").dependencies, ...JSON.parse(manifest ?? "{}").devDependencies })) roots.push(path.join(modules, dep))
    } catch {}
  }
  const hits: string[] = []
  const seen = new Set<string>()
  let scanned = 0
  for (const dir of roots) {
    for (const file of walkTyped(dir)) {
      if (hits.length >= limit || scanned++ > 1500) break
      if (seen.has(file)) continue
      seen.add(file)
      const text = read(file)
      if (!text || text.length > 800_000 || !text.includes(last)) continue
      const lines = text.split("\n")
      const decl = lines.findIndex((line) => declaration.test(line))
      const at = decl >= 0 ? decl : lines.findIndex((line) => member.test(line))
      if (at >= 0) hits.push(`${path.relative(root, file)}:${at + 1}\n${block(lines, at)}`)
    }
  }
  for (const dir of options.docs ?? []) {
    const word = new RegExp(`\\b${escape(last)}\\b`, "i")
    const walk = (current: string, depth: number) => {
      if (depth > 4 || hits.length >= limit * 2) return
      let entries
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) entry.name !== "node_modules" && !entry.name.startsWith(".") && walk(full, depth + 1)
        else if (/\.(md|mdx|txt|rst)$/.test(entry.name) && statSync(full).size < 500_000) {
          const lines = (read(full) ?? "").split("\n")
          const at = lines.findIndex((line) => word.test(line))
          if (at >= 0) hits.push(`${full}:${at + 1}\n${lines.slice(Math.max(0, at - 1), at + 5).join("\n")}`)
        }
      }
    }
    walk(dir, 0)
  }
  return hits.length ? hits.join("\n\n") : `No definition of ${name} found${options.pkg ? ` in ${options.pkg}` : " in node_modules/@types, dependencies or the configured docs"}.`
}

// --- log tail --------------------------------------------------------------------------------------

/** Last `lines` lines of a file (default 100, at most 500 and 64 KB), optionally only lines containing `match`. */
export function tailFile(file: string, options: { lines?: number; match?: string } = {}) {
  const fd = openSync(file, "r")
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, 256 * 1024)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    let all = buffer.toString("utf8").split("\n")
    if (size > length) all = all.slice(1)
    if (all.at(-1) === "") all.pop()
    const needle = options.match?.toLowerCase()
    if (needle) all = all.filter((line) => line.toLowerCase().includes(needle))
    let text = all.slice(-Math.min(Math.max(options.lines ?? 100, 1), 500)).join("\n")
    if (text.length > 64 * 1024) text = text.slice(-64 * 1024)
    return `${text || "(no matching lines)"}\n[${file}: ${size} bytes, modified ${statSync(file).mtime.toISOString()}]`
  } finally {
    closeSync(fd)
  }
}

// --- read-only SQL ---------------------------------------------------------------------------------

const PRAGMAS = /^pragma\s+(table_info|table_xinfo|table_list|index_list|index_info|index_xinfo|foreign_key_list|database_list|collation_list|schema_version|user_version|page_count|freelist_count|integrity_check|quick_check)\b/i

/** Throws unless the SQL is one read-only statement: SELECT, WITH, EXPLAIN, or an introspection PRAGMA. */
export function assertReadOnlySql(sql: string) {
  const clean = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim().replace(/;+\s*$/, "")
  if (!clean) throw new Error("Empty SQL.")
  if (clean.includes(";")) throw new Error("Only one statement is allowed.")
  if (!/^(select|with|explain|values)\b/i.test(clean) && !PRAGMAS.test(clean)) throw new Error("Read-only: only SELECT, WITH, EXPLAIN and introspection PRAGMAs are allowed.")
  if (/\b(attach|detach|load_extension|vacuum|insert|update|delete|drop|alter|create|replace|reindex)\b/i.test(clean.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''")))
    throw new Error("Read-only: statement contains a write or schema keyword.")
  return clean
}

type Db = { prepare(sql: string): { all(): Record<string, unknown>[] }; close(): void }
async function openReadOnly(file: string): Promise<Db> {
  // The compiled binary runs on Bun; node --test and plain node use node:sqlite.
  if ((globalThis as { Bun?: unknown }).Bun) {
    const { Database } = (await import("bun:sqlite")) as unknown as { Database: new (file: string, options: { readonly: boolean }) => Db }
    return new Database(file, { readonly: true })
  }
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => Db }
  return new DatabaseSync(file, { readOnly: true })
}

export async function queryReadOnly(file: string, sql: string, limit = 50) {
  const statement = !sql.trim() || sql.trim() === "schema" ? "select type, name, sql from sqlite_master where name not like 'sqlite_%' order by type, name" : assertReadOnlySql(sql)
  if (!existsSync(file)) throw new Error(`Database file not found: ${file}`)
  const db = await openReadOnly(file)
  try {
    const cap = Math.min(Math.max(limit, 1), 200)
    const rows = db.prepare(statement).all().slice(0, cap + 1)
    const shown = rows.slice(0, cap).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}...` : typeof v === "bigint" ? Number(v) : v])))
    return `${shown.map((row) => JSON.stringify(row)).join("\n") || "(no rows)"}${rows.length > cap ? `\n(limited to ${cap} rows)` : ""}`
  } finally {
    db.close()
  }
}

// --- OpenAPI ---------------------------------------------------------------------------------------

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]

export function loadSpec(file: string) {
  const text = readFileSync(file, "utf8")
  if (/\.ya?ml$/i.test(file)) {
    const yaml = (globalThis as { Bun?: { YAML?: { parse(text: string): unknown } } }).Bun?.YAML
    if (!yaml) throw new Error("YAML specs need the Bun runtime; convert the spec to JSON.")
    return yaml.parse(text) as Record<string, any>
  }
  return JSON.parse(text) as Record<string, any>
}

const deref = (spec: Record<string, any>, node: any, depth = 0): any => {
  if (!node || typeof node !== "object" || depth > 4) return node
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/"))
    return deref(spec, node.$ref.slice(2).split("/").reduce((value: any, key: string) => value?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec), depth + 1)
  return Array.isArray(node) ? node.map((item) => deref(spec, item, depth)) : Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(spec, v, depth)]))
}

/** Without `operation`: matching "METHOD /path - summary" lines. With "GET /path": parameters, body and responses. */
export function lookupOpenApi(spec: Record<string, any>, options: { query?: string; operation?: string }) {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, any>>
  if (options.operation) {
    const [method, ...rest] = options.operation.trim().split(/\s+/)
    const target = rest.join(" ")
    const item = paths[target]?.[method.toLowerCase()]
    if (!item) throw new Error(`No operation ${options.operation}. Search with a query first.`)
    const shape = deref(spec, { parameters: [...(paths[target].parameters ?? []), ...(item.parameters ?? [])], requestBody: item.requestBody, responses: item.responses })
    return `${method.toUpperCase()} ${target}${item.summary ? ` - ${item.summary}` : ""}${item.description ? `\n${item.description}` : ""}\n${JSON.stringify(shape, null, 1).slice(0, 8000)}`
  }
  const query = options.query?.toLowerCase()
  const lines = Object.entries(paths).flatMap(([route, item]) =>
    METHODS.filter((method) => item[method]).map((method) => `${method.toUpperCase()} ${route}${item[method].summary ? ` - ${item[method].summary}` : ""}${item[method].operationId ? ` [${item[method].operationId}]` : ""}`),
  ).filter((line) => !query || line.toLowerCase().includes(query))
  const head = `${spec.info?.title ?? "API"} ${spec.info?.version ?? ""} (${lines.length} endpoints${query ? ` matching "${options.query}"` : ""})`
  return `${head}\n${lines.slice(0, 120).join("\n")}${lines.length > 120 ? `\n(${lines.length - 120} more; pass a query)` : ""}`
}

// --- linked repositories ---------------------------------------------------------------------------

/** Read-only access to a linked repo: list a directory, read a file range, or grep for a literal. */
export function inspectRepo(repo: string, options: { path?: string; grep?: string; offset?: number; limit?: number }) {
  const target = path.resolve(repo, options.path ?? ".")
  if (target !== repo && !target.startsWith(`${repo}${path.sep}`)) throw new Error("Path escapes the linked repository.")
  const info = statSync(target)
  if (options.grep) {
    const needle = options.grep.toLowerCase()
    const hits: string[] = []
    const base = info.isDirectory() ? target : path.dirname(target)
    for (const file of info.isDirectory() ? listFiles(target) : [path.basename(target)]) {
      if (hits.length >= 60) break
      const full = path.join(base, file)
      let size = 0
      try {
        size = statSync(full).size
      } catch {}
      if (size > 400_000) continue
      const text = read(full)
      if (!text || text.includes("\0")) continue
      text.split("\n").forEach((line, i) => {
        if (hits.length < 60 && line.toLowerCase().includes(needle)) hits.push(`${path.relative(repo, full)}:${i + 1}: ${line.trim().slice(0, 200)}`)
      })
    }
    return hits.join("\n") || "No matches."
  }
  if (info.isDirectory())
    return readdirSync(target, { withFileTypes: true }).filter((e) => e.name !== ".git" && e.name !== "node_modules").map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join("\n")
  if (info.size > 2_000_000) throw new Error("File too large; grep it or read a smaller file.")
  const text = read(target) ?? ""
  if (text.includes("\0")) throw new Error("Binary file.")
  const lines = text.split("\n")
  const from = Math.max(1, options.offset ?? 1)
  return lines.slice(from - 1, from - 1 + Math.min(options.limit ?? 400, 1000)).map((line, i) => `${from + i}: ${line}`).join("\n")
}

// --- @url mentions ---------------------------------------------------------------------------------

const URL_MENTION = /(?:^|\s)@(https?:\/\/[^\s<>"'`]+)/g

/** @https://... tokens in prompt text, trailing punctuation removed, at most three. */
export function urlMentions(text: string) {
  const urls = [...text.matchAll(URL_MENTION)].map((match) => match[1].replace(/[.,;:!?)\]}]+$/, ""))
  return [...new Set(urls)].slice(0, 3)
}
