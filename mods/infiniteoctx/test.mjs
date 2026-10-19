import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import mod, { internalSource, policySource } from "./index.mjs"
import { DEFAULT_POLICY, PINNED, RECALL, applyPaging, candidates, nextBatch, resultText, stub } from "./lib.ts"

const tmp = async (t, prefix = "octx-") => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// A conversation of `steps` assistant steps, each calling one tool with an output of `size` chars.
function conversation(steps, size = 4000, name = "read") {
  const messages = [{ role: "user", content: [{ type: "text", text: "go" }] }]
  for (let i = 1; i <= steps; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool-call", id: `call_${i}`, name, input: { path: `/f${i}` } }] })
    const text = Array.from({ length: 40 }, (_, line) => `step ${i} line ${line} `.padEnd(size / 40 - 1, "x")).join("\n")
    messages.push({ role: "tool", content: [{ type: "tool-result", id: `call_${i}`, name, result: { type: "text", value: text } }] })
  }
  return messages
}
const policy = { keepSteps: 3, minChars: 1000, batchTokens: 2000 }

test("resultText reads text, json and text-only content; not errors or images", () => {
  assert.equal(resultText({ type: "text", value: "abc" }), "abc")
  assert.equal(resultText({ type: "json", value: { a: 1 } }), '{"a":1}')
  assert.equal(resultText({ type: "content", value: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb")
  assert.equal(resultText({ type: "content", value: [{ type: "text", text: "a" }, { type: "media", data: "x" }] }), undefined)
  assert.equal(resultText({ type: "error", value: "boom" }), undefined)
  assert.equal(resultText({ type: "text", value: { not: "a string" } }), undefined)
})

test("candidates skip the newest steps, small outputs, pinned tools and what is already paged", () => {
  const messages = conversation(10)
  messages.push({ role: "assistant", content: [{ type: "tool-call", id: "skill_1", name: "skill", input: {} }] })
  messages.push({ role: "tool", content: [{ type: "tool-result", id: "skill_1", name: "skill", result: { type: "text", value: "s".repeat(9000) } }] })
  messages.splice(3, 0, { role: "tool", content: [{ type: "tool-result", id: "tiny", name: "shell", result: { type: "text", value: "ok" } }] })
  const found = candidates(messages, new Set(["call_2"]), policy)
  // 11 steps; keepSteps 3 keeps steps 9-11 (call_9, call_10, skill_1).
  assert.deepEqual(found.map((item) => item.id), ["call_1", "call_3", "call_4", "call_5", "call_6", "call_7", "call_8"])
  assert.ok(PINNED.has("skill") && PINNED.has("memory") && PINNED.has("subagent") && !PINNED.has(RECALL))
})

test("nextBatch pages all candidates at once, or none until they free a batch's worth", () => {
  const small = candidates(conversation(4), new Set(), policy)
  assert.equal(small.length, 1)
  assert.deepEqual(nextBatch(small, policy), [])
  const big = candidates(conversation(8), new Set(), policy)
  assert.deepEqual(nextBatch(big, policy).map((item) => item.id), ["call_1", "call_2", "call_3", "call_4", "call_5"])
})

test("the stub names the tool, the size and the recall id, with the first and last lines", () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")
  const out = stub("call_7", "shell", text)
  assert.match(out, /^\[InfiniteOC paged this shell output out of the context \(\d+ chars, 20 lines\)\. recall \{"id":"call_7"\} returns it word for word/)
  assert.deepEqual(out.split("\n").slice(1), ["line 0", "line 1", "line 2", "line 3", "… 14 more lines …", "line 18", "line 19"])
  assert.ok(stub("x", "read", "a".repeat(5000)).length < 400, "long lines are cut")
  assert.equal(stub("x", "read", text), out.replace("shell", "read").replace("call_7", "x"))
})

test("applyPaging replaces only paged outputs, keeps everything else, and is deterministic", () => {
  const build = () => conversation(6)
  const messages = build()
  const original = JSON.stringify(messages)
  assert.deepEqual(applyPaging(messages, new Set()), { outputs: 0, chars: 0 })
  assert.equal(JSON.stringify(messages), original)
  const paged = new Set(["call_2", "call_4", "missing"])
  const result = applyPaging(messages, paged)
  assert.equal(result.outputs, 2)
  assert.ok(result.chars > 6000, String(result.chars))
  const results = messages.filter((message) => message.role === "tool").map((message) => message.content[0])
  assert.match(results[1].result.value, /recall \{"id":"call_2"\}/)
  assert.match(results[3].result.value, /recall \{"id":"call_4"\}/)
  assert.equal(results[0].result.value, build()[2].content[0].result.value)
  // Tool calls and every other field are untouched.
  assert.deepEqual(messages.filter((message) => message.role === "assistant"), build().filter((message) => message.role === "assistant"))
  assert.equal(results[1].id, "call_2")
  // Same input, same output: the cached prefix stays identical from request to request.
  const again = build()
  applyPaging(again, paged)
  assert.equal(JSON.stringify(again), JSON.stringify(messages))
})

test("over a long session paging is batched and sticky", () => {
  const paged = new Set()
  let batches = 0
  const sizes = []
  for (let step = 1; step <= 60; step++) {
    const messages = conversation(step)
    const batch = nextBatch(candidates(messages, paged, DEFAULT_POLICY), DEFAULT_POLICY)
    if (batch.length) batches++
    for (const item of batch) paged.add(item.id)
    applyPaging(messages, paged)
    sizes.push(JSON.stringify(messages).length)
  }
  // 4000-char outputs: a batch needs ~25 pageable outputs older than the newest 15 steps.
  assert.equal(batches, 1)
  assert.ok(paged.size >= 25)
  assert.ok(sizes.at(-1) < sizes[39], "the context shrinks after the batch")
})

test("store: outputs survive for recall, state round-trips, /octx off is honoured, old sessions are pruned", async (t) => {
  const dir = await tmp(t)
  process.env.XDG_DATA_HOME = dir
  const Store = await import(`./store.ts?${Date.now()}`)
  assert.deepEqual(Store.readState("ses_1"), { paged: [] })
  Store.saveOutputs("ses_1", [{ id: "call/1", text: "exact\ntext " }])
  assert.equal(Store.readOutput("ses_1", "call/1"), "exact\ntext ")
  assert.equal(Store.readOutput("ses_1", "call_2"), undefined)
  Store.writeState("ses_1", { paged: ["call/1"], chars: 4000 })
  assert.deepEqual(Store.readState("ses_1"), { paged: ["call/1"], off: false, chars: 4000 })
  assert.match(Store.describe(Store.readState("ses_1")), /1 old tool output paged out: about 1,000 tokens fewer/)
  assert.match(Store.describe({ paged: ["a"], off: true }), /off/)
  assert.ok(Store.stateVersion("ses_1") > 0)
  assert.equal(Store.stateVersion("ses_none"), 0)
  Store.writeState("ses_old", { paged: [] })
  const old = new Date(Date.now() - 40 * 86_400_000)
  await utimes(path.join(Store.sessionDir("ses_old"), "state.json"), old, old)
  assert.equal(Store.pruneOld(30), 1)
  assert.equal(Store.readOutput("ses_1", "call/1"), "exact\ntext ")
  assert.ok(Store.sessionDir("../../etc").startsWith(Store.dataRoot()), "session ids cannot escape the store")
  delete process.env.XDG_DATA_HOME
})

test("policySource bakes options.infiniteoctx over the defaults and rejects bad values", () => {
  assert.match(policySource({}), /export const POLICY: Policy = \{ \.\.\.DEFAULT_POLICY \}/)
  assert.match(policySource({ infiniteoctx: { keepSteps: 30, batchTokens: 40000 } }), /\.\.\.DEFAULT_POLICY, keepSteps: 30, batchTokens: 40000 \}/)
  assert.throws(() => policySource({ infiniteoctx: { minChars: -1 } }), /non-negative integer/)
  assert.throws(() => policySource({ infiniteoctx: { minChars: "big" } }), /non-negative integer/)
})

const INTERNAL = 'import { PlanPlugin } from "./plan.js"\nimport { WarmingPlugin } from "./warming.js"\nexport const plugins = [\n  PlanPlugin.Plugin,\n  WriteTool.Plugin,\n  WarmingPlugin.Plugin,\n]\n'

test("applies to a pristine tree, registers /octx, and fails closed on a second application", async (t) => {
  const root = await tmp(t)
  await mkdir(path.join(root, "packages/core/src/plugin"), { recursive: true })
  await writeFile(path.join(root, "packages/core/src/plugin/internal.ts"), INTERNAL)
  const commands = []
  const api = {
    options: {},
    async write(file, content) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), content)
    },
    async patch(file, transform) {
      await writeFile(path.join(root, file), transform(await readFile(path.join(root, file), "utf8")))
    },
    tui: { command: (command) => commands.push(command) },
  }
  await mod.setup(api)
  const internal = await readFile(path.join(root, "packages/core/src/plugin/internal.ts"), "utf8")
  assert.match(internal, /import \* as InfiniteocOctx from "\.\/infiniteoctx\.js"\nimport \{ WarmingPlugin \}/)
  assert.match(internal, /  WriteTool\.Plugin,\n  InfiniteocOctx\.Plugin,\n  WarmingPlugin\.Plugin,/)
  for (const file of ["infiniteoctx-lib.ts", "infiniteoctx-store.ts", "infiniteoctx-config.ts", "infiniteoctx.ts"])
    await readFile(path.join(root, "packages/core/src/plugin", file), "utf8")
  assert.equal(await readFile(path.join(root, "packages/tui/src/infiniteoc-features/octx-store.ts"), "utf8"), await readFile(new URL("./store.ts", import.meta.url), "utf8"))
  assert.deepEqual(commands.map((command) => command.slash), ["octx"])
  assert.throws(() => internalSource(internal), /already applied/)
  assert.throws(() => internalSource("unrelated"), /expected one source anchor/)
  // options.infiniteoctx.enabled false: nothing is written or patched.
  await mod.setup({ ...api, options: { infiniteoctx: { enabled: false } }, write: () => assert.fail("wrote"), patch: () => assert.fail("patched") })
})

