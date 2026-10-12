import type { FeatureContext } from "./api"
import { existsSync, readFileSync } from "node:fs"
import { envDiff, formatEnvDiff } from "./prov-lib"

// Names only: values are parsed just far enough to tell an empty key from a set one and are never shown.
export async function run(ctx: FeatureContext) {
  const example = [".env.example", ".env.sample", ".env.template"].find((name) => existsSync(name))
  if (!example) return ctx.toast.show({ variant: "info", title: "Env diff", message: "No .env.example, .env.sample or .env.template in this directory." })
  const env = [".env", ".env.local"].find((name) => existsSync(name))
  const message = env
    ? formatEnvDiff(envDiff(readFileSync(example, "utf8"), readFileSync(env, "utf8")), { example, env })
    : `No .env file yet; copy ${example} to .env and fill it in.`
  ctx.ui.set({ size: "large" })
  await ctx.ui.alert({ title: "Env diff (names only)", message })
}
