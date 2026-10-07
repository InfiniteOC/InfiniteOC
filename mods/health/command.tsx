import type { FeatureContext } from "./api"
import { daemonHealth, discoverFreeModels, probeModels } from "./health-store.mjs"

let running = false
let lastReport = "No inference probes have run."

export async function run(ctx: FeatureContext) {
  if (running) {
    ctx.toast.show({ variant: "info", title: "Model health", message: "A check is already running. " + lastReport })
    return
  }
  running = true
  try {
    const [models, daemon] = await Promise.all([discoverFreeModels(), daemonHealth()])
    ctx.toast.show({
      variant: "info", title: "Free-model health", duration: 15000,
      message: `Daemon: ${daemon}. Catalog reachable: ${models.length} free-labelled models. Not inference-tested yet.\n${lastReport}\nProbe sends one tiny prompt per model in isolated OpenCode processes (20s/model).`,
      action: { label: "Probe free models", run: () => {
        if (running) return
        running = true
        void probeModels(models, { binary: process.execPath, onResult: (result, done, total) => {
          lastReport = `${done}/${total}: ${result.id} — ${result.status}`
          ctx.toast.show({ variant: result.status === "responding" ? "success" : "warning", title: "Health progress", message: lastReport, duration: 5000 })
        } }).then(results => {
          lastReport = results.map(item => `${item.id}: ${item.status}`).join("\n")
          ctx.toast.show({ variant: results.every(item => item.status === "responding") ? "success" : "warning", title: "Health results", message: lastReport + "\nA tiny reply does not verify tool use or long-context quality.", duration: 30000 })
        }).catch(() => ctx.toast.show({ variant: "error", message: "Health check failed locally; no provider configuration was changed." })).finally(() => { running = false })
      } },
    })
  } catch {
    ctx.toast.show({ variant: "warning", title: "Health", message: "Could not read the free-model catalog. Models are not tested; this is not evidence that inference is down." })
  } finally { running = false }
}