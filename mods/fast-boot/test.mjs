import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import module from "node:module"
import path from "node:path"
import mod, { CONVERTED, PROJECTED, WILDCARD, patches } from "./index.mjs"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")
const hasUpstream = existsSync(upstream)
const canStrip = typeof module.stripTypeScriptTypes === "function"
const files = ["packages/core/src/models-dev.ts", "packages/core/src/tool/runtime.ts", "packages/core/src/integration.ts", "packages/core/src/util/wildcard.ts"]

test("patches only the catalog, tool schema conversion, integration listing and wildcard matching", async () => {
  const patched = []
  await mod.setup({
    async write() { throw new Error("unexpected write") },
    async patch() { throw new Error("unexpected patch") },
    async patchExact(target, before, after) { patched.push([target, before, after]) },
    tui: { command: () => { throw new Error("unexpected command") } },
    on: () => {},
  })
  assert.deepEqual([...new Set(patched.map(([target]) => target))], files)
  assert.equal(patched.length, 8)
})

test("anchors are unique in the pinned upstream and apply in order", { skip: hasUpstream ? false : "run `node bin/infiniteoc.mjs setup` first" }, async () => {
  const sources = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(path.join(upstream, file), "utf8")])))
  for (const [file, before, after] of patches) {
    assert.equal(sources[file].split(before).length, 2, `${file}: anchor not unique: ${before.trim().split("\n")[0]}`)
    sources[file] = sources[file].replace(before, () => after)
  }
  const source = sources[files[0]]
  // The refresh check reads the remembered entry first, and every successful read or write records it.
  assert.match(source, /const stored = known \?\? \(yield\* loadFromCache\(\)\)/)
  assert.match(source, /known = \{ updatedAt: cached\.value\.updatedAt, digest: cached\.value\.digest \}/)
  assert.match(source, /Effect\.tap\(\(\) => Effect\.sync\(\(\) => \(known = entry\)\)\)/)
  // The boot refresh waits for populate, and a populate failure does not stop the refresh loop.
  assert.match(source, /cachedGet\.pipe\(\s*Effect\.ignoreCause,\s*Effect\.andThen\(refresh\(\)/)
  assert.equal(source.split("let known").length, 2)
  // Only Effect schemas are memoized; Standard Schema vendors are asked on every call, as upstream does.
  const runtime = sources[files[1]]
  assert.match(runtime, /if \(isStandardSchema\(schema\)\) return standardJsonSchema\(schema, "input"\)/)
  assert.match(runtime, /if \(isStandardSchema\(schema\)\) return standardJsonSchema\(schema, "output"\)/)
  assert.equal(runtime.split("converted(schema,").length - 1, 2)
})

test("the refresh still decodes the cache when this process has not read it", () => {
  // refresh(force) called before any populate (tests, `models --refresh`) must see the stored entry.
  const [, , after] = patches.find(([, before]) => before.includes("const stored = yield* loadFromCache()"))
  assert.match(after, /known \?\? \(yield\* loadFromCache\(\)\)/)
})

