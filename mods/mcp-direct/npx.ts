// InfiniteOC mcp-direct: an MCP server configured as `npx -y pkg@1.2.3 ...` runs the package's program straight
// from npx's own cache once npx has installed it there. npx would run the same files, but through an `npm exec`
// process that stays alive for the server's whole life (~130 MB) and adds ~0.4 s before the server starts.
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Exact versions only: a tag or range (`@latest`, `^1`) makes npx ask the registry, which this cannot answer.
const SPEC = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/i

export type Direct = { readonly command: string; readonly args: string[]; readonly bin: string }

/** npm's cache folder: `npm_config_cache`, else its default. A cache set only in an .npmrc is not found, and npx runs. */
export function npmCache(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  return env.npm_config_cache || env.NPM_CONFIG_CACHE || path.join(home, ".npm")
}

/** The cached program npx would run for `command args`, or undefined when npx has to decide (anything unusual). */
export function resolve(command: string, args: readonly string[], cache = npmCache()): Direct | undefined {
  if (process.platform === "win32" || path.basename(command) !== "npx") return undefined
  let index = 0
  while (args[index] === "-y" || args[index] === "--yes") index++
  const spec = args[index]
  const match = spec ? SPEC.exec(spec) : null
  if (!match) return undefined
  const [, name, version] = match
  // libnpmexec names the folder after the requested specs: sha512 of them, sorted and joined by newlines.
  const dir = path.join(cache, "_npx", createHash("sha512").update(spec).digest("hex").slice(0, 16), "node_modules")
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, name, "package.json"), "utf8"))
    if (manifest.name !== name || manifest.version !== version) return undefined
    const bins: Record<string, string> =
      typeof manifest.bin === "string" ? { [name.split("/").pop()!]: manifest.bin } : (manifest.bin ?? {})
    const names = Object.keys(bins)
    // npx's choice: the only program, or the one named after the package. Several pointing at one file are one.
    const unscoped = name.split("/").pop()!
    const chosen =
      new Set(Object.values(bins).map((file) => path.normalize(file))).size === 1 ? names[0] : bins[unscoped] && unscoped
    if (!chosen) return undefined
    const bin = path.join(dir, ".bin")
    const program = path.join(bin, chosen)
    if (!existsSync(program)) return undefined
    return { command: program, args: args.slice(index + 1), bin }
  } catch {
    return undefined
  }
}

/** The environment npx gives its program that matters to it: its own .bin first on PATH. */
export function environment(direct: Direct, declared: Record<string, string>, host = process.env.PATH ?? "") {
  return { ...declared, PATH: [direct.bin, declared.PATH ?? host].filter(Boolean).join(path.delimiter) }
}
