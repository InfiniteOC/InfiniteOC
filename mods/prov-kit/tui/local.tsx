import type { FeatureContext } from "./api"
import { providerConfigFile, saveProvider } from "../component/settings-store"
import { parseLocalModels, type LocalRuntime } from "./prov-lib"

const RUNTIMES = [
  { id: "ollama", name: "Ollama", root: "http://127.0.0.1:11434", probe: "/api/tags", baseURL: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", name: "LM Studio", root: "http://127.0.0.1:1234", probe: "/v1/models", baseURL: "http://127.0.0.1:1234/v1" },
] as const

// Loopback only: nothing leaves the machine.
async function detect(): Promise<LocalRuntime[]> {
  const found = await Promise.all(
    RUNTIMES.map(async (runtime) => {
      try {
        const response = await fetch(runtime.root + runtime.probe, { signal: AbortSignal.timeout(1500) })
        const models = parseLocalModels(runtime.id, await response.json())
        return models.length ? [{ id: runtime.id, name: runtime.name, baseURL: runtime.baseURL, models }] : []
      } catch {
        return []
      }
    }),
  )
  return found.flat()
}

export async function run(ctx: FeatureContext) {
  const runtimes = await detect()
  if (!runtimes.length) return ctx.toast.show({ variant: "info", title: "Local models", message: "No running Ollama (port 11434) or LM Studio (port 1234) with models found." })
  const choice = await ctx.ui.select({
    title: "Local models found",
    options: runtimes.map((runtime) => ({ title: `${runtime.name} · ${runtime.models.length} models`, value: runtime.id, description: runtime.baseURL })),
  })
  const runtime = runtimes.find((item) => item.id === choice)
  if (!runtime) return
  const ok = await ctx.ui.confirm({
    title: `Add ${runtime.name} as a provider?`,
    message: `Writes provider "${runtime.id}" (${runtime.baseURL}) with ${runtime.models.length} models (${runtime.models.slice(0, 4).join(", ")}${runtime.models.length > 4 ? ", ..." : ""}) to ${providerConfigFile()}. Existing providers and keys are kept and a backup is saved.`,
    label: { confirm: "Add provider", cancel: "Cancel" },
  })
  if (!ok) return
  try {
    const saved = await saveProvider({ id: runtime.id, protocol: "openai-completions", baseURL: runtime.baseURL, models: runtime.models })
    ctx.toast.show({ variant: "success", title: "Local models", message: `Added ${saved.id}. Restart InfiniteOC, then pick one of its models in /models. For offline use, run /routing local ${saved.id}/${saved.models[0]}.`, duration: 12000 })
  } catch (error) {
    // The store's own messages are safe to show; an existing provider is left untouched.
    ctx.toast.show({ variant: "warning", title: "Local models", message: error instanceof Error ? error.message : "Could not save the provider." })
  }
}
