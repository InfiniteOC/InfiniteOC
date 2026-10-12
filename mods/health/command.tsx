import type { FeatureContext } from "./api"
import { daemonHealth, discoverFreeModels, healthState, meter, probeModels, type ProbeResult } from "./health-store.mjs"

const PROGRESS_TOAST_MS = 25000 // outlasts one probe (20s timeout + kill grace) until the next result replaces it

const responding = (results: ProbeResult[]) => `${results.filter(item => item.status === "responding").length}/${results.length} responding`

function notify(ctx: FeatureContext, variant: "info" | "success" | "warning" | "error", message: string, duration?: number) {
  ctx.toast.show({ variant, title: "Free-model health", message, duration })
}

// ui.select() opens its dialog synchronously; widen it so the quota notice and statuses are not clipped.
function wide<T>(ctx: FeatureContext, choice: Promise<T>) {
  ctx.ui.set({ size: "large" })
  return choice
}

export async function run(ctx: FeatureContext) {
  // A TUI built before ctx.ui existed can still live-load this handler.
  if (!ctx.ui) return notify(ctx, "warning", "Rebuild and restart InfiniteOC to use /health")
  // healthState is shared across live reloads, so a second run never starts while one is probing.
  if (healthState.progress) return notify(ctx, "info", healthState.progress, PROGRESS_TOAST_MS)
  const [models, daemon] = await Promise.all([discoverFreeModels().catch(() => undefined), daemonHealth()])
  const { report } = healthState
  if (!models && !report) return ctx.toast.show({ variant: "warning", title: "Health", message: "Could not read the free-model catalog. Models are not tested; this is not evidence that inference is down." })
  const choice = await wide(ctx, ctx.ui.select({
    title: `Free-model health · ${models ? `daemon ${daemon}` : "catalog unavailable"}`,
    options: [
      // Consent words first: the row does not wrap, so narrow terminals clip the tail.
      ...(models ? [{ title: `Probe ${models.length} free models`, value: "probe", description: "uses free-tier quota · 1 tiny prompt each, ≤20s" }] : []),
      ...(report ? [{ title: "Show last report", value: "report", footer: responding(report) }] : []),
      { title: "Close", value: "close" },
    ],
  }))
  if (choice === "report" && report) return void wide(ctx, ctx.ui.select({
    title: `Free-model health · ${responding(report)}`,
    options: report.map(item => ({ title: item.id, value: item.id, footer: `${item.status} · ${(item.durationMs / 1000).toFixed(1)}s`, category: "A tiny reply does not verify tool use or long context" })),
  }))
  if (choice !== "probe" || !models) return
  if (healthState.progress) return notify(ctx, "info", healthState.progress, PROGRESS_TOAST_MS) // a run started while this menu was open
  healthState.progress = `${meter(0, models.length)} 0/${models.length}\nnow: ${models[0]} · up to 20s`
  // New toasts queue behind a hovered one. Skipping progress while any is queued keeps it to
  // one stale progress toast before the summary; ctx cannot see the hover itself.
  if (!ctx.toast.pending) notify(ctx, "info", healthState.progress, PROGRESS_TOAST_MS)
  try {
    // models is already deduplicated, so probeModels walks it in order and models[done] is in flight.
    healthState.report = await probeModels(models, { binary: process.execPath, onResult: (result, done, total) => {
      if (done === total) return // the summary covers the last result
      healthState.progress = `${meter(done, total)} ${done}/${total}\n${result.id}: ${result.status}\nnow: ${models[done]} · up to 20s`
      if (!ctx.toast.pending) notify(ctx, "info", healthState.progress, PROGRESS_TOAST_MS)
    } })
    notify(ctx, healthState.report.every(item => item.status === "responding") ? "success" : "warning", `${responding(healthState.report)} · run /health to view`, 10000)
  } catch {
    ctx.toast.show({ variant: "error", message: "Health check failed locally; no provider configuration was changed." })
  } finally { healthState.progress = undefined }
}
