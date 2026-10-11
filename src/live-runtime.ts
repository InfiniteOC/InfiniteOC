import { createSignal, onCleanup } from "solid-js"
import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { daemonRequest } from "./daemon-client.mjs"
import { errorMessage } from "../util/error"
import type { FeatureContext } from "./api"

type Command = { id: string; title: string; category: string; slash: string; aliases: string[]; module: string }
type Generation = { revision: string; commands: Command[] }
type Handler = { metadata: Command; run: (ctx: FeatureContext) => void | Promise<void> }
type Message = { id: string; action: "notify" | "close-all-tabs" | "script"; text: string; module?: string }
type Status = { pid: number; phase: string; autoReload: boolean; revision: string | null; restartRequired: boolean; restartReason: string | null; clients: object; events: { stage: string; message: string; at: string }[] }

// Validate/load all modules before replacing a working generation.
async function importHandlers(commands: Command[]) {
  const next: Handler[] = []
  for (const metadata of commands) {
    const module = await import(metadata.module)
    if (typeof module.run !== "function") throw new Error("Invalid live command export")
    next.push({ metadata, run: module.run })
  }
  return next
}

export function createLiveCommands(ctx: FeatureContext, fallback: () => ReturnType<typeof import("./index").infiniteocCommands>) {
  const socket = process.env.INFINITEOC_DAEMON_SOCKET
  const manifestFile = process.env.INFINITEOC_LIVE_MANIFEST
  const [handlers, setHandlers] = createSignal<Handler[]>()
  const [temporaryHandlers, setTemporaryHandlers] = createSignal<Handler[]>([])
  // The launcher's per-UI id, which this UI's server, agent and terminals inherit as their opendaemon CLIENT default.
  const client = process.env.INFINITEOC_UI_CLIENT || randomUUID()
  let revision: string | undefined, disposed = false, polling = false, offline = false
  let temporaryRevision: string | null = null
  // A failed revision is not re-imported every poll; only a newly published one is retried.
  let failedRevision: string | undefined, failedTemporary: string | null | undefined
  // Unset until the first poll, so a job that failed before this UI connected stays silent.
  let failedJob: string | null | undefined
  let seenMessages = new Set<string>()
  const invalid = () => ctx.toast.show({ variant: "warning", message: "Live generation invalid — last working commands kept" })
  const settle = (id: string, work: () => unknown) => Promise.resolve().then(work).then(() => "applied", () => "failed")
    .then(status => daemonRequest(socket, "POST", "/ack", { client, id, status }, 2000)).catch(() => {})
  if (process.env.INFINITEOC_NOTICE) ctx.toast.show({ variant: "warning", message: process.env.INFINITEOC_NOTICE, duration: 8000 })
  async function load() {
    if (!manifestFile) return
    const generation: Generation = JSON.parse(await readFile(manifestFile, "utf8"))
    if (generation.revision === revision) return
    const next = await importHandlers(generation.commands)
    if (disposed) return
    setHandlers(next)
    // The startup generation loads silently; later ones confirm the live update.
    if (revision || failedRevision) ctx.toast.show({ variant: "success", message: "Live commands updated", duration: 2000 })
    revision = generation.revision
  }
  async function poll() {
    if (!socket || disposed || polling) return
    polling = true
    try {
      const response = await daemonRequest(socket, "POST", "/poll", { client, revision, temporaryRevision, scripting: true }, 2000) as { revision: string | null; messages: Message[]; temporary?: { revision: string | null; commands: Command[] }; job?: { id: string; status: string; detail?: string } | null }
      if (disposed) return
      if (offline) ctx.toast.show({ variant: "info", message: "opendaemon reconnected", duration: 2000 })
      offline = false
      const published = response.revision
      if (published && published !== revision && published !== failedRevision) {
        try { await load() } catch { failedRevision = published; invalid() }
      }
      const temporary = response.temporary
      if (temporary && temporary.revision !== temporaryRevision && temporary.revision !== failedTemporary) {
        try {
          const next = await importHandlers(temporary.commands)
          if (disposed) return
          setTemporaryHandlers(next)
          temporaryRevision = temporary.revision
        } catch { failedTemporary = temporary.revision; invalid() }
      }
      const failed = response.job?.status === "failed" ? response.job.id : null
      if (failedJob !== undefined && failed && failed !== failedJob) ctx.toast.show({ variant: "warning", title: "Live reload failed", message: `${response.job?.detail ? `${response.job.detail}. ` : ""}Last working commands kept · run opendaemon status`, duration: 5000 })
      failedJob = failed
      const fresh = response.messages.filter(message => !seenMessages.has(message.id))
      // Acknowledged or expired ids leave the response and never return, so this stays bounded.
      seenMessages = new Set(response.messages.map(message => message.id))
      const notes = fresh.filter(message => message.action === "notify").map(message => message.text)
      for (const message of fresh) {
        if (message.action === "notify") void settle(message.id, () => {})
        else if (message.action === "close-all-tabs") await settle(message.id, async () => {
          const ids = ctx.tabs.tabs().map((tab) => tab.sessionID), active = ctx.tabs.current()
          const count = await ctx.tabs.closeAll()
          // Mirrors /clearall: toast actions are mouse-only, so the message names the keyboard path too.
          // show() replaces the visible toast at once, so this poll's notifications ride along instead of vanishing.
          if (count) ctx.toast.show({
            variant: "info",
            title: `Closed ${count} tab${count === 1 ? "" : "s"} (opendaemon request)`,
            message: [...notes.splice(0), 'Saved sessions are unchanged and running tasks keep going. "Reopen closed tab" (ctrl+shift+t) reopens one at a time; /sessions reopens any.'].join("\n"),
            action: { label: "Undo", run: () => void Promise.resolve().then(() => ctx.tabs.restoreAll(ids, active)).catch(ctx.toast.error) },
          })
        })
        // Not awaited: a long script must not stall polling, or the daemon drops this UI and its overlays.
        else void settle(message.id, async () => {
          const module = message.action === "script" && message.module ? await import(message.module) : undefined
          if (typeof module?.run !== "function") throw new Error("Invalid script")
          return module.run(ctx)
        })
      }
      if (notes.length) ctx.toast.show({ variant: "info", message: notes.join("\n") })
    } catch {
      // Keep the current generation, route, draft prompt and agent; warn once per outage.
      if (!offline) ctx.toast.show({ variant: "warning", message: "opendaemon unreachable — live reload paused; current commands keep working" })
      offline = true
    } finally { polling = false }
  }
  async function showStatus() {
    if (!socket) return ctx.toast.show({ variant: "info", message: "opendaemon is not connected; live reload is off in this UI. Start InfiniteOC through its launcher." })
    try {
      const daemon = await daemonRequest(socket, "GET", "/status", undefined, 2000) as Status
      const short = (value?: string | null) => value?.slice(0, 8) ?? "none"
      const failure = daemon.events.findLast(event => event.stage === "failed")
      const choice = ctx.ui.select({ title: "InfiniteOC live", options: [
        // opendaemon script/temporary take this client ID.
        { title: "This UI", value: "client", description: "client ID", footer: client },
        { title: "Daemon", value: "daemon", footer: `pid ${daemon.pid} · ${daemon.phase} · auto ${daemon.autoReload ? "on" : "off"}` },
        { title: "Live commands", value: "commands", description: `${temporaryHandlers().length} temporary`, footer: `loaded ${short(revision)} · published ${short(daemon.revision)}` },
        { title: "Restart", value: "restart", description: daemon.restartReason ?? undefined, footer: daemon.restartRequired ? "required" : "not required" },
        { title: "Connected UIs", value: "clients", footer: String(Object.keys(daemon.clients).length) },
        ...(failure ? [{ title: "Last failure", value: "failure", description: failure.message, footer: new Date(failure.at).toLocaleTimeString() }] : []),
        { title: "Reload live commands now", value: "reload" },
      ] })
      // select() has already replaced the dialog; widen it so the footers fit.
      ctx.ui.set({ size: "large" })
      const chosen = await choice
      // Choosing a row closes the select before copy-on-select runs; the alert keeps the ID on screen to copy.
      if (chosen === "client") return ctx.ui.alert({ title: "This UI client ID", message: `${client}\nUse it with: opendaemon script ${client} FILE  (inside this UI's terminal or agent, CLIENT can be omitted)` })
      if (chosen !== "reload") return
      await daemonRequest(socket, "POST", "/reload", {}, 2000)
      ctx.toast.show({ variant: "success", message: "Live reload requested", duration: 2000 })
    } catch (error) { ctx.toast.show({ variant: "warning", message: errorMessage(error) }) }
  }
  const timer = socket ? setInterval(() => void poll(), 750) : undefined
  void poll()
  onCleanup(() => { disposed = true; if (timer) clearInterval(timer) })
  const live = { name: "infiniteoc.live", title: "InfiniteOC live status", category: "System", slash: { name: "live" }, run: () => showStatus() }
  return () => {
    const permanent = handlers()
    const overlay = temporaryHandlers()
    const current = permanent ? [...permanent.filter(handler => !overlay.some(item => item.metadata.slash === handler.metadata.slash)), ...overlay] : undefined
    const commands = (current || overlay).map(handler => ({
      name: handler.metadata.id,
      title: handler.metadata.title,
      category: handler.metadata.category,
      slash: { name: handler.metadata.slash, aliases: handler.metadata.aliases },
      run: () => {
        // Captures this generation's function. An in-flight invocation is never
        // cancelled simply because a later generation is published.
        const fail = (error: unknown) => ctx.toast.show({ variant: "error", title: `/${handler.metadata.slash} failed`, message: errorMessage(error) })
        ctx.dialog.clear()
        try { return Promise.resolve(handler.run(ctx)).catch(fail) }
        catch (error) { fail(error) }
      },
    }))
    if (current) return [...commands, live]
    return [...fallback().filter(command => !overlay.some(item => item.metadata.slash === command.slash.name)), ...commands, live]
  }
}
