import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, cp, access, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { checkMod } from "../skills/infiniteoc-mod-development/scripts/check-mod.mjs"

const home = resolve(import.meta.dirname, "..")
const skill = join(home, "skills/infiniteoc-mod-development")

test("mod-development skill has metadata, references, and actual API guardrails", async () => {
  const text = await readFile(join(skill, "SKILL.md"), "utf8")
  assert.match(text, /^---\nname: infiniteoc-mod-development\ndescription:/)
  for (const match of text.matchAll(/\]\((references\/[^)]+)\)/g)) await access(join(skill, match[1]))
  for (const guard of ["register-only", "Never implement persistent changes", "api.patch", "non-overlapping", "Rollback", "preserve" ]) {
    assert.ok(text.toLowerCase().includes(guard.toLowerCase()), `Missing ${guard}`)
  }
})

test("checker applies ordered mods in a disposable tree without mutating upstream/config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "infiniteoc-skill-test-"))
  try {
    await mkdir(join(dir, "src"))
    await mkdir(join(dir, ".upstream"))
    await cp(join(home, "src/mod-loader.mjs"), join(dir, "src/mod-loader.mjs"))
    await cp(join(home, "src/tui-features.mjs"), join(dir, "src/tui-features.mjs"))
    await writeFile(join(dir, ".upstream/fixture.txt"), "old\n")
    const config = JSON.stringify({ mods: [], options: { sample: true } })
    await writeFile(join(dir, "infiniteoc.json"), config)
    const result = await checkMod(join(skill, "examples/patch-fixture.mjs"), dir)
    assert.deepEqual(result.mods, ["infiniteoc-skill-smoke-fixture"])
    assert.deepEqual(result.changes, [{ mod: "infiniteoc-skill-smoke-fixture", path: "fixture.txt", action: "patch" }])
    assert.equal(await readFile(join(dir, ".upstream/fixture.txt"), "utf8"), "old\n")
    assert.equal(await readFile(join(dir, "infiniteoc.json"), "utf8"), config)
    await writeFile(join(dir, ".upstream/fixture.txt"), "missing\n")
    await assert.rejects(checkMod(join(skill, "examples/patch-fixture.mjs"), dir), /source anchor/)
    assert.equal(await readFile(join(dir, ".upstream/fixture.txt"), "utf8"), "missing\n")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("mod skill documents current live, temporary and settings interfaces without unsafe restart promises", async () => {
  const main = await readFile(join(skill, "SKILL.md"), "utf8")
  const api = await readFile(join(skill, "references/mod-api.md"), "utf8")
  const live = await readFile(join(skill, "references/live-development.md"), "utf8")
  const settings = await readFile(join(skill, "references/settings.md"), "utf8")
  const testing = await readFile(join(skill, "references/testing.md"), "utf8")
  for (const value of ["api.tui.command", "api.patchExact", "opendaemon", "scripting: true", "safe boundary"]) assert.ok(main.includes(value), value)
  for (const value of ["featureSources", "feature check", "FeatureContext", "closeAll"]) assert.ok(api.includes(value), value)
  for (const value of ["opendaemon script", "opendaemon temporary", "temporary-clear", "not sandboxed", "NOT automatically undone", "Unknown opendaemon operation", "acknowledgements", "not downloading"]) assert.ok(live.includes(value), value)
  for (const value of ["installSettings", "INFINITEOC_SETTINGS_FILE", "@ai-sdk/anthropic", "@ai-sdk/openai-compatible", "@ai-sdk/openai", "JSONC", "masked"]) assert.ok(settings.includes(value), value)
  assert.ok(testing.includes("new UI identity"))
  assert.ok(testing.includes("active agent's runtime tree"))
  await access(join(home, "examples/opendaemon/test-notification.ts"))
  await access(join(home, "examples/opendaemon/temporary-command.json"))
})