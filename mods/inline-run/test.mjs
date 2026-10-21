import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import mod, { patches, RUN } from "./index.mjs"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")

test("patches only the server process entry and the run handler", async () => {
  const files = []
  await mod.setup({ async write() { throw new Error("unexpected write") }, async patch() { throw new Error("unexpected patch") }, async patchExact(file) { files.push(file) }, tui: { command() {} }, on() {} })
  assert.deepEqual([...new Set(files)], ["packages/cli/src/server-process.ts", "packages/cli/src/commands/handlers/run.ts"])
})

test("anchors are unique in the pinned upstream and leave the webui mod's anchor intact", { skip: existsSync(upstream) ? false : "run `node bin/infiniteoc.mjs setup` first" }, async () => {
  const sources = new Map()
  for (const [file, before, after] of patches) {
    const source = sources.get(file) ?? (await readFile(path.join(upstream, file), "utf8"))
    assert.equal(source.split(before).length, 2, `${file}: ${before.split("\n")[0]}`)
    sources.set(file, source.replace(before, () => after))
  }
  // mods/webui patches this line of server-process.ts after this mod runs.
  assert.equal(sources.get("packages/cli/src/server-process.ts").split('if (options.mode === "stdio") {').length, 2)
  const run = sources.get("packages/cli/src/commands/handlers/run.ts")
  assert.match(run, /ServerProcess\.run\(\{\s*mode: "inline"/)
  assert.match(run, /\.pipe\(Effect\.ensuring\(serving \? Fiber\.interrupt\(serving\) : Effect\.void\)\)/)
})

test("inline only under InfiniteOC, never with --server, and INFINITEOC_RUN_SUBPROCESS=1 opts out", () => {
  const condition = /const inline =\s*([^\n]+)/.exec(RUN[1])[1]
  assert.match(condition, /process\.env\.INFINITEOC === "1"/)
  assert.match(condition, /Option\.isNone\(input\.server\)/)
  assert.match(condition, /process\.env\.INFINITEOC_RUN_SUBPROCESS !== "1"/)
})
