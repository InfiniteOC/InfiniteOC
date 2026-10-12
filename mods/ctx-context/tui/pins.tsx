import path from "node:path"
import type { FeatureContext } from "./api"
import { addPin, listPins, projectRoot, removePin } from "./ctx-store"

// Pins are per session: the pinned files' current content is added to every turn.
export async function run(ctx: FeatureContext) {
  const route = ctx.route.data
  if (route.type !== "session") return ctx.toast.show({ variant: "info", message: "Open a session first." })
  const root = projectRoot(process.cwd())
  for (;;) {
    const pins = listPins(route.sessionID)
    const choice = await ctx.ui.select({
      title: `Pinned files · ${pins.length} (kept in every turn of this session)`,
      options: [{ title: "Pin a file", value: "add" }, ...pins.map((pin) => ({ title: path.relative(root, pin) || pin, value: pin, description: "Enter to unpin" }))],
    })
    if (!choice) return
    try {
      if (choice === "add") {
        const file = await ctx.ui.prompt({ title: "Pin a file", placeholder: "path relative to the project" })
        if (file) addPin(route.sessionID, path.resolve(process.cwd(), file.trim().replace(/^@/, "")))
      } else if (await ctx.ui.confirm({ title: "Unpin", message: path.relative(root, choice) })) removePin(route.sessionID, choice)
    } catch (error) {
      ctx.toast.show({ variant: "error", title: "Pins", message: error instanceof Error ? error.message : String(error) })
    }
  }
}
