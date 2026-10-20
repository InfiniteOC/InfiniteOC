import { readFile } from "node:fs/promises"

// Strict single-anchor replace: every patch only inserts around its anchor, so later mods still find it.
export function replace(source, before, after, label = before) {
  if (typeof source !== "string" || source.split(before).length !== 2) throw new Error(`workflows: expected one source anchor: ${label}`)
  // Insert-after patches keep their anchor, so a second application must be caught explicitly.
  if (source.includes(after)) throw new Error(`workflows: already applied: ${label}`)
  return source.replace(before, () => after)
}

const file = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")

// Source files import their siblings as "./name.ts" so node tests load them directly; the build
// gets the written names. Every relative import must be mapped, or the build would break.
export function relink(source, names) {
  const out = source.replace(/from "\.\/([\w-]+)\.ts"/g, (match, name) => {
    if (!(name in names)) throw new Error(`workflows: unmapped import ./${name}.ts`)
    return `from "./${names[name]}"`
  })
  if (/from "\.\/[\w-]+\.ts"/.test(out)) throw new Error("workflows: unmapped .ts import")
  return out
}

/** The build default of workflows.enabled (infiniteoc.json options.workflows.enabled); settings.json wins. */
export const buildDefault = (options) => options?.workflows?.enabled === true

export function settingsSource(source, enabled) {
  const anchor = "  enabled: false,\n  maxParallel"
  if (source.split(anchor).length !== 2) throw new Error("workflows: expected one source anchor: settings DEFAULTS.enabled")
  return enabled ? source.replace(anchor, "  enabled: true,\n  maxParallel") : source
}

const CORE = "packages/core/src/plugin"
const FEATURES = "packages/tui/src/infiniteoc-features"
const coreNames = { claude: "infiniteoc-wf-claude.js", pool: "infiniteoc-wf-pool.js", dag: "infiniteoc-wf-dag.js", mailbox: "infiniteoc-wf-mailbox.js", models: "infiniteoc-wf-models.js", settings: "infiniteoc-wf-settings.js", store: "infiniteoc-wf-store.js" }
const tuiNames = { dag: "workflows-dag", settings: "workflows-settings", store: "workflows-store" }

// safe-guard's /readonly refuses editing subagents; a workflow step with an editing agent is one too.
const READONLY_ANCHOR = '        if (event.tool === "subagent" && !["explore", "reviewer", "researcher"].includes(agent)) return Effect.fail(new Tool.Error({ message: readonlyRefusal(`the ${agent || "general"} subagent (it can edit)`) }))\n'
const READONLY_WORKFLOW = `        // mods/workflows: every workflow step is a subagent, so the same rule applies to each step's agent.
        if (event.tool === "workflow") {
          const steps = (event.input as { steps?: unknown })?.steps
          const editing = Array.isArray(steps) ? steps.map((step) => String((step as { agent?: unknown })?.agent ?? "general")).find((name) => !["explore", "reviewer", "researcher"].includes(name)) : undefined
          if (editing) return Effect.fail(new Tool.Error({ message: readonlyRefusal(\`a workflow with the \${editing} subagent (it can edit)\`) }))
        }
`

const NO_SNAPSHOT = `// Written by mods/workflows. Sessions whose model steps skip git snapshots: read-only workflow steps
// (the plugin adds them when they start and removes them when they end).
export const sessions = new Set<string>()
`

