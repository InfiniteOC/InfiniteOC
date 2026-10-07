import { createSignal, onCleanup } from "solid-js"
import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { daemonRequest } from "./daemon-client.mjs"
import type { FeatureContext } from "./api"

type Command = { id: string; title: string; category: string; slash: string; aliases: string[]; module: string }
type Generation = { revision: string; commands: Command[] }
type Handler = { metadata: Command; run: (ctx: FeatureContext) => unknown }
type Message = { id: string; action: "notify" | "close-all-tabs" | "script"; text: string; module?: string }

export function createLiveCommands(ctx: FeatureContext, fallback: () => ReturnType<typeof import("./index").infiniteocCommands>) {
  const socket = process.env.INFINITEOC_DAEMON_SOCKET
  const manifestFile = process.env.INFINITEOC_LIVE_MANIFEST
  const [handlers, setHandlers] = createSignal<Handler[]>()
  const [temporaryHandlers, setTemporaryHandlers] = createSignal<Handler[]>([])
  const client = randomUUID()
  let revision: string | undefined, disposed = false, polling = false
  let temporaryRevision: string | null = null
  const seenMessages = new Set<string>()
  let lastFailed: string | undefined
  async function load() {
    if (!manifestFile) return
    const generation: Generation = JSON.parse(await readFile(manifestFile, "utf8"))
    if (generation.revision === revision) return
    // Validate/load all modules before replacing a working generation.
    const next: Handler[] = []
    for (const metadata of generation.commands) {
      const module = await import(metadata.module)
      if (typeof module.run !== "function") throw new Error("Invalid live command export")
      next.push({ metadata, run: module.run })
    }
    if (disposed) return
    setHandlers(next)
    revision = generation.revision
    lastFailed = undefined
  }
  async function poll() {
    if (!socket || disposed || polling) return
    polling = true
    try {
      const response = await daemonRequest(socket, "POST", "/poll", { client, revision, temporaryRevision, scripting: true }, 2000) as { revision: string | null; messages: Message[]; temporary?: { revision: string | null; commands: Command[] } }
      if (disposed) return
      if (response.revision && response.revision !== revision) await load()
      if (response.temporary && response.temporary.revision !== temporaryRevision) {
        const next: Handler[] = []
        for (const metadata of response.temporary.commands) {
          const module = await import(metadata.module)
          if (typeof module.run !== "function") throw new Error("Invalid temporary command")
          next.push({ metadata, run: module.run })
        }
        if (disposed) return
        setTemporaryHandlers(next)
        temporaryRevision = response.temporary.revision
      }
      for (const message of response.messages as Message[]) {
        if (seenMessages.has(message.id)) continue
        seenMessages.add(message.id)
        let status = "applied"
        try {
          if (message.action === "notify") ctx.toast.show({ variant: "info", message: message.text })
          else if (message.action === "close-all-tabs") await ctx.tabs.closeAll()
          else if (message.action === "script" && message.module) {
            const module = await import(message.module)
            if (typeof module.run !== "function") throw new Error("Invalid script")
            await module.run(ctx)
          }
          else throw new Error("Unsupported action")
        } catch { status = "failed" }
        await daemonRequest(socket, "POST", "/ack", { client, id: message.id, status }, 2000)
      }
    } catch {
      // Keep the current generation, current route, draft prompt, and agent.
      // A stopped daemon should not spam notifications every poll.
      if (lastFailed !== "reload") {
        lastFailed = "reload"
        ctx.toast.show({ variant: "warning", message: "opendaemon unavailable or live generation invalid. Current UI commands and agent continue unchanged." })
      }
    } finally { polling = false }
  }
  const timer = socket ? setInterval(() => void poll(), 750) : undefined
  void poll()
  onCleanup(() => { disposed = true; if (timer) clearInterval(timer) })
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
        ctx.dialog.clear()
        try { return Promise.resolve(handler.run(ctx)).catch(ctx.toast.error) }
        catch (error) { ctx.toast.error(error) }
      },
    }))
    if (current) return commands
    return [...fallback().filter(command => !overlay.some(item => item.metadata.slash === command.slash.name)), ...commands]
  }
}