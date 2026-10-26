import { readFile } from "node:fs/promises"

const core = "packages/core/src"

// Environment says whether it runs on this host: a workspace location spawns elsewhere, where npx's cache on this
// host means nothing.
export const LOCAL_TYPE = [`${core}/environment/environment.ts`, `  readonly spawner: ChildProcessSpawner["Service"]
}`, `  readonly spawner: ChildProcessSpawner["Service"]
  /** InfiniteOC mcp-direct: true when processes spawn on this host (no workspace). */
  readonly local?: boolean
}`]
export const LOCAL_VALUE = [`${core}/environment/environment.ts`, `return Service.of({ files: makeFiles(driver), spawner: driver.spawner })`,
  `return Service.of({ files: makeFiles(driver), spawner: driver.spawner, local: !location.workspaceID })`]

export const IMPORT = [`${core}/mcp/stdio.ts`, `import { Environment } from "../environment/index.js"
`, `import { Environment } from "../environment/index.js"
import * as NpxDirect from "./npx-direct.js"
`]
// INFINITEOC_MCP_NPX=1 keeps npx for every server.
export const SPAWN = [`${core}/mcp/stdio.ts`, `          const handle = yield* environment.spawner.spawn(
            ChildProcess.make(options.command, [...options.args], {
              cwd: options.cwd,
              env: options.environment,`, `          // InfiniteOC mcp-direct: a pinned npx package already in npx's cache runs without the npm process.
          const direct =
            environment.local && process.env.INFINITEOC_MCP_NPX !== "1"
              ? NpxDirect.resolve(options.command, options.args)
              : undefined
          const handle = yield* environment.spawner.spawn(
            ChildProcess.make(direct?.command ?? options.command, direct?.args ?? [...options.args], {
              cwd: options.cwd,
              env: direct ? NpxDirect.environment(direct, options.environment) : options.environment,`]

export default {
  id: "mcp-direct",
  version: "1.0.0",
  async setup(api) {
    await api.write(`${core}/mcp/npx-direct.ts`, await readFile(new URL("./npx.ts", import.meta.url), "utf8"))
    for (const patch of [LOCAL_TYPE, LOCAL_VALUE, IMPORT, SPAWN]) await api.patchExact(...patch)
  },
}
