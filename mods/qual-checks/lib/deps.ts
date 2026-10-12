// Dependency guard: which packages did a manifest edit add, and what do we know about them offline.
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

export interface Dep {
  name: string
  spec: string
  kind: string
}
const KINDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]

export function parseDeps(file: string, text: string | undefined): Dep[] {
  if (!text) return []
  if (file.endsWith("package.json")) {
    try {
      const json = JSON.parse(text)
      return KINDS.flatMap((kind) => Object.entries<string>(json[kind] ?? {}).map(([name, spec]) => ({ name, spec: String(spec), kind })))
    } catch {
      return []
    }
  }
  if (/requirements[^/]*\.txt$/.test(file))
    return text.split("\n").flatMap((line) => {
      const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*([<>=!~].*)?$/.exec(line.replace(/#.*/, ""))
      return m ? [{ name: m[1], spec: (m[2] ?? "").trim() || "*", kind: "requirements" }] : []
    })
  return []
}

export const addedDeps = (file: string, before: string | undefined, after: string) => {
  const had = new Set(parseDeps(file, before).map((dep) => dep.name))
  return parseDeps(file, after).filter((dep) => !had.has(dep.name))
}

function dirSize(dir: string, budget = { files: 20000 }): number {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (budget.files-- <= 0) return total
    const full = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== "node_modules") total += dirSize(full, budget)
    else if (entry.isFile()) total += statSync(full).size
  }
  return total
}

const human = (bytes: number) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`)

/** Offline facts from node_modules; `released` only when the registry was consulted. */
export function inspectInstalled(root: string, name: string) {
  try {
    const dir = path.join(root, "node_modules", name)
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
    const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l: { type: string }) => l.type).join(" OR ") : "none declared")
    return { version: pkg.version as string, license, size: dirSize(dir), deps: Object.keys(pkg.dependencies ?? {}).length }
  } catch {
    return undefined
  }
}

export async function registryInfo(name: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, { signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error(`registry returned ${response.status}`)
  const json = (await response.json()) as { "dist-tags"?: { latest?: string }; time?: Record<string, string>; license?: string }
  const latest = json["dist-tags"]?.latest
  return { latest, released: latest ? json.time?.[latest]?.slice(0, 10) : undefined, license: json.license }
}

export async function describeAdded(root: string, deps: Dep[], network: boolean) {
  const lines: string[] = []
  for (const dep of deps) {
    const local = inspectInstalled(root, dep.name)
    const parts = [`${dep.name}@${dep.spec} (${dep.kind})`]
    if (local) parts.push(`installed ${local.version}`, `${human(local.size)} on disk`, `license ${local.license}`, `${local.deps} direct dependencies`)
    else parts.push("not installed yet: size and license unknown offline")
    if (network && !dep.kind.startsWith("requirements"))
      parts.push(await registryInfo(dep.name).then((info) => `latest ${info.latest}, released ${info.released ?? "unknown"}`, (error) => `registry lookup failed: ${error.message}`))
    lines.push(`  ${parts.join("; ")}`)
  }
  return lines.join("\n")
}
