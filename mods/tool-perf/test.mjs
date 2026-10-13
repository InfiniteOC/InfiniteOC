import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import module from "node:module"
import path from "node:path"
import { applyMods } from "../../src/mod-loader.mjs"
import mod, { patches } from "./index.mjs"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")
const hasUpstream = existsSync(upstream)
const canStrip = typeof module.stripTypeScriptTypes === "function"
const EDIT = "packages/core/src/tool/plugin/edit.ts"
const WRITE = "packages/core/src/tool/plugin/write.ts"

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

test("touches only edit.ts and write.ts internals, no permission or message changes", async () => {
  const { writes, patched, commands } = await register()
  assert.equal(writes.length, 0)
  assert.equal(commands.length, 0)
  assert.equal(patched.length, 3)
  assert.deepEqual([...new Set(patched.map(([file]) => file))].sort(), [EDIT, WRITE].sort())
  const added = patched.map(([, , after]) => after).join("\n")
  assert.doesNotMatch(added, /Permission\.assert|effect:\s*"(allow|deny)"|save:\s*\[/)
  for (const message of [
    "Could not find oldString in",
    "expected exactly one. Add more surrounding context",
    "Unable to edit",
    "Unable to write",
  ]) {
    const hits = patched.filter(([, before, after]) => before.includes(message) || after.includes(message))
    assert.equal(hits.length, 0, `message text must be untouched: ${message}`)
  }
})

test("anchors are unique in the pinned upstream and apply in order", { skip: hasUpstream ? false : "run `node bin/infiniteoc.mjs setup` first" }, async () => {
  const sources = new Map()
  for (const [file, before, after] of patches) {
    const source = sources.get(file) ?? (await readFile(path.join(upstream, file), "utf8"))
    assert.equal(source.split(before).length, 2, `${file}: anchor not unique`)
    sources.set(file, source.replace(before, () => after))
  }
  const edit = sources.get(EDIT)
  // Security order preserved: the permission gate still precedes match failures.
  assert.ok(edit.indexOf("permission.assert({") < edit.indexOf("Could not find oldString in"))
  assert.ok(edit.indexOf("permission.assert({") < edit.indexOf("expected exactly one"))
  // write.ts still reads exactly twice; the post-write read moved after the formatter check.
  const write = sources.get(WRITE)
  assert.equal(write.split("FileMutation.readText").length - 1, 2)
  assert.ok(write.indexOf("formatter.file(target.absolute)") < write.lastIndexOf("FileMutation.readText"))
  assert.match(edit, /expectedNorm/)
  assert.match(edit, /parts\.join\(""\)/)
})

const strip = (code) => module.stripTypeScriptTypes(code)

// Deterministic PRNG: the fuzz below must never be flaky.
const rand = (() => {
  let state = 0x2f6e2b29
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
})()
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const UNICODE = ["'", "\u2018", "\u2019", '"', "\u201c", "-", "\u2013", "\u2014", " ", "\u00a0", "\u2003", "e", "a", "r", "t", "\t"]
const ENDINGS = ["\n", "\n", "\n", "\r\n", ""]

function randomContent() {
  const lines = Math.floor(rand() * 12)
  let out = ""
  for (let i = 0; i < lines; i++) {
    const len = Math.floor(rand() * 14)
    let line = ""
    for (let j = 0; j < len; j++) line += pick(UNICODE)
    if (rand() < 0.2) line += " ".repeat(Math.floor(rand() * 3))
    out += line + (i === lines - 1 && rand() < 0.5 ? "" : pick(ENDINGS))
  }
  return out
}

function mutate(text) {
  return [...text].map((ch) =>
    ch === "'" && rand() < 0.7 ? pick(["'", "\u2018", "\u2019"]) :
    ch === '"' && rand() < 0.7 ? pick(['"', "\u201c", "\u201d"]) :
    ch === "-" && rand() < 0.7 ? pick(["-", "\u2013", "\u2014"]) :
    ch === " " && rand() < 0.4 ? pick([" ", "\u00a0", "\u2003"]) : ch,
  ).join("")
}

function loadMatchers(source) {
  const start = source.indexOf("const normalizeForMatch")
  const end = source.indexOf("/** Deferred edit behavior")
  assert.ok(start !== -1 && end > start)
  const factory = new Function(`${strip(source.slice(start, end))}; return { normalizeForMatch, findOccurrences, findLineOccurrences };`) // eslint-disable-line
  return factory()
}

function loadAssembly(block) {
  return new Function("source", "matches", "newString", "input", `${strip(block)}; return replaced;`) // eslint-disable-line
}

test("old and new matcher + assembly agree on fuzzed cases", { skip: !hasUpstream ? "run `node bin/infiniteoc.mjs setup` first" : (!canStrip ? "needs Node type stripping" : false) }, async () => {
  const pristine = await readFile(path.join(upstream, EDIT), "utf8")
  let patchedSource = pristine
  for (const [file, before, after] of patches) {
    if (!file.endsWith("edit.ts")) continue
    assert.equal(patchedSource.split(before).length, 2)
    patchedSource = patchedSource.replace(before, () => after)
  }
  const oldFns = loadMatchers(pristine)
  const newFns = loadMatchers(patchedSource)
  const oldAsm = loadAssembly(patches[1][1])
  const newAsm = loadAssembly(patches[1][2])
  const NEWSTRINGS = ["X", "", "$&$'Accent-\u00e9", "multi\nline\n$", "a".repeat(50)]
  const hit = { exact: 0, uni: 0, line: 0 }
  for (let i = 0; i < 400; i++) {
    const content = randomContent()
    const mode = rand()
    let search
    if (mode < 0.35 && content.length > 0) {
      const at = Math.floor(rand() * content.length)
      search = content.slice(at, at + Math.floor(rand() * 30))
    } else if (mode < 0.55 && content.length > 0) {
      const at = Math.floor(rand() * content.length)
      search = mutate(content.slice(at, at + Math.floor(rand() * 30)))
    } else if (mode < 0.75 && content.includes("\n")) {
      // Whole lines differing only in trailing whitespace: exact and unicode
      // matching fail, the per-line fallback must find it.
      const rows = content.split("\n")
      const from = Math.floor(rand() * rows.length)
      const to = Math.min(rows.length, from + 1 + Math.floor(rand() * 4))
      search = rows
        .slice(from, to)
        .map((line) => line.replace(/[\\r ]+$/, "") + (rand() < 0.6 ? " ".repeat(Math.floor(rand() * 3)) : ""))
        .join("\n")
      if (search.trim() === "") search = "x"
    } else {
      search = Array.from({ length: Math.floor(rand() * 20) }, () => pick(UNICODE)).join("")
      if (rand() < 0.5) search += "\n"
    }
    if (search === "") search = "x"
    // Mirror the tool's fallback chain with each implementation's own
    // (unchanged, shared) normalizer.
    const runChain = (fns) => {
      const exact = fns.findOccurrences(content, search)
      if (exact.length > 0) return exact
      const uni = fns.findOccurrences(fns.normalizeForMatch(content), fns.normalizeForMatch(search))
      if (uni.length > 0) return uni
      return fns.findLineOccurrences(content, search)
    }
    const a = runChain(oldFns)
    const b = runChain(newFns)
    assert.deepEqual(b, a, `matcher diverged for ${JSON.stringify({ content, search })}`)
    if (oldFns.findOccurrences(content, search).length > 0) hit.exact++
    else if (oldFns.findOccurrences(oldFns.normalizeForMatch(content), oldFns.normalizeForMatch(search)).length > 0) hit.uni++
    else if (oldFns.findLineOccurrences(content, search).length > 0) hit.line++
    for (const replaceAll of [false, true]) {
      const newString = pick(NEWSTRINGS)
      const input = { replaceAll }
      assert.equal(
        newAsm(content, b, newString, input),
        oldAsm(content, a, newString, input),
        `assembly diverged for ${JSON.stringify({ content, search, newString, replaceAll })}`,
      )
    }
  }
  // Every fallback tier must actually have been exercised, or the equivalence
  // proof is vacuous.
  assert.ok(hit.uni > 5, `unicode path hit only ${hit.uni}x`)
  assert.ok(hit.line > 5, `line path hit only ${hit.line}x`)
})

test("applyMods succeeds on the pinned tree and fails closed otherwise", { skip: hasUpstream ? false : "run `node bin/infiniteoc.mjs setup` first" }, async (t) => {
  const tree = async (mutate) => {
    const root = await mkdtemp(path.join(tmpdir(), "tool-perf-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    for (const file of [EDIT, WRITE]) {
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
  await assert.rejects(applyMods([mod], clean), /anchor|incompatible|did not change/)
  const [firstFile, firstBefore] = patches[0]
  await assert.rejects(
    applyMods([mod], await tree((file, content) => (file === firstFile ? content.replace(firstBefore, "") : content))),
    /anchor|incompatible|did not change/,
  )
  await assert.rejects(
    applyMods([mod], await tree((file, content) => (file === firstFile ? content.replace(firstBefore, `${firstBefore}\n${firstBefore}`) : content))),
    /anchor|incompatible|did not change/,
  )
})
