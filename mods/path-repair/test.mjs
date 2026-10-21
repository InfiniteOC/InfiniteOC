import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import module from "node:module"
import path from "node:path"
import mod, { GUARD, patches } from "./index.mjs"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")
const hasUpstream = existsSync(upstream)
const canStrip = typeof module.stripTypeScriptTypes === "function"

async function loadGuard() {
  const dir = await mkdtemp(path.join(tmpdir(), "path-repair-"))
  const file = path.join(dir, "path-guard.mjs")
  await writeFile(file, module.stripTypeScriptTypes(await readFile(new URL("./path-guard.ts", import.meta.url), "utf8")))
  try { return await import(file) } finally { await rm(dir, { recursive: true, force: true }) }
}

// Real arguments from a beam-free run: the body leaked into `path` after `">`, and is also in `content`.
const body = "const CATEGORIES = ['Food', 'Transport', 'Housing', 'Fun', 'Other'];\n\nfunction isValidDate(s) {\n  return true\n}\n"
const leaked = { path: `/tmp/p/logic.js">\n${body}`, content: body }
const html = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\" />\n</head>\n</html>\n"

test("registers the guard module and only file-tool/repair patches, no permission changes", async () => {
  const writes = [], patched = []
  await mod.setup({
    async write(file, content) { writes.push([file, content]) },
    async patch() { throw new Error("unexpected patch") },
    async patchExact(file, before, after) { patched.push([file, before, after]) },
    tui: { command: () => { throw new Error("unexpected command") } },
    on: () => {},
  })
  assert.deepEqual(writes.map(([file]) => file), [GUARD])
  assert.equal(patched.length, patches.length)
  assert.deepEqual([...new Set(patched.map(([file]) => path.basename(file)))].sort(), ["edit.ts", "patch.ts", "tool-input-repair.ts", "write.ts"])
  for (const [, before, after] of patched) {
    const count = (text) => (text.match(/permission|authorizeExternal/g) ?? []).length
    assert.equal(count(after), count(before), "permission and approval code is untouched")
  }
})

test("anchors are unique in the pinned upstream and the guard runs before resolve", { skip: hasUpstream ? false : "run `node bin/infiniteoc.mjs setup` first" }, async () => {
  const sources = new Map()
  for (const [file, before, after] of patches) {
    const source = sources.get(file) ?? (await readFile(path.join(upstream, file), "utf8"))
    assert.equal(source.split(before).length, 2, `${file}: anchor not unique`)
    sources.set(file, source.replace(before, () => after))
  }
  for (const [file, source] of sources) {
    if (!file.includes("tool/plugin/")) continue
    assert.ok(source.indexOf("pathProblem(") < source.indexOf("access.resolve({ path:"), `${file}: guard must precede resolve`)
  }
  assert.match(sources.get("packages/core/src/plugin/tool-input-repair.ts"), /repairLeakedPath\(repair\(event\.input/)
})

test("repairs a leaked body only when another argument echoes it", { skip: canStrip ? false : "needs module.stripTypeScriptTypes" }, async () => {
  const { repairLeakedPath } = await loadGuard()
  assert.deepEqual(repairLeakedPath(leaked), { path: "/tmp/p/logic.js", content: body })
  assert.equal(repairLeakedPath({ path: `index.html">\n${html}`, content: html }).path, "index.html")
  assert.equal(repairLeakedPath({ path: `styles.css" >\r\n${body}`, content: body.replaceAll("\n", "\r\n") }).path, "styles.css")
  // Edit-style input: the leak echoes newString.
  assert.equal(repairLeakedPath({ path: `a.ts">${body}`, oldString: "x", newString: body }).path, "a.ts")
  // Run 2: the leak is the real body and content holds unrelated text, so the body is written.
  assert.deepEqual(repairLeakedPath({ path: `logic.js">\n${body}`, content: "# Expense Tracker\n\nplaceholder" }), { path: "logic.js", content: body })
  // A cut-short leak that content completes keeps content ("hello" vs "hello world").
  assert.deepEqual(repairLeakedPath({ path: "test.txt\">\nhello", content: "hello world" }), { path: "test.txt", content: "hello world" })
  // Isolated run iso-new-1: arguments shifted left, so oldString repeats newString and the leak is the real oldString.
  const before = "  monthList,\n  parseExpenses,\n  formatAmount,\n} from './logic.js';"
  const after = "  monthList,\n  parseExpenses,\n  formatAmount,\n  expensesToCsv,\n} from './logic.js';"
  assert.deepEqual(repairLeakedPath({ path: `app.js">\n${before}`, oldString: after, newString: after }), { path: "app.js", oldString: before, newString: after })
  // Same shift when the leak is a prefix of newString (the edit appends lines): still the real oldString.
  const head = "  --accent: #2563eb;\n  --accent-hover: #1d4ed8;", grown = `${head}\n  --btn-bg: #2563eb;`
  assert.deepEqual(repairLeakedPath({ path: `styles.css">\n${head}`, oldString: grown, newString: grown }), { path: "styles.css", oldString: head, newString: grown })
  // Eval run a-2: the leak starts with the argument's own name; stripped before use.
  const css = "button { cursor: pointer; background: var(--primary); }", fixed = "button { cursor: pointer; background: var(--btn); }"
  assert.deepEqual(repairLeakedPath({ path: `styles.css">\noldString">\n${css}`, oldString: fixed, newString: fixed }), { path: "styles.css", oldString: css, newString: fixed })
  // Several values packed into one call (oldString"> ... newString"> ...): cannot be split back, left for the tool to refuse.
  const packed = { path: `styles.css">\noldString">\n${css}"""\nnewString">\n${fixed}`, oldString: "x y z", newString: "a b c" }
  assert.equal(repairLeakedPath(packed), packed)
  // Edit-shaped input whose leak matches nothing: left untouched for the tool to refuse.
  const unmatched = { path: `a.ts">\n${body}`, oldString: "x", newString: "y" }
  assert.equal(repairLeakedPath(unmatched), unmatched)
  // Ordinary and odd-but-valid paths are never rewritten.
  for (const input of [{ path: "src/app.ts", content: body }, { path: "a>b.txt", content: "b.txt and more" }, { path: "x", content: "" }, "not an object", { content: body }])
    assert.equal(repairLeakedPath(input), input)
})

test("refuses paths that hold file text, accepts real paths", { skip: canStrip ? false : "needs module.stripTypeScriptTypes" }, async () => {
  const { pathProblem } = await loadGuard()
  assert.match(pathProblem(leaked.path), /contains a line break.*No file was changed.*Retry with only the file path/s)
  assert.doesNotMatch(pathProblem(leaked.path), /shell/, "never steer writes around the edit gates")
  assert.match(pathProblem(`index.html"> <!DOCTYPE html> <html lang="en">`), /contains markup/)
  assert.match(pathProblem(`dir/${"a".repeat(256)}.js`), /longer than 255 bytes/)
  assert.ok(pathProblem(leaked.path).length < 500, "message stays short")
  for (const ok of ["src/app.ts", "/tmp/p/logic.js", "C:\\code\\a b\\x.ts", "pages/[id].tsx", "notes/it's fine.md", "~/x/€uro.txt", "a>b.txt"])
    assert.equal(pathProblem(ok), undefined, ok)
})
