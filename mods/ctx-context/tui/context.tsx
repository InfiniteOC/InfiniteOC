import type { FeatureContext } from "./api"
import { formatSnapshot, readSnapshot } from "./ctx-store"

export async function run(ctx: FeatureContext) {
  const route = ctx.route.data
  if (route.type !== "session") return ctx.toast.show({ variant: "info", message: "Open a session first." })
  const snapshot = readSnapshot(route.sessionID)
  if (!snapshot) return ctx.toast.show({ variant: "info", title: "Context", message: "No model request has been made in this session yet. Send a message, then run /context." })
  const shown = ctx.ui.alert({ title: "Context", message: formatSnapshot(snapshot) })
  ctx.ui.set({ size: "large" })
  await shown
}
