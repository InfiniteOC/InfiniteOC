import test from "node:test"
import assert from "node:assert/strict"
import mod from "./index.mjs"

test("clearall registers without deletes", async () => {
  const commands = []
  await mod.setup({
    tui: { command: input => commands.push(input) },
  })
  assert.equal(commands.length, 1)
  assert.equal(commands[0].slash, "clearall")
  assert.match(commands[0].source, /ctx\.tabs\.closeAll\(\)/)
  assert.doesNotMatch(commands[0].source, /\.destroy|\.remove\(|\.delete\(|\.interrupt\(|\.prompt\(/i)
})
