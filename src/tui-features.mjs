import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
// Version-specific integration is centralized here, not copied into every mod.
export function replaceExact(source, before, after, label = "source") {
  if (typeof before !== "string" || !before || source.split(before).length !== 2)
    throw new Error(`InfiniteOC: expected one ${label} anchor; pinned source is incompatible or another mod changed it`)
  return source.replace(before, after)
}
// Framework-authored static text naming only validated ids or slash names: safe to show in the UI and daemon status.
export const safeError = message => Object.assign(new Error(message), { safe: true })

export const closeAllMethod = `      async closeAll() {
        if (!enabled()) return 0
        // One scoped storage mutation avoids intermediate route changes that
        // could re-register tabs while storage writes are pending.
        const tabs = [...state().tabs]
        const active = current()
        for (const tab of tabs) {
          cancelledTabs.add(tab.sessionID)
          family(tab.sessionID).forEach((id) => {
            scrollAnchors.delete(id)
            setExpandedGroups(id, undefined)
          })
        }
        if (active) cancelledTabs.add(active)
        // Recorded right to left so repeated reopen() restores the original order.
        setClosedTabs((entries) => tabs.reduceRight((stack, tab, index) => recordClosedSessionTab(stack, tab, index), entries))
        history = { entries: [], index: -1 }
        setPromptPulses({})
        route.navigate({ type: "home", location: location.ref })
        const scope = config.tabs.scope
        await updateStore((draft) => {
          const selected = scope === "cwd" ? (draft.cwd[paths.cwd] ??= empty()) : draft.global
          selected.tabs = []
          selected.unread = {}
        })
        return tabs.length
      },
      // Undo for closeAll in one locked write; looping reopen() would queue racing writes.
      async restoreAll(sessionIDs: string[], active?: string): Promise<number> {
        if (!enabled()) return 0
        const restored = new Set<string>()
        const scope = config.tabs.scope
        await updateStore((draft) => {
          const selected = scope === "cwd" ? (draft.cwd[paths.cwd] ??= empty()) : draft.global
          for (const sessionID of sessionIDs) {
            // Read under the lock: session.deleted may prune the stack while this write waits.
            const tabs = reopenSessionTab(closedTabs(), selected.tabs, sessionID).tabs
            if (!tabs) continue
            selected.tabs = tabs
            restored.add(sessionID)
          }
        })
        restored.forEach((id) => cancelledTabs.delete(id))
        setClosedTabs((entries) => entries.filter((entry) => !restored.has(entry.tab.sessionID)))
        if (active && restored.has(active)) route.navigate({ type: "session", sessionID: active })
        return restored.size
      },
`

export const featureApiSource = `import type { useSessionTabs } from "../context/session-tabs"
import type { useRoute } from "../context/route"
import type { useDialog } from "../ui/dialog"
import type { useToast } from "../ui/toast"
import type { createDialogApi } from "../plugin/api"

/** Local TUI context; closing tabs never deletes or interrupts sessions. */
export type FeatureContext = {
  tabs: ReturnType<typeof useSessionTabs>
  route: ReturnType<typeof useRoute>
  dialog: ReturnType<typeof useDialog>
  toast: ReturnType<typeof useToast>
  /** Promise dialogs: alert, confirm, prompt and select resolve with the answer (undefined on Esc). */
  ui: ReturnType<typeof createDialogApi>
}
`

