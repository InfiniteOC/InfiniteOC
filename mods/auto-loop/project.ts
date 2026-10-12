// InfiniteOC autonomy: the file and process side of the agent-loop features.
// Written to packages/core/src/plugin/infiniteoc-auto-project.ts by mods/auto-loop.
import { execFile, spawn } from "child_process"
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { homedir } from "os"
import path from "path"
import { applySetting, detectCheck, goalTemplate, normalizeSettings, tail, type CheckKind, type Project, type Settings } from "./infiniteoc-auto-logic.js"

export const settingsFile = () => process.env.INFINITEOC_SETTINGS_FILE || path.join(homedir(), ".config/infiniteoc/settings.json")

const readJson = (file: string): Record<string, any> => {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"))
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** The `autonomy` section of the InfiniteOC settings file, with defaults. Read per use, so edits apply at once. */
export const readSettings = (): Settings => normalizeSettings(readJson(settingsFile()).autonomy)

/** Applies one /auto change, keeping every other key in the file. */
export function changeSetting(key: string, value: string): { settings: Settings } | { error: string } {
  const file = settingsFile()
  const root = readJson(file)
  const result = applySetting(root.autonomy && typeof root.autonomy === "object" ? root.autonomy : {}, key, value)
  if ("error" in result) return result
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ ...root, autonomy: result.next }, null, 2) + "\n", { mode: 0o600 })
  renameSync(temp, file)
  return { settings: normalizeSettings(result.next) }
}

const macroFile = () => path.join(path.dirname(settingsFile()), "macros.json")
export const readMacros = (): Record<string, string[]> => {
  const raw = readJson(macroFile())
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => Array.isArray(value) && value.every((item) => typeof item === "string"))) as Record<string, string[]>
}
export function writeMacros(macros: Record<string, string[]>) {
  const file = macroFile()
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(macros, null, 2) + "\n", { mode: 0o600 })
  renameSync(temp, file)
}

export function loadProject(dir: string): Project {
  let files: string[] = []
  try {
    files = readdirSync(dir)
  } catch {}
  return { files, read: (name) => (files.includes(name) ? readFileSync(path.join(dir, name), "utf8") : undefined) }
}

export const projectCheck = (dir: string, kind: CheckKind = "check") => detectCheck(loadProject(dir), kind)

/** Runs a shell command in dir; kills the whole process group on timeout. Output is the tail of stdout and stderr. */
export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let output = ""
    let timedOut = false
    const child = spawn(process.env.SHELL || "/bin/sh", ["-c", command], { cwd, env: { ...process.env, CI: "1", NO_COLOR: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    const add = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-40_000)
    }
    child.stdout.on("data", add)
    child.stderr.on("data", add)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {}
    }, timeoutMs)
    const done = (code: number | null) => {
      clearTimeout(timer)
      resolve({ code, output: tail(output.trim()), timedOut })
    }
    child.on("error", (error) => {
      output += String(error)
      done(null)
    })
    child.on("close", done)
  })
}

/** Uncommitted changes against HEAD, capped, plus the names of untracked files; empty when not a repo or nothing changed. */
export function gitDiff(cwd: string, max = 60_000): Promise<string> {
  const git = (args: string[]) =>
    new Promise<string>((resolve) => execFile("git", ["--no-pager", ...args], { cwd, timeout: 20_000, maxBuffer: 8_000_000 }, (error, stdout) => resolve(error ? "" : stdout)))
  return Promise.all([git(["diff", "HEAD", "--no-color"]), git(["ls-files", "--others", "--exclude-standard"])]).then(([diff, untracked]) => {
    const body = diff.length > max ? diff.slice(0, max) + "\n...(diff truncated)" : diff
    const files = untracked.trim()
    return [body.trim(), files && `Untracked new files:\n${files}`].filter(Boolean).join("\n\n")
  })
}

/** `/goal tests|types|lint` becomes a goal with the project's detected command; other goals pass through. */
export const expandGoal = (goal: string, dir: string) => {
  const kind = goal.trim().toLowerCase() as CheckKind
  return goalTemplate(goal, kind === "tests" || kind === "types" || kind === "lint" ? projectCheck(dir, kind) : undefined) ?? goal
}
