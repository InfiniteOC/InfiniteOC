import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { bench, countTokens, format, parseConfig, summarize, TASKS, trial } from "../src/bench.mjs"
import { execFileSync } from "node:child_process"

const finish = (input, output) => JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input, output, reasoning: 0, cache: { read: 5, write: 0 } } } })

test("configurations parse strictly and tokens sum across steps", () => {
  assert.deepEqual(parseConfig("model=a/b,ponytail=off"), { label: "model=a/b,ponytail=off", model: "a/b", ponytail: "off" })
  assert.equal(parseConfig("model=a/b,label=base").label, "base")
  assert.throws(() => parseConfig("agent=build"), /needs model/)
  assert.throws(() => parseConfig("model=a/b,temp=1"), /Unknown configuration key temp/)
  assert.throws(() => parseConfig("model=a/b,ponytail=max"), /ponytail must be/)
  assert.deepEqual(countTokens(`junk\n${finish(100, 20)}\n{"type":"text"}\n${finish(50, 5)}\n`), { input: 150, output: 25, reasoning: 0, cacheRead: 10, cacheWrite: 0 })
})

test("the built-in checks fail on the broken fixtures and pass on a correct solution", async () => {
  const solutions = { "fix-sum": { "sum.mjs": "export const sum = (a, b) => a + b\n" }, "add-slugify": { "slug.mjs": "export const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')\n" },
    "last-item": { "last.mjs": "export const last = (l) => l[l.length - 1]\n" }, "add-is-even": { "math.mjs": "export const double = (n) => n * 2\nexport const isEven = (n) => n % 2 === 0\n" },
    "rename-export": { "greet.mjs": "export const greet = (name) => `Hello, ${name}`\n", "main.mjs": "import { greet } from './greet.mjs'\nexport const out = greet('bench')\n" } }
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  for (const task of TASKS) {
    const dir = await mkdtemp(join(tmpdir(), "bench-check-"))
    try {
      const attempt = () => { try { execFileSync(task.check[0], task.check.slice(1), { cwd: dir, stdio: "ignore" }); return true } catch { return false } }
      for (const [name, content] of Object.entries(task.files)) await writeFile(join(dir, name), content)
      assert.equal(attempt(), false, `${task.id} starts failing`)
      for (const [name, content] of Object.entries(solutions[task.id])) await writeFile(join(dir, name), content)
      assert.equal(attempt(), true, `${task.id} passes when solved`)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})

test("bench interleaves configurations, counts tokens and compares pass rate, tokens and time", async () => {
  const order = []
  // The agent run succeeds for both; the check passes only for config B on the second task.
  const exec = async (command, args, options) => {
    if (command === "fake-opencode") {
      order.push(`${args[args.indexOf("-m") + 1]}:${args.at(-1)}`)
      const big = args.includes("big/model")
      return { code: 0, stdout: finish(big ? 400 : 100, 20), ms: big ? 3000 : 1000 }
    }
    return { code: options.cwd && order.at(-1).startsWith("big/model") ? 0 : order.at(-1).endsWith("two") ? 1 : 0, stdout: "", ms: 1 }
  }
  const tasks = [{ id: "one", prompt: "one", files: { "a.txt": "x" }, check: ["check"] }, { id: "two", prompt: "two", files: {}, check: ["check"] }]
  const results = await bench({ binary: "fake-opencode", env: {}, configs: [parseConfig("model=small/model,label=A"), parseConfig("model=big/model,label=B")], tasks, exec })
  assert.deepEqual(order, ["small/model:one", "big/model:one", "small/model:two", "big/model:two"])
  assert.deepEqual(results.map((r) => [r.passed, r.trials.length, r.tokens, r.meanMs]), [[1, 2, 240, 1000], [2, 2, 840, 3000]])
  const text = format(results)
  assert.match(text, /pass rate\s+1\/2 \(50%\)\s+2\/2 \(100%\)/)
  assert.match(text, /B vs A: pass rate 50 points, tokens \+250%, time \+200%/)
  assert.match(text, /failed: A: two/)
  assert.equal(summarize([]).passRate, 0)
})

test("a ponytail level reaches the agent through a config dir that mirrors the real one", async (t) => {
  const { mkdtemp, writeFile, mkdir, rm, readFile: read, readdir } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const root = await mkdtemp(join(tmpdir(), "bench-xdg-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "opencode"))
  await writeFile(join(root, "opencode/opencode.json"), "{}")
  await writeFile(join(root, "opencode/.ponytail-active"), "lite")
  let seen
  await trial({ binary: "b", env: { XDG_CONFIG_HOME: root }, config: parseConfig("model=a/b,ponytail=ultra"), task: { id: "t", prompt: "p", files: {}, check: ["c"] },
    exec: async (command, args, options) => { if (command === "b") { seen = { dir: options.env.XDG_CONFIG_HOME, files: await readdir(join(options.env.XDG_CONFIG_HOME, "opencode")), level: await read(join(options.env.XDG_CONFIG_HOME, "opencode/.ponytail-active"), "utf8") } } return { code: 0, stdout: "", ms: 1 } } })
  assert.notEqual(seen.dir, root)
  assert.deepEqual(seen.files.sort(), [".ponytail-active", "opencode.json"])
  assert.equal(seen.level, "ultra")
  assert.equal(await read(join(root, "opencode/.ponytail-active"), "utf8"), "lite", "the real level is untouched")
})
