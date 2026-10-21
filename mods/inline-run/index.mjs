const cli = "packages/cli/src"

// `run` started its private server as a second process (`serve --stdio`): a second runtime to boot and the
// same modules to evaluate again before the first model request. Under InfiniteOC, `run` now starts that
// same private server inside its own process; each run still gets its own server, as before.
// `--server URL` and INFINITEOC_RUN_SUBPROCESS=1 keep the upstream path. The TUI is unchanged.

export const MODE = [`export type Mode = "default" | "service" | "stdio"`, `export type Mode = "default" | "service" | "stdio" | "inline"`]
export const OPTIONS = [`  readonly cors?: readonly string[]
}`, `  readonly cors?: readonly string[]
  /** inline: called with the address and password once the server listens in this process. */
  readonly onReady?: (url: string, password: string) => void
}`]
export const READY = [`      console.log(options.mode === "stdio" ? JSON.stringify({ url }) : \`server listening on \${url}\`)`, `      // InfiniteOC inline-run: the client in this process gets the address directly.
      if (options.mode === "inline") options.onReady?.(url, password)
      else console.log(options.mode === "stdio" ? JSON.stringify({ url }) : \`server listening on \${url}\`)`]

export const RUN_IMPORT = [`import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"`, `import { Deferred, Effect, Exit, Fiber, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerProcess } from "../../server-process"
import { ServerConnection } from "../../services/server-connection"`]
export const RUN = [`    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    yield* Effect.promise(() =>`, `    // InfiniteOC inline-run: this run's private server starts in this process instead of a child process.
    const inline =
      process.env.INFINITEOC === "1" && Option.isNone(input.server) && process.env.INFINITEOC_RUN_SUBPROCESS !== "1"
    const ready = inline ? yield* Deferred.make<ServerConnection.Resolved>() : undefined
    const serving = ready
      ? yield* (
          // ServerProcess.run provides its own layers (as for \`serve\`), so it needs nothing from here.
          ServerProcess.run({
            mode: "inline",
            onReady: (url, password) =>
              void Deferred.doneUnsafe(
                ready,
                Exit.succeed({ endpoint: { url, auth: { type: "basic" as const, username: "opencode", password } } }),
              ),
          }) as Effect.Effect<void, unknown>
        ).pipe(Effect.forkDetach)
      : undefined
    const server =
      ready && serving
        ? yield* Effect.raceFirst(
            Deferred.await(ready),
            Fiber.join(serving).pipe(Effect.andThen(Effect.fail(new Error("The InfiniteOC server stopped before it was ready")))),
          )
        : yield* ServerConnection.resolve({
            server: Option.getOrUndefined(input.server),
            standalone: input.standalone,
          })
    yield* Effect.promise(() =>`]
// The server stops when the run ends, however it ends.
export const RUN_END = [`        auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
      }),
    )
  }),
)`, `        auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
      }),
    ).pipe(Effect.ensuring(serving ? Fiber.interrupt(serving) : Effect.void))
  }),
)`]

export const patches = [
  [`${cli}/server-process.ts`, ...MODE],
  [`${cli}/server-process.ts`, ...OPTIONS],
  [`${cli}/server-process.ts`, ...READY],
  [`${cli}/commands/handlers/run.ts`, ...RUN_IMPORT],
  [`${cli}/commands/handlers/run.ts`, ...RUN],
  [`${cli}/commands/handlers/run.ts`, ...RUN_END],
]

export default {
  id: "inline-run",
  version: "0.1.0",
  async setup(api) {
    for (const [file, before, after] of patches) await api.patchExact(file, before, after)
  },
}
