import { candidateFiles, preflightFile } from "./preflight.mjs"

export default {
  id: "crash-guard",
  version: "1.0.0",
  async setup(api) {
    api.on("beforeLaunch", async (context) => {
      // A dangling {file:...} reference makes upstream Config.load throw
      // ConfigInvalidError inside Effect.orDie: every endpoint answers 500 and
      // the backend crash-loops. Repair it here (backup + quarantine + notice)
      // so one bad provider or MCP server can never take the server down.
      // Fail open: config trouble must never block a launch.
      const env = { ...process.env, ...context.env }
      const warnings = []
      for (const file of candidateFiles(env)) {
        try {
          const result = await preflightFile(file)
          if (result.changed || result.warning) warnings.push(result.warning)
        } catch (error) {
          warnings.push(`crash-guard skipped ${file} (${error instanceof Error ? error.message : String(error)})`)
        }
      }
      const fresh = warnings.filter(Boolean)
      if (fresh.length) {
        for (const line of fresh) console.error(`[InfiniteOC] ${line}`)
        const prior = typeof context.env.INFINITEOC_NOTICE === "string" && context.env.INFINITEOC_NOTICE
        context.env.INFINITEOC_NOTICE = [prior, ...fresh].filter(Boolean).join(" · ")
      }
    })
  },
}
