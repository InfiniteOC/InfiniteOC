#!/usr/bin/env node
import path from "node:path"
import { fileURLToPath } from "node:url"
import { daemonPaths, startDaemon, ensureDaemon, stopDaemon, checkSocket } from "../src/opendaemon.mjs"
import { daemonRequest } from "../src/daemon-client.mjs"
import { readFile } from "node:fs/promises"

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const gone = error => error.syscall === "connect" && ["ENOENT", "ECONNREFUSED"].includes(error.code)
const span = ms => { const s = Math.floor(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d` }
const line = event => `${new Date(event.at).toTimeString().slice(0, 8)}  ${event.stage}  ${event.message}`
function summary(status) {
  const published = status.events.findLast(event => event.stage === "published" && event.revision === status.revision)
  const clients = Object.entries(status.clients)
  return [
    `opendaemon pid ${status.pid}, up ${span(Date.now() - Date.parse(status.startedAt))}, auto ${status.autoReload ? "on" : "off"}`,
    `revision: ${status.revision ?? "none"}${published ? ` (published ${span(Date.now() - Date.parse(published.at))} ago)` : ""}`,
    `last job: ${status.job ? `${status.job.status} (${status.job.reason})` : "none"}`,
    `restart required: ${status.restartRequired ? `yes, ${status.restartReason}` : "no"}`,
    `clients: ${clients.length}`,
    ...clients.map(([id, client]) => `  ${id}  scripting: ${client.scripting === true}  revision: ${client.revision ?? "none"}`),
    "recent events:",
    ...status.events.slice(-5).map(event => `  ${line(event)}`),
  ].join("\n")
}

try {
  // --json is global, so it never becomes the command or part of notify text.
  const args = process.argv.slice(2).filter(arg => arg !== "--json")
  const json = process.argv.includes("--json")
  const homeIndex = args.indexOf("--home")
  const base = homeIndex < 0 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") : path.resolve(args.splice(homeIndex, 2)[1] || "")
  const command = args.shift() || "status"
  const show = status => console.log(json ? JSON.stringify(status, null, 2) : summary(status))
  if (["help", "--help"].includes(command)) {
    console.log(`opendaemon — InfiniteOC live UI control (same-user socket or named pipe)

  opendaemon start                    Start the background daemon, print its status
  opendaemon stop                     Stop the daemon (SIGTERM to the pid it reports)
  opendaemon restart                  Stop, start again and print the new status
  opendaemon serve                    Run foreground (debug/service manager)
  opendaemon status [--json]          Pid, uptime, revision, last job, clients, events
  opendaemon reload                   Compile and publish live TUI handlers (async)
  opendaemon watch [--json]           Stream daemon events; keeps waiting across restarts
  opendaemon notify TEXT              Send a notification to connected UIs
  opendaemon close-all-tabs           Close UI tabs, never delete stored sessions
  opendaemon auto on|off              Enable/disable local mod auto reload
  opendaemon dev                      Dev mode: 250ms file checks, compile diagnostics, live log
                                      (Ctrl+C leaves dev mode; the daemon keeps running)
  opendaemon temporary [CLIENT] FILE  Add/replace a temporary command from JSON
  opendaemon temporary-clear [CLIENT] Remove that UI's temporary commands
  opendaemon script [CLIENT] FILE     Run trusted JS/TS export run(ctx) once
  --home PATH                         Use another InfiniteOC installation; takes
                                      precedence over INFINITEOC_DAEMON_SOCKET

Without --home, CLIENT defaults to the UI whose terminal or agent runs it.
Compiled backend/source patches need infiniteoc rebuild and a UI restart;
opendaemon restart does not apply them. This daemon never kills agents or
downloads mod updates. stop/restart end only the daemon: UIs and agents keep
running and reconnect; temporary overlays are dropped.
Scripts execute trusted local code in the UI process, are NOT sandboxed, and
cannot automatically undo side effects.`)
  } else if (command === "serve") {
    const daemon = await startDaemon(base)
    console.log(`opendaemon listening on ${daemon.paths.socket}`)
    const close = async () => { await daemon.close(); process.exit(0) }
    process.once("SIGINT", close); process.once("SIGTERM", close)
  } else if (command === "start") {
    const paths = await ensureDaemon(base)
    show(await daemonRequest(paths.socket, "GET", "/status"))
  } else {
    // An explicit --home wins over the socket and UI client a launcher-started UI's terminals and agent inherit.
    const socket = homeIndex < 0 && process.env.INFINITEOC_DAEMON_SOCKET || daemonPaths(base).socket
    // Otherwise an over-long path surfaces as a raw connect EINVAL, or watch waits forever.
    checkSocket(socket)
    const arity = { temporary: 2, script: 2, "temporary-clear": 1 }[command]
    if (arity && args.length === arity - 1) {
      if (homeIndex >= 0 || !process.env.INFINITEOC_UI_CLIENT) throw new Error("CLIENT required outside an InfiniteOC UI; copy one from opendaemon status")
      args.unshift(process.env.INFINITEOC_UI_CLIENT)
    }
    if (command === "status") show(await daemonRequest(socket, "GET", "/status"))
    else if (command === "stop") { const pid = await stopDaemon(socket); console.log(pid ? `opendaemon stopped (pid ${pid})` : "opendaemon is not running") }
    else if (command === "restart") { await stopDaemon(socket); show(await daemonRequest((await ensureDaemon(base)).socket, "GET", "/status")) }
    else if (command === "reload") console.log(JSON.stringify(await daemonRequest(socket, "POST", "/reload", {}), null, 2))
    else if (command === "notify") console.log(JSON.stringify(await daemonRequest(socket, "POST", "/message", { action: "notify", text: args.join(" ") }), null, 2))
    else if (command === "close-all-tabs") console.log(JSON.stringify(await daemonRequest(socket, "POST", "/message", { action: "close-all-tabs" }), null, 2))
    else if (command === "temporary" && args.length === 2) console.log(JSON.stringify(await daemonRequest(socket, "POST", "/temporary", { client: args[0], command: JSON.parse(await readFile(path.resolve(args[1]), "utf8")) }, 30000), null, 2))
    else if (command === "temporary-clear" && args.length === 1) console.log(JSON.stringify(await daemonRequest(socket, "POST", "/temporary", { client: args[0], clear: true }), null, 2))
    else if (command === "script" && args.length === 2) console.log(JSON.stringify(await daemonRequest(socket, "POST", "/temporary", { client: args[0], run: true, command: { id: "test-script", title: "Temporary test script", slash: "test-script", source: await readFile(path.resolve(args[1]), "utf8") } }, 30000), null, 2))
    else if (command === "auto" && ["on", "off"].includes(args[0])) console.log(JSON.stringify(await daemonRequest(socket, "POST", "/auto", { enabled: args[0] === "on" }), null, 2))
    else if (command === "watch" || command === "dev") {
      const dev = command === "dev"
      if (dev) {
        console.log(JSON.stringify(await daemonRequest(socket, "POST", "/dev", { enabled: true })))
        // Leave dev mode (fast polling, diagnostics) when this command ends; the daemon and UIs are untouched.
        const leave = () => daemonRequest(socket, "POST", "/dev", { enabled: false }, 1000).catch(() => {}).then(() => process.exit(0))
        process.once("SIGINT", leave); process.once("SIGTERM", leave)
      }
      let last = 0, startedAt, waiting = false
      for (;;) {
        try {
          const status = await daemonRequest(socket, "GET", "/status")
          // A restarted daemon numbers its events from 1 again.
          if (status.startedAt !== startedAt) { startedAt = status.startedAt; last = 0 }
          waiting = false
          for (const event of status.events) if (event.sequence > last) { console.log(json ? JSON.stringify(event) : line(event) + (dev && event.ms !== undefined ? `  (${event.ms}ms)` : "")); last = event.sequence }
        } catch {
          if (!waiting) console.error("waiting for opendaemon…")
          waiting = true
        }
        await sleep(waiting ? 1000 : dev ? 200 : 500)
      }
    } else throw new Error("Unknown command; use opendaemon --help")
  }
} catch (error) { console.error(`[opendaemon] ${gone(error) ? "not running; start it with: opendaemon start" : error.message}`); process.exitCode = 1 }