export function validateCommand(modID, input) {
  const validID = /^[a-z0-9][a-z0-9._-]*$/i
  const validSlash = /^[a-z][a-z0-9_-]*$/
  if (!input || !validID.test(input.id || "") || typeof input.title !== "string" || !input.title.trim())
    throw safeError(`${modID}: TUI command needs id and title`)
  if (typeof input.source !== "string" || !/export\s+(?:async\s+)?function\s+run\s*\(/.test(input.source))
    throw safeError(`${modID}: command source must export function run(ctx: FeatureContext)`)
  const aliases = input.aliases ?? []
  if (!Array.isArray(aliases) || !validSlash.test(input.slash || "") || aliases.some(value => typeof value !== "string" || !validSlash.test(value)))
    throw safeError(`${modID}: slash and aliases must be lowercase names without /`)
  // Namespaced so a mod id such as "session" cannot shadow upstream commands in the shared keymap layer.
  return { id: `infiniteoc.${modID}.${input.id}`, title: input.title, category: input.category || "Mods", slash: input.slash, aliases, source: input.source, file: `${modID}--${input.id}.tsx`, modID }
}

// Slash names and aliases declared anywhere under sourceDir (absolute packages/tui/src), plus
// InfiniteOC's own /live (live-runtime.ts). Sequential reads keep open files bounded.
export async function builtinSlashNames(sourceDir) {
  const names = new Set(["live"])
  for (const file of await readdir(sourceDir, { recursive: true }))
    if (/\.tsx?$/.test(file))
      for (const [, body] of (await readFile(join(sourceDir, file), "utf8")).matchAll(/slash:\s*\{([^}]+)\}/g))
        for (const [, , name] of body.matchAll(/(["'])(.*?)\1/g)) names.add(name)
  return names
}

export function claimSlashNames(commands, taken) {
  for (const name of commands.flatMap(command => [command.slash, ...command.aliases])) {
    if (taken.has(name)) throw safeError(`Duplicate TUI slash command: /${name}`)
    taken.add(name)
  }
}

export async function installTuiFeatures(commands, api, sourceDir) {
  if (!commands.length) return
  const appFile = "packages/tui/src/app.tsx"
  let app = await api.read(appFile)
  claimSlashNames(commands, await builtinSlashNames(sourceDir))
  await api.patch("packages/tui/src/context/session-tabs.tsx", source =>
    replaceExact(source, "      close(sessionID?: string) {", closeAllMethod + "      close(sessionID?: string) {", "session-tabs.close"))
  await api.write("packages/tui/src/infiniteoc-features/api.ts", featureApiSource)
  for (const command of commands) await api.write(`packages/tui/src/infiniteoc-features/${command.file}`, command.source)
  const imports = commands.map((command, index) => `import { run as run${index} } from ${JSON.stringify(`./${command.file.slice(0, -4)}`)}`).join("\n")
  const entries = commands.map((command, index) => `    {
      name: ${JSON.stringify(command.id)},
      title: ${JSON.stringify(command.title)},
      category: ${JSON.stringify(command.category)},
      slash: ${JSON.stringify({ name: command.slash, aliases: command.aliases })},
      run: () => {
        ctx.dialog.clear()
        const failed = (error: unknown) => ctx.toast.show({ variant: "error", title: ${JSON.stringify(`/${command.slash} failed`)}, message: errorMessage(error) })
        try { return Promise.resolve(run${index}(ctx)).catch(failed) }
        catch (error) { failed(error) }
      },
    },`).join("\n")
  await api.write("packages/tui/src/infiniteoc-features/index.ts", `${imports}
import { errorMessage } from "../util/error"
import type { FeatureContext } from "./api"
export function infiniteocCommands(ctx: FeatureContext) {
  return [
${entries}
  ]
}
`)
  await api.write("packages/tui/src/infiniteoc-features/live-runtime.ts", await readFile(new URL("./live-runtime.ts", import.meta.url), "utf8"))
  await api.write("packages/tui/src/infiniteoc-features/daemon-client.mjs", await readFile(new URL("./daemon-client.mjs", import.meta.url), "utf8"))
  app = replaceExact(app, 'import { SessionTabsProvider, useSessionTabs } from "./context/session-tabs"', 'import { SessionTabsProvider, useSessionTabs } from "./context/session-tabs"\nimport { infiniteocCommands } from "./infiniteoc-features"\nimport { createLiveCommands } from "./infiniteoc-features/live-runtime"\nimport { createDialogApi } from "./plugin/api"', "app import")
  app = replaceExact(app, '  const appCommands = createMemo(() =>\n    [', '  const infiniteocContext = { tabs: sessionTabs, route, dialog, toast, ui: createDialogApi(dialog, (render) => render()) }\n  const liveCommands = createLiveCommands(infiniteocContext, () => infiniteocCommands(infiniteocContext))\n  const appCommands = createMemo(() =>\n    [\n      ...liveCommands(),', "appCommands")
  await api.patch(appFile, () => app)
  await api.write("infiniteoc-features.json", JSON.stringify(commands.map(({ source, ...metadata }) => metadata), null, 2) + "\n")
}