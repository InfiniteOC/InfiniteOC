import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import module from "node:module"
import path from "node:path"
import mod, { HELPER, LAZY_INDEX, patches } from "./index.mjs"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")
const canStrip = typeof module.stripTypeScriptTypes === "function"

test("patches only the catalog normalizer, its plugin, the plugin host and the provider registry", async () => {
  const files = []
  await mod.setup({ async write() { throw new Error("unexpected write") }, async patch() { throw new Error("unexpected patch") }, async patchExact(file) { files.push(file) }, tui: { command() {} }, on() {} })
  assert.deepEqual([...new Set(files)], ["packages/core/src/models-dev.ts", "packages/core/src/plugin/models-dev.ts", "packages/core/src/plugin/host.ts", "packages/core/src/provider.ts"])
})

test("anchors are unique in the pinned upstream", { skip: existsSync(upstream) ? false : "run `node bin/infiniteoc.mjs setup` first" }, async () => {
  const sources = new Map()
  for (const [file, before, after] of patches) {
    const source = sources.get(file) ?? (await readFile(path.join(upstream, file), "utf8"))
    assert.equal(source.split(before).length, 2, `${file}: ${before.split("\n")[0]}`)
    sources.set(file, source.replace(before, () => after))
  }
})

const load = async (name, code) => {
  const dir = await mkdtemp(path.join(tmpdir(), "lazy-catalog-"))
  try {
    const file = path.join(dir, `${name}.mjs`)
    await writeFile(file, module.stripTypeScriptTypes(code))
    return await import(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("lazyModels builds once, on first read, and keeps the property enumerable", { skip: canStrip ? false : "needs module.stripTypeScriptTypes" }, async () => {
  const { lazyModels } = await load("helper", `namespace Model { export type Info = any } namespace Provider { export type Info = any }\n${HELPER[1]}`)
  let builds = 0
  const snapshot = lazyModels({ info: { id: "acme" }, environment: ["ACME_KEY"] }, () => (builds++, [{ id: "m1" }]))
  assert.equal(builds, 0)
  assert.deepEqual(Object.keys(snapshot), ["info", "environment", "models"])
  assert.equal(snapshot.models, snapshot.models)
  assert.equal(builds, 1)
  // A descriptor copy (what the plugin host now does) keeps it lazy and shares the built list.
  const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(lazyModels({ info: {} }, () => (builds++, []))))
  assert.equal(builds, 1)
  copy.models
  assert.equal(builds, 2)
})

test("LazyIndex reads like the frozen index, builds it on first access, refuses writes", { skip: canStrip ? false : "needs module.stripTypeScriptTypes" }, async () => {
  const code = LAZY_INDEX[1].split("\n").slice(1).join("\n")
  const { LazyIndex, lazyIndex, built } = await load("index", `namespace Model { export type ID = string; export type Info = any } type ID = string; type MapIterator<T> = IterableIterator<T>
let builds = 0
const index = (providerID: string, models: any[]) => (builds++, Object.freeze(new Map(models.map((m) => [m.id, m]))))
${code}
export { LazyIndex, lazyIndex }
export const built = () => builds`)
  let reads = 0
  const lazy = new LazyIndex(() => (reads++, new Map([["a", { id: "a" }], ["b", { id: "b" }]])))
  assert.ok(lazy instanceof Map)
  assert.ok(Object.isFrozen(lazy), "immer skips frozen objects, so a deep freeze does not build it")
  assert.equal(reads, 0)
  assert.equal(lazy.size, 2)
  assert.equal(lazy.get("a").id, "a")
  assert.equal(lazy.has("b"), true)
  assert.deepEqual([...lazy.keys()], ["a", "b"])
  assert.deepEqual([...lazy].map(([k]) => k), ["a", "b"])
  assert.deepEqual([...new Map(lazy).keys()], ["a", "b"])
  assert.deepEqual(Array.from(lazy.values(), (m) => m.id), ["a", "b"])
  const seen = []
  lazy.forEach((value, key, map) => seen.push([key, map === lazy]))
  assert.deepEqual(seen, [["a", true], ["b", true]])
  assert.equal(reads, 1)
  for (const write of [() => lazy.set("c", {}), () => lazy.delete("a"), () => lazy.clear()]) assert.throws(write, /frozen/)
  // Plain arrays are indexed at once, as upstream does; one getter shares one LazyIndex per provider.
  const plain = lazyIndex("p", { models: [{ id: "x" }] })
  assert.ok(!(plain instanceof LazyIndex) && plain.get("x"))
  const definition = Object.defineProperty({}, "models", { enumerable: true, get: () => [{ id: "y" }] })
  const before = built()
  const first = lazyIndex("q", definition), second = lazyIndex("q", Object.defineProperties({}, Object.getOwnPropertyDescriptors(definition)))
  assert.equal(first, second)
  assert.equal(built(), before)
  assert.equal(first.get("y").id, "y")
  assert.notEqual(lazyIndex("r", definition), first)
})
