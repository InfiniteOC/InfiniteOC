// Written to packages/cli/src/infiniteoc/infinitui.ts by mods/infinitui.
// Runs the Go TUI against the server the default command already resolved (private `serve --stdio`
// child or --server URL). This process stays alive as the server's lease holder; when the TUI exits,
// so does the server. Exit code 75 asks the caller to fall back to the classic OpenTUI interface.
import { spawn } from "node:child_process"
import { readFileSync, unlinkSync } from "node:fs"
import { constants, tmpdir } from "node:os"
import path from "node:path"

export const INFINITUI_FALLBACK = 75

let handedOff: string | undefined

// The session the TUI was showing when it asked for the classic UI (/classic).
export function infinituiHandoff(): string | undefined {
  return handedOff
}

export interface InfinituiOptions {
  url: string
  password?: string
  version: string
  continue?: boolean
  sessionID?: string
  newSessionID?: string
  prompt?: string
  auto?: boolean
}

export function infinituiRun(binary: string, options: InfinituiOptions): Promise<number> {
  const args: string[] = []
  if (options.continue) args.push("--continue")
  if (options.sessionID) args.push("--session", options.sessionID)
  if (options.newSessionID) args.push("--new-session", options.newSessionID)
  if (options.prompt) args.push("--prompt", options.prompt)
  if (options.auto) args.push("--auto")
  const env: Record<string, string | undefined> = {
    ...process.env,
    INFINITUI_SERVER_URL: options.url,
    INFINITUI_SERVER_PASSWORD: options.password,
    INFINITUI_OPENCODE_VERSION: options.version,
  }
  const handoff = path.join(tmpdir(), `infinitui-handoff-${process.pid}`)
  env.INFINITUI_HANDOFF = handoff
  delete env.INFINITEOC_GO_TUI
  // The password reaches the TUI only through INFINITUI_SERVER_PASSWORD, which it drops on start.
  delete env.OPENCODE_PASSWORD
  delete env.OPENCODE_SERVER_PASSWORD
  return new Promise((resolve) => {
    let settled = false
    const done = (code: number) => {
      if (settled) return
      settled = true
      for (const [signal, handler] of handlers) process.off(signal, handler)
      try {
        const [session, command] = readFileSync(handoff, "utf8").split("\n").map((line) => line.trim())
        handedOff = session || undefined
        // The classic UI runs in this process and runs this slash command once it is registered.
        if (command) process.env.INFINITEOC_CLASSIC_COMMAND = command
        unlinkSync(handoff)
      } catch {}
      resolve(code)
    }
    const child = spawn(binary, args, { stdio: "inherit", env })
    // The TUI reads keys in raw mode, so a terminal SIGINT only reaches us when something else sent it.
    // Hand termination signals to the child and let its exit decide ours.
    const handlers: [NodeJS.Signals, () => void][] = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => [
      signal,
      () => {
        if (signal !== "SIGINT") child.kill(signal)
      },
    ])
    for (const [signal, handler] of handlers) process.on(signal, handler)
    child.on("error", () => done(INFINITUI_FALLBACK))
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)))
  })
}
