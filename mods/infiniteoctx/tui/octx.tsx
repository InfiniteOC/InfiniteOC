import type { FeatureContext } from "./api"
import { describe, readState, writeState } from "./octx-store"

export async function run(ctx: FeatureContext) {
  const route = ctx.route.data
  if (route.type !== "session") return ctx.toast.show({ variant: "info", message: "Open a session first." })
  const state = readState(route.sessionID)
  const pick = ctx.ui.select({
    title: `InfiniteOCTX · ${describe(state)}`,
    options: [
      state.off
        ? { title: "Turn paging back on", value: "on", description: "old outputs page out again in batches" }
        : { title: "Turn paging off for this session", value: "off", description: "resends all outputs in full, once uncached" },
      { title: "Close", value: "close" },
    ],
  })
  ctx.ui.set({ size: "large" })
  const choice = await pick
  if (choice !== "on" && choice !== "off") return
  writeState(route.sessionID, { ...state, off: choice === "off" })
  ctx.toast.show({ variant: "success", title: "InfiniteOCTX", message: choice === "off" ? "Paging is off for this session." : "Paging is on for this session." })
}
