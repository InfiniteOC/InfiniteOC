import type { FeatureContext } from "./api"

export async function run(ctx: FeatureContext) {
  const count = await ctx.tabs.closeAll()
  ctx.toast.show({
    variant: "success",
    message: `Closed ${count} session tab${count === 1 ? "" : "s"}. Saved sessions are unchanged; reopen them with /sessions. Running tasks were not interrupted.`,
  })
}