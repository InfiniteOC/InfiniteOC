import type { FeatureContext } from "./api"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { freePort } from "./prov-lib"

type Server = { id: number; command: string; cwd: string; port: number; child: ChildProcess; log: string[]; code?: number | string }
// Module state would reset on a live reload; the processes must not be forgotten.
const state: { servers: Server[]; next: number; hooked: boolean } = ((globalThis as any).__infiniteocServe ??= { servers: [], next: 1, hooked: false })
const LOG_LINES = 500
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

const running = (server: Server) => server.code === undefined && server.child.exitCode === null
const status = (server: Server) => (running(server) ? "running" : server.code === "SIGTERM" || server.code === "SIGKILL" ? "stopped" : `exited (${server.code})`)

function defaultCommand() {
  try {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts ?? {}
    const script = scripts.dev ? "dev" : scripts.start ? "start" : undefined
    if (!script) return ""
    const runner = existsSync("pnpm-lock.yaml") ? "pnpm run" : existsSync("yarn.lock") ? "yarn" : existsSync("bun.lock") || existsSync("bun.lockb") ? "bun run" : "npm run"
    return `${runner} ${script}`
  } catch {
    return ""
  }
}

function stop(server: Server) {
  if (!running(server)) return
  // Own process group (detached), so the shell and everything it started go together.
  const signal = (name: NodeJS.Signals) => { try { process.kill(-server.child.pid!, name) } catch {} }
  signal("SIGTERM")
  setTimeout(() => running(server) && signal("SIGKILL"), 3000).unref()
}

async function start(ctx: FeatureContext) {
  const command = (await ctx.ui.prompt({ title: "Start a dev server", description: "Runs in the background in this project, with PORT set to a free port", value: defaultCommand(), placeholder: "npm run dev" }))?.trim()
  if (!command) return
  const port = await freePort()
  const child = spawn(command, { shell: true, cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(port), BROWSER: "none" } })
  const server: Server = { id: state.next++, command, cwd: process.cwd(), port, child, log: [] }
  const collect = (chunk: Buffer) => {
    for (const line of chunk.toString().replace(ANSI, "").split(/\r?\n/)) if (line.trim()) server.log.push(line)
    if (server.log.length > LOG_LINES) server.log.splice(0, server.log.length - LOG_LINES)
  }
  child.stdout!.on("data", collect)
  child.stderr!.on("data", collect)
  child.on("error", (error) => { server.log.push(`failed to start: ${error.message}`); server.code = -1 })
  child.on("exit", (code, signal) => { server.code = code ?? signal ?? -1 })
  state.servers.push(server)
  if (!state.hooked) {
    state.hooked = true
    // Servers live as long as InfiniteOC does: closing tabs leaves them running, exiting stops them.
    process.on("exit", () => state.servers.forEach(stop))
  }
  ctx.toast.show({ variant: "success", title: "Dev server", message: `#${server.id} started on port ${port}: ${command}\nOpen /serve to see logs or stop it.` })
}

async function manage(ctx: FeatureContext, server: Server) {
  const choice = await ctx.ui.select({
    title: `#${server.id} :${server.port} ${status(server)}`,
    options: [
      { title: server.command, value: "info", description: server.cwd },
      { title: "View logs", value: "logs", description: `last ${Math.min(server.log.length, 40)} lines` },
      ...(running(server) ? [{ title: "Stop", value: "stop", description: "sends SIGTERM to the server's process group" }] : [{ title: "Remove from list", value: "remove" }]),
    ],
  })
  if (choice === "stop") {
    stop(server)
    ctx.toast.show({ variant: "info", title: "Dev server", message: `Stopping #${server.id}.` })
  } else if (choice === "remove") state.servers.splice(state.servers.indexOf(server), 1)
  else if (choice === "logs") {
    ctx.ui.set({ size: "large" })
    await ctx.ui.alert({ title: `#${server.id} :${server.port} ${status(server)}`, message: server.log.slice(-40).join("\n") || "No output yet." })
  }
}

export async function run(ctx: FeatureContext) {
  const choice = await ctx.ui.select({
    title: "Dev servers",
    options: [
      { title: "Start a dev server", value: "start", description: defaultCommand() || "enter a command" },
      ...state.servers.map((server) => ({ title: `#${server.id} :${server.port} ${status(server)}`, value: String(server.id), description: server.command })),
    ],
  })
  if (choice === "start") return start(ctx)
  const server = state.servers.find((item) => String(item.id) === choice)
  if (server) return manage(ctx, server)
}
