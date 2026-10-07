#!/usr/bin/env node
import path from "node:path"
import { fileURLToPath } from "node:url"
import { daemonPaths, startDaemon, ensureDaemon } from "../src/opendaemon.mjs"
import { daemonRequest } from "../src/daemon-client.mjs"
import { readFile } from "node:fs/promises"

try {
  const args = process.argv.slice(2)
  const homeIndex = args.indexOf("--home")
  const base = homeIndex < 0 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") : path.resolve(args.splice(homeIndex, 2)[1] || "")
  const command = args.shift() || "status"
  if (["help", "--help"].includes(command)) {
    console.log(`opendaemon — InfiniteOC live UI control (same-user Unix socket)

  opendaemon start                  Start background watcher
  opendaemon serve                  Run foreground (debug/service manager)
  opendaemon status                 Status, reload progress and acknowledgements
  opendaemon reload                 Compile and publish live TUI handlers (async)
  opendaemon watch                  Stream actual daemon events
  opendaemon notify TEXT            Send a notification to connected UIs
  opendaemon close-all-tabs         Close UI tabs, never delete stored sessions
  opendaemon auto on|off            Enable/disable local mod auto reload
  opendaemon temporary CLIENT FILE Add/replace a temporary command from JSON
  opendaemon temporary-clear CLIENT Remove that UI's temporary commands
  opendaemon script CLIENT FILE     Run trusted JS/TS export run(ctx) once
  --home PATH                      Use a different InfiniteOC installation

Compiled backend/source patches require rebuild/restart; this daemon never
kills agents or downloads mod updates. Scripts execute trusted local code in
the UI process, are NOT sandboxed, and cannot automatically undo side effects.`)
  } else if (command === "serve") {
    const daemon = await startDaemon(base)
    console.log(`opendaemon listening on ${daemon.paths.socket}`)
    const close = async () => { await daemon.close(); process.exit(0) }
    process.once("SIGINT", close); process.once("SIGTERM", close)
  } else if (command === "start") {
    const paths = await ensureDaemon(base)
    console.log(JSON.stringify(await daemonRequest(paths.socket, "GET", "/status"), null, 2))
  } else {
    const socket = process.env.INFINITEOC_DAEMON_SOCKET || daemonPaths(base).socket
    if (command === "status") console.log(JSON.stringify(await daemonRequest(socket, "GET", "/status"), null, 2))
    else if (command === "reload") console.log(JSON.stringify(await daemonRequest(socket, "POST", "/reload", {}), null, 2))
    else if (command === "notify") console.log(JSON.stringify(await daemonRequest(socket, "POST", "/message", { action: "notify", text: args.join(" ") }), null, 2))
    else if (command === "close-all-tabs") console.log(JSON.stringify(await daemonRequest(socket, "POST", "/message", { action: "close-all-tabs" }), null, 2))
    else if (command === "temporary" && args.length === 2) console.log(JSON.stringify(await daemonRequest(socket, "POST", "/temporary", { client: args[0], command: JSON.parse(await readFile(path.resolve(args[1]), "utf8")) }, 30000), null, 2))
    else if (command === "temporary-clear" && args.length === 1) console.log(JSON.stringify(await daemonRequest(socket, "POST", "/temporary", { client: args[0], clear: true }), null, 2))
    else if (command === "script" && args.length === 2) console.log(JSON.stringify(await daemonRequest(socket, "POST", "/temporary", { client: args[0], run: true, command: { id: "test-script", title: "Temporary test script", slash: "test-script", source: await readFile(path.resolve(args[1]), "utf8") } }, 30000), null, 2))
    else if (command === "auto" && ["on", "off"].includes(args[0])) console.log(JSON.stringify(await daemonRequest(socket, "POST", "/auto", { enabled: args[0] === "on" }), null, 2))
    else if (command === "watch") {
      let last = 0
      for (;;) {
        const status = await daemonRequest(socket, "GET", "/status")
        for (const event of status.events) if (event.sequence > last) { console.log(JSON.stringify(event)); last = event.sequence }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    } else throw new Error("Unknown command; use opendaemon --help")
  }
} catch (error) { console.error(`[opendaemon] ${error.message}`); process.exitCode = 1 }