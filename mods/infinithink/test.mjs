import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyMods } from "../../src/mod-loader.mjs"
import deliberation, { deepDeliberation } from "../deep-deliberation/index.mjs"
import mod, { guidanceSource, infinithink } from "./index.mjs"

const TARGET = "packages/core/src/infiniteoc/guidance.ts"
const marker = "// infiniteoc:guidance-extensions"
const guidance = `export const infiniteocGuidance: Record<string, string[]> = { "build": ["[InfiniteOC unified workflow]"], "general": ["[InfiniteOC worker]"] }\n${marker}\n`
const evaluate = (code) => new Function(`${code.replace(": Record<string, string[]>", "").replace("export const", "const")}; return infiniteocGuidance`)()

async function tree(t, content) {
  const root = await mkdtemp(join(tmpdir(), "infinithink-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "packages/core/src/infiniteoc"), { recursive: true })
  await writeFile(join(root, TARGET), content)
  return root
}

test("replaces deep deliberation and reaches every agent, after the other guidance mods", async (t) => {
  const root = await tree(t, guidance)
  const result = await applyMods([deliberation, mod], root)
  assert.deepEqual(result.changes.map((change) => change.mod), ["deep-deliberation", "infinithink"])
  const after = await readFile(join(root, TARGET), "utf8")
  assert.doesNotMatch(after, /\[Deep deliberation\]/)
  assert.equal(after.split(marker).length, 2)
  assert.deepEqual(evaluate(after), { build: ["[InfiniteOC unified workflow]", infinithink], general: ["[InfiniteOC worker]", infinithink] })
})

test("works without deep deliberation and keeps blocks other mods pushed", () => {
  const other = guidance.replace(marker, `infiniteocGuidance.build.push("[Tool awareness]")\n${marker}`)
  assert.deepEqual(evaluate(guidanceSource(other)).build, ["[InfiniteOC unified workflow]", "[Tool awareness]", infinithink])
})

test("fails closed on a missing marker, a second application and two deliberation blocks", async (t) => {
  assert.throws(() => guidanceSource("unrelated\n"), /expected one source anchor/)
  assert.throws(() => guidanceSource(guidanceSource(guidance)), /already applied/)
  const twice = guidance.replace(marker, `infiniteocGuidance.build.push(${JSON.stringify(deepDeliberation)})\ninfiniteocGuidance.build.push(${JSON.stringify(deepDeliberation)})\n${marker}`)
  assert.throws(() => guidanceSource(twice), /at most one/)
  const root = await tree(t, guidance)
  await applyMods([mod], root)
  await assert.rejects(applyMods([mod], root), /already applied/)
})

test("the block is short, keeps verification and grants nothing", () => {
  assert.ok(infinithink.startsWith("[InfiniThink]"))
  assert.ok(infinithink.length < 1400, `${infinithink.length} chars`)
  assert.match(infinithink, /verification rules still apply/)
  assert.match(infinithink, /grants no tool access/)
  assert.doesNotMatch(infinithink, /at least three/)
})
