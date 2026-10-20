import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { ensureBuilt, wantsInfinitui } from "./build.mjs"

const handler = "packages/cli/src/commands/handlers/default.ts"

// The default (interactive) command hands the resolved server to the Go TUI instead of OpenTUI when the
// launcher hook set INFINITEOC_GO_TUI. serve/run/mini and every other subcommand are untouched, and a
// last-good launch (no hooks) never sets the variable, so it always gets the classic interface.
export const patches = [
  [handler, 'import { errorMessage } from "../../util/error"',
    'import { errorMessage } from "../../util/error"\nimport { infinituiHandoff, infinituiRun, INFINITUI_FALLBACK } from "../../infiniteoc/infinitui"'],
  // /classic hands the open session to the classic UI.
  [handler, "        sessionID: sessionExists ? session : undefined,\n        newSessionID: sessionExists ? undefined : session,",
    "        sessionID: infinituiHandoff() ?? (sessionExists ? session : undefined),\n        newSessionID: infinituiHandoff() || sessionExists ? undefined : session,"],
  [handler, "    const updater = yield* Updater.Service\n",
    `    const infinitui = process.env.INFINITEOC_GO_TUI
    if (infinitui) {
      const code = yield* Effect.promise(() =>
        infinituiRun(infinitui, {
          url: server.endpoint.url,
          password: server.endpoint.auth?.password,
          version: OPENCODE_VERSION,
          continue: input.continue,
          sessionID: sessionExists ? session : undefined,
          newSessionID: sessionExists ? undefined : session,
          prompt: Option.getOrUndefined(input.prompt),
          auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
        }),
      )
      if (code !== INFINITUI_FALLBACK) {
        process.exitCode = code
        return
      }
    }
    const updater = yield* Updater.Service
`],
]

const modDir = path.dirname(fileURLToPath(import.meta.url))

export default {
  id: "infinitui",
  version: "0.1.0",
  async setup(api) {
    await api.write("packages/cli/src/infiniteoc/infinitui.ts", await readFile(new URL("./launch.ts", import.meta.url), "utf8"))
    for (const [file, before, after] of patches) await api.patchExact(file, before, after)
  },
  async beforeLaunch(context) {
    if (!(await wantsInfinitui(context))) return
    try {
      context.env.INFINITEOC_GO_TUI = await ensureBuilt({ modDir, home: context.env.INFINITEOC_HOME || path.resolve(modDir, "../.."), env: context.env })
    } catch (error) {
      const prior = typeof context.env.INFINITEOC_NOTICE === "string" && context.env.INFINITEOC_NOTICE
      const notice = `InfiniTUI unavailable, using the classic UI: ${error.message}`
      context.env.INFINITEOC_NOTICE = [prior, notice].filter(Boolean).join(" · ")
    }
  },
}
