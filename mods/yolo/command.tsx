import type { FeatureContext } from "./api"

type Yolo = { enabled(): boolean; inherited(): boolean; set(value: boolean): void }

const WARNING =
  "Every permission prompt in this UI is approved automatically, including file edits, writes and shell commands, " +
  "and any request waiting right now. Explicit deny rules still block, and InfiniteOC safety gates (protected paths, " +
  "git push, recursive rm, git reset --hard, ...) still ask. Lasts until /yolo again or restart."

export async function run(ctx: FeatureContext) {
  // Installed by the compiled permission context; missing in a TUI built before this mod.
  const yolo = (globalThis as Record<symbol, Yolo | undefined>)[Symbol.for("infiniteoc.yolo")]
  if (!yolo || !ctx.ui) return ctx.toast.show({ variant: "warning", title: "YOLO", message: "Rebuild and restart InfiniteOC to use /yolo" })
  if (yolo.enabled()) {
    yolo.set(false)
    return ctx.toast.show({
      variant: "info",
      title: "YOLO off",
      message: yolo.inherited()
        ? "/yolo is off, but auto-approve stays on from --auto or session.permissions = autoaccept."
        : "Permission prompts ask again.",
    })
  }
  if (yolo.inherited())
    return ctx.toast.show({
      variant: "info",
      title: "YOLO",
      message: "Auto-approve is already on from --auto or session.permissions = autoaccept; /yolo cannot turn that off.",
    })
  const ok = await ctx.ui.confirm({
    title: "Enable YOLO mode? Auto-approves edits and shell commands",
    message: WARNING,
    label: { confirm: "Enable YOLO", cancel: "Cancel" },
  })
  if (ok !== true) return
  yolo.set(true)
  ctx.toast.show({ variant: "warning", title: "YOLO on", message: "Permission prompts are auto-approved; deny rules and safety gates still hold. /yolo turns it off." })
}
