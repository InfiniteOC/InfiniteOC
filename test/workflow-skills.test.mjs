import test from "node:test"
import assert from "node:assert/strict"
import { readFile, access } from "node:fs/promises"
import { guidance } from "../mods/infiniteoc/workflow.mjs"

const skills = new URL("../skills/", import.meta.url)

test("writing and command skills have valid metadata and resolvable references", async () => {
  for (const name of ["plain-human-writing", "efficient-tool-use"]) {
    const directory = new URL(`${name}/`, skills)
    const source = await readFile(new URL("SKILL.md", directory), "utf8")
    assert.ok(source.startsWith(`---\nname: ${name}\ndescription:`))
    for (const match of source.matchAll(/\]\((references\/[^)]+)\)/g)) await access(new URL(match[1], directory))
    assert.match(source, /always-on/i)
  }
})

test("guidance names only subagents that exist", async () => {
  // Upstream defines general and explore; mods/infiniteoc adds reviewer and researcher.
  const mod = await readFile(new URL("../mods/infiniteoc/index.mjs", import.meta.url), "utf8")
  const defined = new Set(["general", "explore", ...[...mod.matchAll(/Agent\.ID\.make\("([a-z-]+)"\)/g)].map((match) => match[1])])
  const section = guidance.build.split("[Subagents]")[1].split("[Skills]")[0]
  const named = [...section.matchAll(/^- ([a-z-]+):/gm)].map((match) => match[1])
  assert.deepEqual(named, ["explore", "researcher", "general", "reviewer"])
  for (const agent of named) assert.ok(defined.has(agent), agent)
  for (const agent of Object.keys(guidance)) assert.ok(defined.has(agent) || agent === "build", agent)
})

test("every skill ID the guidance recommends is bundled", async () => {
  const section = guidance.build.split("[Skills]")[1].split("[Replies]")[0]
  const ids = [...section.matchAll(/\b([a-z]+(?:-[a-z]+)+|impeccable)\b/g)].map((match) => match[1])
  assert.ok(ids.length >= 8, ids.join(","))
  for (const id of ids) await access(new URL(`${id}/SKILL.md`, skills))
})

test("guidance keeps safety, verification and honest reporting", () => {
  for (const text of ["nothing here grants tool access", "Never print or commit secrets", "Ask before destructive", "Verify before claiming", "could not be run", "Debug from evidence", "After two hypotheses fail"]) assert.ok(guidance.build.includes(text), text)
  assert.match(guidance.reviewer, /Stay read-only/)
  assert.match(guidance.general, /cannot ask the user questions/)
  assert.match(guidance.researcher, /primary sources/)
})
