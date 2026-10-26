import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import module from "node:module"
import path from "node:path"
import mod, { CEILING, DEFAULT_CAP, capFrom, ceiling } from "./index.mjs"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")
const skip = !existsSync(path.join(upstream, "package.json")) && "no .upstream checkout"
const [file, before] = CEILING

test("options.contextCap: default, custom, off, invalid", () => {
  assert.equal(capFrom(), DEFAULT_CAP)
  assert.equal(capFrom({ contextCap: 150_000 }), 150_000)
  assert.equal(capFrom({ contextCap: false }), undefined)
  assert.equal(capFrom({ contextCap: 0 }), undefined)
  for (const contextCap of [1000, -1, 1.5, "200k", true]) assert.throws(() => capFrom({ contextCap }), /contextCap/)
})

test("setup patches once with the configured cap, and not at all when off", async () => {
  const calls = []
  const api = (options) => ({ options, patchExact: async (...args) => calls.push(args) })
  await mod.setup(api({}))
  await mod.setup(api({ contextCap: 120_000 }))
  await mod.setup(api({ contextCap: false }))
  assert.deepEqual(calls, [ceiling(DEFAULT_CAP), ceiling(120_000)])
})

// The patched ceiling from the pinned source, with upstream's own constants.
async function patchedCeiling(cap) {
  const source = (await readFile(path.join(upstream, file), "utf8")).replace(before, () => ceiling(cap)[2])
  const constants = ["RESERVE_MIN", "RESERVE_SHARE"].map((name) => source.match(new RegExp(`^const ${name} = .*$`, "m"))[0]).join("\n")
  const start = source.indexOf("// InfiniteOC context-cap")
  const body = source.slice(start, source.indexOf("\n}\n", source.indexOf("const windowCeiling", start)) + 3)
  return new Function(`${constants.replaceAll("_000", "000")}\n${module.stripTypeScriptTypes(body)}\nreturn calculateCeiling`)()
}

test("compaction starts at the cap on large windows and unchanged below it", { skip }, async () => {
  const source = await readFile(path.join(upstream, file), "utf8")
  assert.equal(source.split(before).length, 2)
  const at = await patchedCeiling(200_000)
  assert.equal(at({ input: 0, context: 1_000_000 }, undefined), 200_000, "1M window: cap")
  assert.equal(at({ input: 0, context: 128_000 }, undefined), 108_800, "128k window: upstream's 85%")
  assert.equal(at({ input: 0, context: 1_000_000 }, 900_000), 100_000, "a configured buffer that compacts sooner still wins")
  assert.equal(at({ input: 0, context: 0 }, undefined), 200_000, "unknown window: the cap")
})
