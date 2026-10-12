// Per-project cache for baselines (screenshots, coverage, benchmark) and the optional project config.
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const projectDir = (cwd: string, env: Record<string, string | undefined> = process.env) =>
  path.join(env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "infiniteoc", "quality", createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 16))

/** Baselines older than this are replaced rather than compared: a stale "before" says nothing about this change. */
export const FRESH_HOURS = 12

export function readBaseline(file: string): Buffer | undefined {
  try {
    return Date.now() - statSync(file).mtimeMs < FRESH_HOURS * 3600_000 ? readFileSync(file) : undefined
  } catch {
    return undefined
  }
}

export function writeBaseline(file: string, data: string | Buffer) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, data)
}

export const readJson = <T>(file: string): T | undefined => {
  const raw = readBaseline(file)
  try {
    return raw ? (JSON.parse(raw.toString("utf8")) as T) : undefined
  } catch {
    return undefined
  }
}

export interface Config {
  bench?: { command?: string; tolerancePct?: number; runs?: number }
  network?: boolean
}

/** Optional `.infiniteoc/quality.json` in the project: { "bench": { "command": "npm run bench", "tolerancePct": 15 }, "network": false }. */
export function readConfig(cwd: string): Config {
  try {
    return JSON.parse(readFileSync(path.join(cwd, ".infiniteoc", "quality.json"), "utf8"))
  } catch {
    return {}
  }
}

export const networkAllowed = (cwd: string, env: Record<string, string | undefined> = process.env) =>
  env.INFINITEOC_QUALITY_NETWORK === "1" || readConfig(cwd).network === true