test("Effect tool schemas convert once per schema and direction, and every caller gets a copy", { skip: canStrip ? false : "needs module.stripTypeScriptTypes" }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fast-boot-"))
  try {
    const file = path.join(dir, "converted.mjs")
    await writeFile(file, module.stripTypeScriptTypes(`namespace JsonSchema { export type JsonSchema = Record<string, unknown> }\n${CONVERTED}\nexport { converted }`))
    const { converted } = await import(file)
    const schema = {}, other = {}
    let calls = 0
    const convert = () => (calls++, { type: "object", properties: { path: { type: "string", enum: ["a", "b"] } }, required: ["path"] })
    const first = converted(schema, "input", convert)
    const second = converted(schema, "input", convert)
    assert.equal(calls, 1)
    assert.deepEqual(first, second)
    // A caller editing nested parts of its copy does not reach the next caller.
    first.properties.path.enum.push("c")
    first.required.length = 0
    assert.deepEqual(converted(schema, "input", convert).properties.path.enum, ["a", "b"])
    assert.deepEqual(converted(schema, "input", convert).required, ["path"])
    // Output conversions and other schema objects are cached separately.
    converted(schema, "output", convert)
    converted(other, "input", convert)
    assert.equal(calls, 3)
    // A failed conversion is not cached: the next registration reports the error again.
    const broken = {}
    assert.throws(() => converted(broken, "input", () => { throw new Error("bad schema") }), /bad schema/)
    assert.throws(() => converted(broken, "input", () => { throw new Error("bad schema") }), /bad schema/)
    // Values that are not plain JSON objects are passed through, not copied.
    const pattern = /x/
    assert.equal(converted({}, "input", () => ({ pattern })).pattern, pattern)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const load = async (name, code) => {
  const dir = await mkdtemp(path.join(tmpdir(), "fast-boot-"))
  const file = path.join(dir, `${name}.mjs`)
  await writeFile(file, module.stripTypeScriptTypes(code))
  try { return await import(file) } finally { await rm(dir, { recursive: true, force: true }) }
}

test("cached wildcard patterns match exactly like freshly compiled ones", { skip: canStrip ? false : "needs module.stripTypeScriptTypes" }, async () => {
  const before = await load("before", WILDCARD[0])
  const after = await load("after", WILDCARD[1])
  const patterns = ["*", "bash", "git *", "git push *", "*.env", "src/**/*.ts", "a?c", "C:\\Users\\*", "(x)+[y]{2}$^|.", "rm -rf *", "skill", "frontend-*", ""]
  const inputs = ["", "bash", "git", "git push", "git push origin main", "git status", ".env", "x.env", "src/a/b.ts", "abc", "a/c", "C:\\Users\\me", "C:/Users/me", "(x)+[y]{2}$^|.", "rm -rf /", "rm -rf", "skill", "frontend-design", "multi\nline"]
  for (let round = 0; round < 2; round++)
    for (const pattern of patterns) for (const input of inputs)
      assert.equal(after.match(input, pattern), before.match(input, pattern), `${JSON.stringify(input)} vs ${JSON.stringify(pattern)}`)
})

test("an integration's Info is reused only while its entry, connections and statuses are unchanged", { skip: canStrip ? false : "needs module.stripTypeScriptTypes" }, async () => {
  const inserted = PROJECTED[1].slice(PROJECTED[0].length)
  const { make } = await load("projected", `type Entry = any; type Info = any; namespace IntegrationConnection { export type Info = any }
export function make(statuses: Map<string, unknown>) {
  let built = 0
  const statusKey = (id: string, connection: any) => \`\${id}:\${connection.type}:\${connection.id ?? connection.name}\`
  const project = (entry: Entry, connections: any[]) => (built++, { id: entry.ref.id, connections: connections.map((c) => ({ ...c, status: statuses.get(statusKey(entry.ref.id, c)) })) })
${inserted}
  return { projected, collator, built: () => built }
}`)
  const statuses = new Map()
  const it = make(statuses)
  const entry = { ref: { id: "acme", name: "Acme" } }
  const key = [{ type: "env", name: "ACME_API_KEY" }]
  const first = it.projected(entry, key)
  assert.equal(it.projected(entry, [{ type: "env", name: "ACME_API_KEY" }]), first)
  assert.equal(it.built(), 1)
  // A new or changed connection, a status change, or a new state entry builds a new Info.
  const credential = it.projected(entry, [{ type: "credential", id: "c1", label: "work", method: "key" }])
  assert.notEqual(credential, first)
  assert.notEqual(it.projected(entry, [{ type: "credential", id: "c1", label: "home", method: "key" }]), credential)
  const labelled = it.projected(entry, [{ type: "credential", id: "c1", label: "home", method: "key" }])
  statuses.set("acme:credential:c1", { type: "error", message: "expired" })
  const failed = it.projected(entry, [{ type: "credential", id: "c1", label: "home", method: "key" }])
  assert.notEqual(failed, labelled)
  assert.deepEqual(failed.connections[0].status, { type: "error", message: "expired" })
  assert.equal(it.projected(entry, [{ type: "credential", id: "c1", label: "home", method: "key" }]), failed)
  assert.notEqual(it.projected({ ref: { id: "acme", name: "Acme" } }, [{ type: "credential", id: "c1", label: "home", method: "key" }]), failed)
  // The collator orders names exactly like localeCompare without arguments.
  const names = ["zeta", "Alpha", "alpha", "Ölkraft", "beta", "Beta", "10x", "2x", "éclair", "eclair", "_under", "Zeta"]
  assert.deepEqual(names.toSorted((a, b) => it.collator.compare(a, b)), names.toSorted((a, b) => a.localeCompare(b)))
})
