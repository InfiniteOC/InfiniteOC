import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyMods } from "../../src/mod-loader.mjs"
import mod, { patches } from "./index.mjs"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")
const hasUpstream = existsSync(upstream) && "run `node bin/infiniteoc.mjs setup` first"
const TUI = "packages/tui/src"
const files = [`${TUI}/prompt/display.ts`, `${TUI}/component/prompt/autocomplete.tsx`]

async function register() {
  const writes = [], patched = [], commands = []
  await mod.setup({
    async write(file, content) { writes.push([file, content]) },
    async patch(file, transform) { patched.push([file, String(transform)]) },
    async patchExact(file, before, after) { patched.push([file, before, after]) },
    tui: { command: (input) => commands.push(input) },
    on: () => {},
  })
  return { writes, patched, commands }
}

test("patches only the prompt UI, adds no commands, tools, or permission code", async () => {
  const { writes, patched, commands } = await register()
  assert.equal(writes.length, 0)
  assert.equal(commands.length, 0)
  assert.ok(patched.length > 0)
  assert.equal(patched.length, patches.length)
  assert.deepEqual([...new Set(patched.map(([file]) => file))].sort(), [...files].sort())
  const added = patched.map(([, , after]) => after).join("\n")
  assert.doesNotMatch(added, /Permission|tool\(|effect:\s*"|Effect\.|allow|deny|exec|spawn/i)
  assert.match(added, /hashTriggerIndex/)
  // Debounced network search; local filtering stays on the instant signal.
  assert.match(added, /debouncedSearch/)
  assert.match(added, /query: debouncedSearch\(\)/)
})

test("anchors are unique in the pinned upstream and apply in order", { skip: !hasUpstream && hasUpstream }, async () => {
  const sources = new Map()
  for (const [file, before, after] of patches) {
    const source = sources.get(file) ?? (await readFile(path.join(upstream, file), "utf8"))
    assert.equal(source.split(before).length, 2, `${file}: anchor not unique`)
    sources.set(file, source.replace(before, () => after))
  }
  const display = sources.get(`${TUI}/prompt/display.ts`)
  const complete = sources.get(`${TUI}/component/prompt/autocomplete.tsx`)
  // The hash trigger mirrors the @ trigger exactly apart from the character.
  const at = /export function mentionTriggerIndex[\s\S]*?\n}\n/.exec(display)?.[0]
  const hash = /export function hashTriggerIndex[\s\S]*?\n}\n/.exec(display)?.[0]
  assert.ok(at && hash)
  assert.equal(hash.replaceAll("#", "@"), at.replace("mentionTriggerIndex", "hashTriggerIndex"))
  assert.match(complete, /const triggerChar = displayCharAt\(props\.value, store\.index\)/)
  assert.match(complete, /filesOnly \? fileSearch\.options : \[\]/)
  // Reference mode never falls through to slash commands, even at index 0.
  assert.match(complete, /store\.visible === "reference"\n          \? \[\]/)
  assert.match(complete, /referenceMatch = createMemo\(\(\) => \{\n    if \(store\.visible !== "reference" \|\| displayCharAt\(props\.value, store\.index\) !== "@"\) return/)
  assert.match(complete, /const prefix = displayCharAt\(props\.value, store\.index\) === "#" \? "#" : "@"/)
  assert.match(complete, /const expandPrefix = displayCharAt\(props\.value, store\.index\) === "#" \? "#" : "@"/)
  assert.match(complete, /const at = mentionTriggerIndex\(value, offset\)/)
  assert.match(complete, /"No matching files" : "No matching skills, agents, or references"|"No matching files"\n      : "No matching skills, agents, or references"/)
})

test("applyMods succeeds on the pinned tree and fails closed otherwise", { skip: !hasUpstream && hasUpstream }, async (t) => {
  const tree = async (mutate) => {
    const root = await mkdtemp(path.join(tmpdir(), "hash-mentions-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    for (const file of files) {
      await mkdir(path.join(root, path.dirname(file)), { recursive: true })
      let content = await readFile(path.join(upstream, file), "utf8")
      if (mutate) content = mutate(file, content)
      await writeFile(path.join(root, file), content)
    }
    return root
  }
  const clean = await tree()
  const result = await applyMods([mod], clean)
  assert.equal(result.changes.length, patches.length)
  assert.deepEqual([...new Set(result.changes.map((change) => change.path))].sort(), [...files].sort())
  // Second application fails: anchors are gone after patching.
  await assert.rejects(applyMods([mod], clean), /anchor|incompatible|did not change/)
  // Missing anchor fails.
  const [firstFile, firstBefore] = patches[0]
  await assert.rejects(
    applyMods([mod], await tree((file, content) => (file === firstFile ? content.replace(firstBefore, "") : content))),
    /anchor|incompatible|did not change/,
  )
  // Duplicated anchor fails.
  await assert.rejects(
    applyMods([mod], await tree((file, content) => (file === firstFile ? content.replace(firstBefore, `${firstBefore}\n${firstBefore}`) : content))),
    /anchor|incompatible|did not change/,
  )
})
