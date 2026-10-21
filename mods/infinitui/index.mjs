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

// The classic UI runs a slash command InfiniTUI handed over (/connect, /apps, /settings, /account) once it is
// registered; plugin commands appear after the plugins load. Started only for that dialog
// (INFINITEOC_CLASSIC_RETURN=1), it exits when the dialog closes, without an epilogue, and InfiniTUI comes back.
export const CLASSIC_COMMAND = ["packages/tui/src/app.tsx", `  const paths = useTuiPaths()
  let highlighted = false
`, `  const paths = useTuiPaths()
  let highlighted = false
  // InfiniteOC infinitui: a command InfiniTUI handed over runs here once, when it is reachable.
  const handedCommand = process.env.INFINITEOC_CLASSIC_COMMAND
  delete process.env.INFINITEOC_CLASSIC_COMMAND
  const handedReturn = process.env.INFINITEOC_CLASSIC_RETURN === "1"
  const reachableCommands = Keymap.useCommands()
  let handedRan = !handedCommand
  let handedOpened = false
  createEffect(() => {
    if (handedRan || !plugins.ready() || client.connection.status() !== "connected") return
    const command = reachableCommands().find(
      (item) => item.slash?.name === handedCommand || item.slash?.aliases?.includes(handedCommand!) === true,
    )
    if (!command) return
    handedRan = true
    command.run()
    // A command that opened no dialog leaves nothing to wait for.
    if (handedReturn) setTimeout(() => !handedOpened && exit(), 3000)
  })
  createEffect(() => {
    const open = dialog.stack.length > 0
    if (!handedReturn || !handedRan || !handedCommand) return
    if (open) handedOpened = true
    else if (handedOpened) exit()
  })
`]
export const QUIET_EPILOGUE = ["packages/tui/src/app.tsx", `    if (result.epilogue) process.stdout.write(result.epilogue + "\\n")`, `    // InfiniteOC infinitui: a classic UI started for one dialog hands the terminal straight back to InfiniTUI.
    if (result.epilogue && process.env.INFINITEOC_CLASSIC_RETURN !== "1") process.stdout.write(result.epilogue + "\\n")`]

const modDir = path.dirname(fileURLToPath(import.meta.url))

export default {
  id: "infinitui",
  version: "0.1.0",
  async setup(api) {
    await api.write("packages/cli/src/infiniteoc/infinitui.ts", await readFile(new URL("./launch.ts", import.meta.url), "utf8"))
    for (const [file, before, after] of [...patches, CLASSIC_COMMAND, QUIET_EPILOGUE]) await api.patchExact(file, before, after)
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
