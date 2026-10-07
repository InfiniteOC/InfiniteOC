import test from "node:test"
import assert from "node:assert/strict"
import { readFile, access } from "node:fs/promises"
import { workflowInstruction } from "../mods/infiniteoc/workflow.mjs"

test("writing and command skills have valid metadata and resolvable references", async () => {
  for (const name of ["plain-human-writing", "efficient-tool-use"]) {
    const directory = new URL(`../skills/${name}/`, import.meta.url)
    const source = await readFile(new URL("SKILL.md", directory), "utf8")
    assert.ok(source.startsWith(`---\nname: ${name}\ndescription:`))
    for (const match of source.matchAll(/\]\((references\/[^)]+)\)/g)) await access(new URL(match[1], directory))
    assert.match(source, /always-on/i)
  }
})

test("always-on guidance keeps replies brief without suppressing necessary information", () => {
  for (const text of ["one to three sentences", "40–120 words", "necessary facts", "explicit requests for detail", "complete code", "pretending to be human", "without loading a skill on every turn"]) assert.ok(workflowInstruction.includes(text), text)
})

test("command efficiency protects dependencies, permissions, secrets and completion checks", () => {
  for (const text of ["non-interactive", "quoted paths", "exit-status", "print secrets", "rapidly polling", "evidence-based change", "permissions", "Keep dependent actions sequential", "non-overlapping"]) assert.ok(workflowInstruction.includes(text), text)
})