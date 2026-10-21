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
  /** The command that starts a classic client (tests); default: this program. */
  classic?: readonly string[]
}

/**
 * Runs InfiniTUI. A dialog only the classic UI has (/connect, /apps, /settings, /account) opens in a classic client
 * of the same server, and InfiniTUI comes back afterwards on the same session. This process keeps the server's
 * lease meanwhile, so running work goes on. /classic returns INFINITUI_FALLBACK: the caller runs the classic UI here.
 */
export async function infinituiRun(binary: string, options: InfinituiOptions): Promise<number> {
  let next = options
  for (;;) {
    const code = await runOnce(binary, next)
    const command = process.env.INFINITEOC_CLASSIC_COMMAND
    if (code !== INFINITUI_FALLBACK || !command) return code
    const session = handedOff
    delete process.env.INFINITEOC_CLASSIC_COMMAND
    handedOff = undefined
    await classicDialog(command, session, options)
    next = { url: options.url, password: options.password, version: options.version, classic: options.classic, sessionID: session }
  }
}

// The classic UI as a client of this server, only for one dialog: it exits when the dialog closes.
function classicDialog(command: string, session: string | undefined, options: InfinituiOptions): Promise<void> {
  const runtime = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase()
  const self =
    options.classic ??
    (runtime === "bun" || runtime === "node" || runtime === "nodejs" ? [process.execPath, process.argv[1] ?? ""] : [process.execPath])
  const args = [...self.slice(1), "--server", options.url, ...(session ? ["--session", session] : [])]
  const env: Record<string, string | undefined> = {
    ...process.env,
    INFINITEOC_CLASSIC_COMMAND: command,
    INFINITEOC_CLASSIC_RETURN: "1",
  }
  delete env.INFINITEOC_GO_TUI
  if (options.password) env.OPENCODE_PASSWORD = options.password
  return new Promise((resolve) => {
    const child = spawn(self[0]!, args, { stdio: "inherit", env })
    const handlers = forwardSignals(child)
    const done = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler)
      resolve()
    }
    child.on("error", done)
    child.on("exit", done)
  })
}

// The TUIs read keys in raw mode, so a terminal SIGINT only reaches us when something else sent it.
// Termination signals go to the child, whose exit decides ours.
function forwardSignals(child: ReturnType<typeof spawn>): [NodeJS.Signals, () => void][] {
  const handlers: [NodeJS.Signals, () => void][] = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => [
    signal,
    () => {
      if (signal !== "SIGINT") child.kill(signal)
    },
  ])
  for (const [signal, handler] of handlers) process.on(signal, handler)
  return handlers
}

function runOnce(binary: string, options: InfinituiOptions): Promise<number> {
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
        // A slash command for the classic UI to run once it is registered.
        if (command) process.env.INFINITEOC_CLASSIC_COMMAND = command
        unlinkSync(handoff)
      } catch {}
      resolve(code)
    }
    const child = spawn(binary, args, { stdio: "inherit", env })
    const handlers = forwardSignals(child)
    child.on("error", () => done(INFINITUI_FALLBACK))
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)))
  })
}
