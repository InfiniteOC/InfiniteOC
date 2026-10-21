import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setFeatureEnabled } from "../src/feature-scaffold.mjs"
// Personal mods (src/user-mods.mjs) must never touch the real ~/.config/infiniteoc/mods from a test.
process.env.INFINITEOC_MODS_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "ioc-personal-mods-"))
const personalModsDir = process.env.INFINITEOC_MODS_DIR, { rmSync: removeTree } = await import("node:fs")
process.on("exit", () => removeTree(personalModsDir, { recursive: true, force: true }))

test("feature enable/disable edits only infiniteoc.json mods and keeps a backup", async t => {
  const base = await mkdtemp(path.join(tmpdir(), "ioc-"))
  t.after(() => rm(base, { recursive: true, force: true }))
  const file = path.join(base, "infiniteoc.json")
  const original = '{"upstream":"v2.0.21","mods":["./mods/a/index.mjs"],"options":{"reducedMotion":true}}'
  await writeFile(file, original)
  const read = async () => JSON.parse(await readFile(file, "utf8"))
  assert.equal(await setFeatureEnabled(base, "b", true), true)
  assert.deepEqual(await read(), { upstream: "v2.0.21", mods: ["./mods/a/index.mjs", "./mods/b/index.mjs"], options: { reducedMotion: true } })
  assert.equal(await readFile(`${file}.bak`, "utf8"), original)
  const enabled = await readFile(file, "utf8")
  assert.equal(await setFeatureEnabled(base, "b", true), false)
  assert.equal(await readFile(file, "utf8"), enabled)
  // Any spelling that resolves to the same file counts.
  await writeFile(file, '{"upstream":"v2.0.21","mods":["./mods/a/index.mjs","mods/b/index.mjs"]}')
  assert.equal(await setFeatureEnabled(base, "b", true), false)
  assert.equal(await setFeatureEnabled(base, "b", false), true)
  assert.deepEqual((await read()).mods, ["./mods/a/index.mjs"])
  assert.equal(await setFeatureEnabled(base, "b", false), false)
})
