// Run a project command the way a user would (sh -c in the project directory) with a time limit and bounded output.
import { spawn } from "node:child_process"

export interface RunResult {
  exit: number | undefined
  output: string
  ms: number
  timedOut: boolean
}

export function run(command: string, cwd: string, timeoutMs = 120_000, maxOutput = 400_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const windows = process.platform === "win32"
    const child = spawn(windows ? "cmd" : "sh", windows ? ["/d", "/s", "/c", command] : ["-c", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: !windows })
    let output = ""
    let timedOut = false
    const take = (chunk: Buffer) => {
      if (output.length < maxOutput) output += chunk.toString("utf8")
    }
    child.stdout.on("data", take)
    child.stderr.on("data", take)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        windows ? child.kill("SIGKILL") : process.kill(-child.pid!, "SIGKILL")
      } catch {}
    }, timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ exit: undefined, output: String(error), ms: Date.now() - started, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ exit: timedOut ? undefined : (code ?? undefined), output, ms: Date.now() - started, timedOut })
    })
  })
}

export const tail = (text: string, lines = 25) => text.trimEnd().split("\n").slice(-lines).join("\n")