export default {
  id: "workflows",
  version: "1.0.0",
  async setup(api) {
    const enabled = buildDefault(api.options)
    const settings = settingsSource(await file("settings.ts"), enabled)

    // Server: pure modules plus the plugin, registered right after upstream's subagent tool. The plugin
    // imports mods/infiniteoc's background registry (core/src/infiniteoc/background.ts) so /goal waits for runs.
    await api.write(`${CORE}/infiniteoc-wf-settings.ts`, settings)
    for (const name of ["claude", "dag", "mailbox", "models", "pool", "store"]) await api.write(`${CORE}/infiniteoc-wf-${name}.ts`, relink(await file(`${name}.ts`), coreNames))
    await api.write(`${CORE}/infiniteoc-workflows.ts`, relink(await file("plugin.ts"), coreNames))
    await api.patch(`${CORE}/internal.ts`, (source) => {
      source = replace(source, 'import { SubagentTool } from "../tool/plugin/subagent.js"\n', 'import { SubagentTool } from "../tool/plugin/subagent.js"\nimport * as InfiniteocWorkflows from "./infiniteoc-workflows.js"\n')
      return replace(source, "  SubagentTool.Plugin,\n", "  SubagentTool.Plugin,\n  InfiniteocWorkflows.Plugin,\n")
    })

    // Read-only workflow steps skip the per-step git snapshots: their start and end trees are always the
    // same, and the 8 git processes per model step were ~80% of a step's server time (measured).
    await api.write(`packages/core/src/infiniteoc/no-snapshot.ts`, NO_SNAPSHOT)
    await api.patch("packages/core/src/session/runner/step.ts", (source) => {
      source = replace(source, 'import { Snapshot } from "../../snapshot.js"\n', 'import { Snapshot } from "../../snapshot.js"\nimport * as NoSnapshot from "../../infiniteoc/no-snapshot.js"\n')
      source = replace(
        source,
        "    const pendingStartSnapshot = yield* snapshots.capture().pipe(Effect.forkScoped)\n",
        "    const skipSnapshot = NoSnapshot.sessions.has(input.sessionID)\n    const pendingStartSnapshot = yield* (skipSnapshot ? Effect.succeed(undefined) : snapshots.capture()).pipe(Effect.forkScoped)\n",
      )
      return replace(source, "          const snapshot = yield* snapshots.capture()\n", "          const snapshot = skipSnapshot ? undefined : yield* snapshots.capture()\n")
    })

    // safe-guard (when enabled before this mod): /readonly also covers workflow steps.
    const safety = `${CORE}/infiniteoc-safety.ts`
    const guarded = await api.read(safety).then((source) => source.includes(READONLY_ANCHOR), () => false)
    if (guarded) await api.patch(safety, (source) => replace(source, READONLY_ANCHOR, READONLY_ANCHOR + READONLY_WORKFLOW, "safe-guard readonly subagent rule"))

    // TUI: shared store for /workflows, the sidebar/footer progress plugin and the settings dialog.
    await api.write(`${FEATURES}/workflows-settings.ts`, settings)
    await api.write(`${FEATURES}/workflows-dag.ts`, relink(await file("dag.ts"), tuiNames))
    await api.write(`${FEATURES}/workflows-store.ts`, relink(await file("store.ts"), tuiNames))
    await api.write("packages/tui/src/feature-plugins/system/infiniteoc-workflows.tsx", await file("tui/progress.tsx"))
    await api.patch("packages/tui/src/plugin/builtins.ts", (source) => {
      source = replace(source, 'import Notifications from "../feature-plugins/system/notifications"\n', 'import Notifications from "../feature-plugins/system/notifications"\nimport InfiniteocWorkflows from "../feature-plugins/system/infiniteoc-workflows"\n')
      return replace(source, "  Notifications,\n", "  Notifications,\n  InfiniteocWorkflows,\n")
    })

    // /settings → InfiniteOC Settings → Workflows (the dialog mods/infiniteoc installs).
    await api.write("packages/tui/src/component/workflows-settings.ts", settings)
    const dialogSection = await file("tui/settings-dialog.txt")
    await api.patch("packages/tui/src/component/dialog-infiniteoc.tsx", (source) => {
      source = replace(source, 'import { loadSettings, saveSettings, saveProvider, deleteProvider, validateProvider, validateTraffic } from "./settings-store"\n',
        'import { loadSettings, saveSettings, saveProvider, deleteProvider, validateProvider, validateTraffic } from "./settings-store"\nimport { applyChange as workflowsChange, normalize as workflowsNormalize } from "./workflows-settings"\n')
      source = replace(source, "  function traffic() {\n", `${dialogSection}  function traffic() {\n`)
      source = replace(source, '      { title: "Updates", value: "updates",',
        '      { title: "Workflows", value: "workflows", description: "Background subagent workflows and automatic model choice", footer: workflowsNormalize((current as Record<string, any>).workflows).enabled ? "on" : "off" },\n      { title: "Updates", value: "updates",')
      return replace(source, '    if (option.value === "updates") updates()\n', '    if (option.value === "updates") updates()\n    if (option.value === "workflows") workflowsSettings()\n')
    })

    api.tui.command({
      id: "workflows",
      title: "Workflows: progress, cancel, settings",
      slash: "workflows",
      aliases: ["wf"],
      category: "Agent",
      source: await file("tui/command.tsx"),
    })
  },
}
