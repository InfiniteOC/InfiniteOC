import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import module from "node:module"
import path from "node:path"
import mod, { SKILL_ENTRIES, patches } from "./index.mjs"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")
const hasUpstream = existsSync(upstream)
const canStrip = typeof module.stripTypeScriptTypes === "function"

test("patches only the skill catalog renderer and the Code Mode inline budget", async () => {
  const patched = []
  await mod.setup({
    async write() { throw new Error("unexpected write") },
    async patch() { throw new Error("unexpected patch") },
    async patchExact(file, before, after) { patched.push([file, before, after]) },
    tui: { command: () => { throw new Error("unexpected command") } },
    on: () => {},
  })
  assert.deepEqual(patched.map(([file]) => path.basename(file)), ["instructions.ts", "catalog.ts"])
})

test("anchors are unique in the pinned upstream", { skip: hasUpstream ? false : "run `node bin/infiniteoc.mjs setup` first" }, async () => {
  for (const [file, before] of patches) {
    const source = await readFile(path.join(upstream, file), "utf8")
    assert.equal(source.split(before).length, 2, `${file}: anchor not unique`)
  }
})

test("renders one short line per skill and keeps ids exact", { skip: canStrip ? false : "needs module.stripTypeScriptTypes" }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lean-context-"))
  try {
    const file = path.join(dir, "entries.mjs")
    await writeFile(file, module.stripTypeScriptTypes(`type Summary = { id: string; name: string; description: string }\n${SKILL_ENTRIES[1]}\nexport { entries, brief }`))
    const { entries, brief } = await import(file)
    const long = "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx). Triggers include: any mention of Word. Do NOT use for PDFs."
    const lines = entries([
      { id: "docx", name: "docx", description: long },
      { id: "opencode", name: "OpenCode", description: "Configure OpenCode itself.\nMore detail here." },
      { id: "tiny", name: "tiny", description: "Short." },
    ])
    assert.deepEqual(lines, [
      "- docx: Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx).",
      "- opencode (OpenCode): Configure OpenCode itself.",
      "- tiny: Short.",
    ])
    const capped = brief("word ".repeat(80))
    assert.ok(capped.length <= 160 && capped.endsWith("..."))
    // Abbreviations and versions inside the first 20 chars do not cut the sentence short.
    assert.equal(brief("Use e.g. v1.2 of the tool here. Second."), "Use e.g. v1.2 of the tool here.")
  } finally { await rm(dir, { recursive: true, force: true }) }
})
