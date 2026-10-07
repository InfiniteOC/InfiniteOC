import { readFile } from "node:fs/promises"
// Version-specific integration is centralized here, not copied into every mod.
export function replaceExact(source, before, after, label = "source") {
  if (typeof before !== "string" || !before || source.split(before).length !== 2)
    throw new Error(`InfiniteOC: expected one ${label} anchor; pinned source is incompatible or another mod changed it`)
  return source.replace(before, after)
}

export const closeAllMethod = `      async closeAll() {
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
        setClosedTabs((entries) => tabs.reduce((stack, tab, index) => recordClosedSessionTab(stack, tab, index), entries))
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
`

export const featureApiSource = `import type { useSessionTabs } from "../context/session-tabs"
import type { useRoute } from "../context/route"
import type { useDialog } from "../ui/dialog"
import type { useToast } from "../ui/toast"

/** Local TUI context; closing tabs never deletes or interrupts sessions. */
export type FeatureContext = {
  tabs: ReturnType<typeof useSessionTabs>
  route: ReturnType<typeof useRoute>
  dialog: ReturnType<typeof useDialog>
  toast: ReturnType<typeof useToast>
}
`

export function validateCommand(modID, input) {
  const validID = /^[a-z0-9][a-z0-9._-]*$/i
  const validSlash = /^[a-z][a-z0-9_-]*$/
  if (!input || !validID.test(input.id || "") || typeof input.title !== "string" || !input.title.trim())
    throw new Error(`${modID}: TUI command needs id and title`)
  if (typeof input.source !== "string" || !/export\s+(?:async\s+)?function\s+run\s*\(/.test(input.source))
    throw new Error(`${modID}: command source must export function run(ctx: FeatureContext)`)
  const aliases = input.aliases ?? []
  if (!Array.isArray(aliases) || !validSlash.test(input.slash || "") || aliases.some(value => typeof value !== "string" || !validSlash.test(value)))
    throw new Error(`${modID}: slash and aliases must be lowercase names without /`)
  return { id: `${modID}.${input.id}`, title: input.title, category: input.category || "Mods", slash: input.slash, aliases, source: input.source, file: `${modID}--${input.id}.tsx`, modID }
}

export async function installTuiFeatures(commands, api) {
  if (!commands.length) return
  const appFile = "packages/tui/src/app.tsx"
  let app = await api.read(appFile)
  const registered = new Set()
  for (const command of commands) {
    for (const name of [command.slash, ...command.aliases]) {
      const builtin = [...app.matchAll(/slash:\s*\{([^}]+)\}/g)].some(match => match[1].includes(JSON.stringify(name)))
      if (registered.has(name) || builtin) throw new Error(`Duplicate TUI slash command: /${name}`)
      registered.add(name)
    }
  }
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
        try { return Promise.resolve(run${index}(ctx)).catch(ctx.toast.error) }
        catch (error) { ctx.toast.error(error) }
      },
    },`).join("\n")
  await api.write("packages/tui/src/infiniteoc-features/index.ts", `${imports}
import type { FeatureContext } from "./api"
export function infiniteocCommands(ctx: FeatureContext) {
  return [
${entries}
  ]
}
`)
  await api.write("packages/tui/src/infiniteoc-features/live-runtime.ts", await readFile(new URL("./live-runtime.ts", import.meta.url), "utf8"))
  await api.write("packages/tui/src/infiniteoc-features/daemon-client.mjs", await readFile(new URL("./daemon-client.mjs", import.meta.url), "utf8"))
  app = replaceExact(app, 'import { SessionTabsProvider, useSessionTabs } from "./context/session-tabs"', 'import { SessionTabsProvider, useSessionTabs } from "./context/session-tabs"\nimport { infiniteocCommands } from "./infiniteoc-features"\nimport { createLiveCommands } from "./infiniteoc-features/live-runtime"', "app import")
  app = replaceExact(app, '  const appCommands = createMemo(() =>\n    [', '  const liveCommands = createLiveCommands({ tabs: sessionTabs, route, dialog, toast }, () => infiniteocCommands({ tabs: sessionTabs, route, dialog, toast }))\n  const appCommands = createMemo(() =>\n    [\n      ...liveCommands(),', "appCommands")
  await api.patch(appFile, () => app)
  await api.write("infiniteoc-features.json", JSON.stringify(commands.map(({ source, ...metadata }) => metadata), null, 2) + "\n")
}