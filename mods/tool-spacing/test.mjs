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
const files = [`${TUI}/routes/session/index.tsx`]

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

test("patches only the transcript blocks that were padded, adds no commands or tools", async () => {
  const { writes, patched, commands } = await register()
  assert.equal(writes.length, 0)
  assert.equal(commands.length, 0)
  assert.equal(patched.length, 2)
  assert.equal(patched.length, patches.length)
  assert.deepEqual([...new Set(patched.map(([file]) => file))], files)
  for (const [, before, after] of patched) {
    // Every patch only drops the two padding lines.
    assert.equal(before.replace(/^\s*padding(Top|Bottom)=\{1\}\n/gm, ""), after)
    assert.doesNotMatch(after, /paddingTop|paddingBottom/)
  }
  // One tool block box (indent 6) and one prompt bubble box (indent 10).
  assert.match(patched[0][1], /\n      paddingTop=\{1\}\n      paddingBottom=\{1\}\n/)
  assert.match(patched[1][1], /^          paddingTop=\{1\}\n          paddingBottom=\{1\}\n          paddingLeft=\{2\}\n          backgroundColor=/m)
})

test("anchors are unique in the pinned upstream and notices keep their padding", { skip: !hasUpstream && hasUpstream }, async () => {
  const sources = new Map()
  for (const [file, before, after] of patches) {
    const source = sources.get(file) ?? (await readFile(path.join(upstream, file), "utf8"))
    assert.equal(source.split(before).length, 2, `${file}: anchor not unique`)
    sources.set(file, source.replace(before, () => after))
  }
  const view = sources.get(files[0])
  // The tool block and the prompt bubble are flush: no vertical padding left.
  assert.match(view, /<box\n      border=\{\["left"\]\}\n      flexShrink=\{0\}\n      paddingLeft=\{2\}\n      gap=\{1\}/)
  assert.match(
    view,
    /          paddingLeft=\{2\}\n          backgroundColor=\{hover\(\) \? theme\.decrease\(theme\.background\.raised\.base\) : theme\.background\.raised\.base\}\n          flexShrink=\{0\}/,
  )
  assert.doesNotMatch(view, /          paddingTop=\{1\}\n          paddingBottom=\{1\}\n/)
  // The reverted-message notice keeps its padded box.
  assert.match(
    view,
    /        paddingTop=\{1\}\n        paddingBottom=\{1\}\n        paddingLeft=\{2\}\n        backgroundColor=\{hover\(\) \? theme\.decrease\(theme\.background\.raised\.base\) : theme\.background\.raised\.base\}\n      >/,
  )
})

test("applyMods succeeds on the pinned tree and fails closed otherwise", { skip: !hasUpstream && hasUpstream }, async (t) => {
  const tree = async (mutate) => {
    const root = await mkdtemp(path.join(tmpdir(), "tool-spacing-"))
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
  assert.deepEqual([...new Set(result.changes.map((change) => change.path))], files)
  const patched = await readFile(path.join(clean, files[0]), "utf8")
  assert.doesNotMatch(patched, /      paddingTop=\{1\}\n      paddingBottom=\{1\}\n      paddingLeft=\{2\}\n      gap=\{1\}/)
  // Second application fails: the anchors are gone after patching.
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
