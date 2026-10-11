import type { FeatureContext } from "./api"

export async function run(ctx: FeatureContext) {
  const ids = ctx.tabs.tabs().map((tab) => tab.sessionID)
  const active = ctx.tabs.current()
  const count = await ctx.tabs.closeAll()
  if (!count) return ctx.toast.show({ variant: "info", message: "No open tabs in this scope." })
  ctx.toast.show({
    variant: "success",
    title: `Closed ${count} tab${count === 1 ? "" : "s"}`,
    // Toast actions are mouse-only, so the message names the keyboard path too. The palette title
    // covers terminals that send ctrl+shift+t as ctrl+t (bound to model variant cycling).
    message: 'Saved sessions are unchanged and running tasks keep going. "Reopen closed tab" (ctrl+shift+t) reopens one at a time; /sessions reopens any.',
    // then() also reports a synchronous throw, e.g. a live-reloaded handler in a TUI built before restoreAll.
    action: { label: "Undo", run: () => void Promise.resolve().then(() => ctx.tabs.restoreAll(ids, active)).catch(ctx.toast.error) },
  })
}
