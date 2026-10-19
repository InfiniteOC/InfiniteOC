import test from "node:test"
import assert from "node:assert/strict"
import mod, { guidance, guidanceSource, internalSource } from "./index.mjs"
import octx, { internalSource as octxInternal } from "../infiniteoctx/index.mjs"
import { DUPLICATE_MIN, EXACT, cleanOutput, duplicateNote, shrinkRequest } from "./lib.ts"

test("cleanOutput shows what the terminal showed: no color codes, settled progress lines", () => {
  assert.equal(cleanOutput("\x1b[32m✓ passed\x1b[0m \x1b[1;31mfailed\x1b[m"), "✓ passed failed")
  assert.equal(cleanOutput("\x1b]0;title\x07done \x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\"), "done link")
  assert.equal(cleanOutput("Downloading  10%\rDownloading  55%\rDownloading 100%\nok"), "Downloading 100%\nok")
  assert.equal(cleanOutput("abcdef\rXY"), "XYcdef", "a shorter redraw leaves the tail, like a terminal")
  assert.equal(cleanOutput("crlf line\r\nnext\r\n"), "crlf line\nnext\n")
  assert.equal(cleanOutput("plain\ntext\n"), "plain\ntext\n")
})

test("cleanOutput counts runs of identical lines exactly, only where that is shorter", () => {
  const warn = "warning: deprecated option --legacy-peer-deps"
  assert.equal(cleanOutput([warn, warn, warn, warn, "end"].join("\n")), [warn, "[same line 3 more times]", "end"].join("\n"))
  assert.equal(cleanOutput("a\na\na\na\nb"), "a\na\na\na\nb", "short lines are cheaper to repeat")
  assert.equal(cleanOutput("\n\n\n\n"), "\n\n\n\n", "blank runs keep their layout")
  assert.equal(cleanOutput(`${warn}\n${warn}`), `${warn}\n${warn}`, "two in a row stay")
})

const call = (id, name, value) => [
  { role: "assistant", content: [{ type: "tool-call", id, name, input: {} }] },
  { role: "tool", content: [{ type: "tool-result", id, name, result: { type: "text", value } }] },
]

test("shrinkRequest: identical outputs become references; file tools keep exact text", () => {
  const big = "x".repeat(DUPLICATE_MIN)
  const colored = `\x1b[31m${"error ".repeat(100)}\x1b[0m`
  const file = `\x1b[31m${"line\n".repeat(100)}`
  const messages = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    ...call("a", "shell", big),
    ...call("b", "shell", big),
    ...call("c", "read", file),
    ...call("d", "shell", colored),
    ...call("e", "read", big),
    ...call("f", "shell", "short"),
    ...call("g", "shell", "short"),
  ]
  const before = JSON.stringify(messages)
  const result = shrinkRequest(messages)
  const value = (id) => messages.find((message) => message.content[0]?.id === id && message.role === "tool").content[0].result.value
  assert.equal(value("a"), big)
  assert.equal(value("b"), duplicateNote("a"))
  assert.equal(value("c"), file, "read output is never cleaned")
  assert.equal(value("d"), "error ".repeat(100))
  assert.equal(value("e"), duplicateNote("a"), "an exact duplicate is lossless even for file tools")
  assert.equal(value("g"), "short")
  assert.equal(result.outputs, 3)
  // Deterministic: the same history gives the same request, so the cached prefix holds.
  const again = JSON.parse(before)
  shrinkRequest(again)
  assert.equal(JSON.stringify(again), JSON.stringify(messages))
  assert.ok(EXACT.has("edit") && EXACT.has("write") && !EXACT.has("shell"))
})

test("shrinkRequest leaves errors, images and structured results alone", () => {
  const messages = [
    { role: "tool", content: [{ type: "tool-result", id: "1", name: "shell", result: { type: "error", value: "\x1b[31mboom\x1b[0m" } }] },
    { role: "tool", content: [{ type: "tool-result", id: "2", name: "shot", result: { type: "content", value: [{ type: "media", data: "x" }] } }] },
    { role: "tool", content: [{ type: "tool-result", id: "3", name: "mcp", result: { type: "json", value: { a: "\x1b[31m" } } }] },
  ]
  const before = JSON.stringify(messages)
  assert.deepEqual(shrinkRequest(messages), { outputs: 0, chars: 0 })
  assert.equal(JSON.stringify(messages), before)
})

const INTERNAL = 'import { WarmingPlugin } from "./warming.js"\nexport const plugins = [\n  WriteTool.Plugin,\n  WarmingPlugin.Plugin,\n]\n'
const ORDER = /  WriteTool\.Plugin,\n  InfiniteocTokensave\.Plugin,\n  InfiniteocOctx\.Plugin,\n  WarmingPlugin\.Plugin,/

test("runs before InfiniteOCTX whichever order the two mods are listed in", () => {
  assert.match(octxInternal(internalSource(INTERNAL)), ORDER)
  assert.match(internalSource(octxInternal(INTERNAL)), ORDER)
  assert.throws(() => internalSource(internalSource(INTERNAL)), /already applied/)
  assert.ok(octx.id === "infiniteoctx" && mod.id === "infinitokensave")
})

test("the guidance block reaches build and general, once", () => {
  const marker = "// infiniteoc:guidance-extensions"
  const source = `export const infiniteocGuidance: Record<string, string[]> = { "build": ["w"], "general": ["g"], "explore": ["e"] }\n${marker}\n`
  const out = guidanceSource(source)
  const value = new Function(`${out.replace(": Record<string, string[]>", "").replace("export const", "const")}; return infiniteocGuidance`)()
  assert.deepEqual(value, { build: ["w", guidance], general: ["g", guidance], explore: ["e"] })
  assert.throws(() => guidanceSource(out), /already applied/)
  assert.ok(guidance.length < 900)
  assert.match(guidance, /Never trade correctness for brevity/)
})
