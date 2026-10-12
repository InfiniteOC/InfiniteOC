import test from "node:test"
import assert from "node:assert/strict"
import { readFile, mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import mod, { patches } from "./index.mjs"
import * as logic from "./tui/logic.ts"
import * as voice from "./tui/voice.ts"

const root = path.resolve(import.meta.dirname, "../../.upstream")

test("every upstream anchor occurs exactly once in the pinned source", async () => {
  for (const [file, before] of patches) {
    const source = await readFile(path.join(root, file), "utf8")
    assert.equal(source.split(before).length, 2, `${file}: ${before.slice(0, 60)}`)
  }
})

test("setup writes the plugin files and applies every patch", async () => {
  const written = new Map()
  const patched = []
  await mod.setup({
    root,
    async write(file, content) { written.set(file, content) },
    async patchExact(file, before, after) { patched.push([file, before, after]) },
  })
  for (const file of ["index.tsx", "logic.ts", "jump.ts", "marks.tsx", "find.tsx", "tree.tsx", "minimap.tsx", "title.tsx", "palette.tsx", "changes.tsx", "split.tsx", "transcript.ts", "voice.ts", "voice-dialog.tsx"])
    assert.ok(written.has(`packages/tui/src/feature-plugins/tnav/${file}`), file)
  assert.equal(patched.length, patches.length)
})

const user = (id, text) => ({ id, type: "user", text })
const tool = (name, input, status = "completed") => ({ type: "tool", name, state: { status, input, error: status === "error" ? { message: "boom" } : undefined } })
const assistant = (id, ...content) => ({ id, type: "assistant", content })

test("messageText covers user, shell, assistant text and tool input but not reasoning", () => {
  assert.equal(logic.messageText(user("1", "hello")), "hello")
  assert.match(logic.messageText({ id: "2", type: "shell", command: "ls", output: { output: "a.txt" } }), /ls\na\.txt/)
  const text = logic.messageText(assistant("3", { type: "text", text: "answer" }, { type: "reasoning", text: "secret" }, tool("read", { path: "src/x.ts" })))
  assert.match(text, /answer/)
  assert.match(text, /read .*src\/x\.ts/)
  assert.doesNotMatch(text, /secret/)
})

test("search needs every term, ignores case and returns a snippet around the hit", () => {
  const messages = [user("a", "I like Pineapple smoothies"), user("b", "nothing here"), assistant("c", { type: "text", text: "pineapple and mango smoothies" })]
  assert.deepEqual(logic.searchMessages(messages, "PINEAPPLE smoothies").map((hit) => hit.messageID), ["a", "c"])
  assert.deepEqual(logic.searchMessages(messages, "pineapple banana"), [])
  assert.deepEqual(logic.searchMessages(messages, "   "), [])
  assert.equal(logic.searchMessages(messages, "smoothies", 1).length, 1)
  const long = `${"x ".repeat(200)}needle${" y".repeat(200)}`
  const snip = logic.snippet(long, ["needle"], 60)
  assert.match(snip, /needle/)
  assert.ok(snip.length <= 66)
})

test("forkTree nests forks under their source and scopes to one family", () => {
  const s = (id, created, fork) => ({ id, title: id, time: { created, updated: created }, fork: fork && { sessionID: fork, boundary: { type: "before", messageID: "m" } } })
  const sessions = [s("a", 1), s("b", 2, "a"), s("c", 3, "a"), s("d", 4, "b"), s("lone", 5), s("orphan", 6, "gone")]
  const rows = logic.forkTree(sessions, "d")
  assert.deepEqual(rows.map((row) => [row.session.id, row.depth]), [["a", 0], ["b", 1], ["d", 2], ["c", 1]])
  assert.deepEqual(rows.map((row) => row.prefix), ["", "├─ ", "│  └─ ", "└─ "])
  assert.deepEqual(logic.forkTree(sessions).map((row) => row.session.id), ["a", "b", "d", "c"])
  assert.deepEqual(logic.forkTree(sessions, "lone").map((row) => row.session.id), ["lone"])
  assert.deepEqual(logic.forkTree(sessions, "orphan").map((row) => row.session.id), ["orphan"])
})

test("minimap classifies turns, edits and errors and buckets by priority", () => {
  const messages = [
    user("u1", "go"),
    assistant("a1", { type: "text", text: "ok" }),
    assistant("a2", tool("write", { path: "x" })),
    assistant("a3", tool("read", { path: "nope" }, "error")),
    { id: "s1", type: "shell", command: "ls" },
    { id: "i1", type: "idle" },
  ]
  const cells = logic.minimap(messages, new Set(["a1"]), 50)
  assert.deepEqual(cells.map((cell) => cell.kind), ["user", "assistant", "edit", "error", "shell"])
  assert.equal(cells[1].marked, true)
  assert.deepEqual(logic.minimapCounts(messages), { turns: 1, edits: 1, errors: 1 })
  const squeezed = logic.minimap(messages, new Set(), 2)
  assert.equal(squeezed.length, 2)
  assert.ok(squeezed.some((cell) => cell.kind === "error"))
  assert.equal(logic.minimap(messages, new Set(), 0).length, 5)
})

test("stepBookmark walks marks in conversation order and wraps", () => {
  const order = ["a", "b", "c", "d"]
  const marks = new Set(["b", "d"])
  assert.equal(logic.stepBookmark(order, marks, undefined, 1), "b")
  assert.equal(logic.stepBookmark(order, marks, undefined, -1), "d")
  assert.equal(logic.stepBookmark(order, marks, "b", 1), "d")
  assert.equal(logic.stepBookmark(order, marks, "d", 1), "b")
  assert.equal(logic.stepBookmark(order, marks, "b", -1), "d")
  assert.equal(logic.stepBookmark(order, new Set(), "b", 1), undefined)
})

const transcript = {
  title: "Edits <demo>",
  id: "ses_1",
  created: 0,
  updated: 1000,
  messages: [
    user("u", "change it"),
    assistant("a", { type: "text", text: "done" }, tool("edit", { path: "f.ts", oldString: "a\nb", newString: "a\nc" }), tool("read", { path: "q" }, "error")),
  ],
  diffs: [{ file: "f.ts", status: "modified", additions: 1, deletions: 1, patch: "--- f.ts\n+++ f.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n" }],
}

test("markdown transcript has turns, inline tool diffs, failures and a changes section", () => {
  const md = logic.toMarkdown(transcript)
  assert.match(md, /^# Edits <demo>/)
  assert.match(md, /## User\n\nchange it/)
  assert.match(md, /```diff\n--- f\.ts\n\+\+\+ f\.ts\n-a\n-b\n\+a\n\+c\n```/)
  assert.match(md, /\*\*Tool: read\*\* \(failed: boom\)/)
  assert.match(md, /## Changes \(1 files, \+1 -1\)\n\n### f\.ts \(modified, \+1 -1\)/)
  assert.doesNotMatch(md, /_Thinking/)
})

test("html transcript escapes content and classes diff lines", () => {
  const html = logic.toHtml({ ...transcript, messages: [user("u", "<script>alert(1)</script>"), ...transcript.messages.slice(1)] })
  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /<title>Edits &lt;demo&gt;<\/title>/)
  assert.match(html, /<span class="add">\+c<\/span>/)
  assert.match(html, /<span class="del">-b<\/span>/)
  assert.match(html, /<span class="hunk">@@ -1,2 \+1,2 @@<\/span>/)
})

test("fences grow past backticks inside content", () => {
  const md = logic.toMarkdown({ ...transcript, messages: [{ id: "s", type: "shell", command: "echo", output: { output: "```inner```" } }], diffs: [] })
  assert.match(md, /````\n\$ echo\n```inner```\n````/)
})

test("slug is filesystem safe", () => {
  assert.equal(logic.slug("Fix: the /bug! (now)"), "fix-the-bug-now")
  assert.equal(logic.slug("!!!"), "session")
})

test("voice setup explains what is missing and never picks a model it cannot find", () => {
  const has = (...names) => (name) => (names.includes(name) ? `/bin/${name}` : undefined)
  const none = voice.detect(has(), {}, () => undefined)
  assert.equal(none.ok, false)
  assert.match(none.message, /whisper CLI/)
  assert.match(voice.detect(has("whisper-cli"), {}, () => undefined).message, /no recorder/)
  assert.match(voice.detect(has("whisper-cli", "ffmpeg"), {}, () => undefined).message, /no ggml model/)
  const ok = voice.detect(has("whisper-cli", "sox"), {}, () => "/m/ggml-base.bin")
  assert.deepEqual([ok.ok, ok.flavor, ok.recorder, ok.model], [true, "cpp", "sox", "/m/ggml-base.bin"])
  const python = voice.detect(has("whisper", "ffmpeg"), {}, () => undefined)
  assert.deepEqual([python.ok, python.flavor], [true, "python"])
})

test("findModel honours the env override and prefers base over larger models", () => {
  assert.equal(voice.findModel({ INFINITEOC_WHISPER_MODEL: "/x.bin" }, "/h", (file) => file === "/x.bin"), "/x.bin")
  assert.equal(voice.findModel({ INFINITEOC_WHISPER_MODEL: "/missing.bin" }, "/h", () => false), undefined)
  const dir = "/h/.cache/whisper.cpp"
  const found = voice.findModel({}, "/h", (file) => file === dir, () => ["ggml-large-v3.bin", "ggml-base.en.bin", "ggml-small.bin", "notes.txt"])
  assert.equal(found, `${dir}/ggml-base.en.bin`)
})

test("recorder and whisper arguments per platform", () => {
  assert.deepEqual(voice.recordArgs("ffmpeg", "a.wav", "darwin").slice(4, 8), ["-f", "avfoundation", "-i", ":default"])
  assert.ok(voice.recordArgs("ffmpeg", "a.wav", "linux").includes("pulse"))
  assert.deepEqual(voice.recordArgs("sox", "a.wav").slice(-1), ["a.wav"])
  assert.deepEqual(voice.transcribeArgs({ flavor: "cpp", model: "/m.bin" }, "a.wav", "/o"), ["-m", "/m.bin", "-f", "a.wav", "-nt", "-np"])
  assert.ok(voice.transcribeArgs({ flavor: "python" }, "a.wav", "/o").includes("--output_dir"))
  assert.equal(voice.cleanTranscript("[00:00:00.000 --> 00:00:02.000]   hello there\n\n  general kenobi \n"), "hello there general kenobi")
})
