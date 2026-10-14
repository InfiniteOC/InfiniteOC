import test from "node:test"
import assert from "node:assert/strict"
import { clock, fx } from "../src/fx.mjs"
import { run } from "../src/launcher.mjs"

// A fake animated terminal: everything written is kept, escapes included.
const terminal = () => {
  const stream = { isTTY: true, columns: 60, text: "", write(chunk) { this.text += chunk; return true } }
  return stream
}
const visible = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

test("build progress: finished steps leave a check line, the running one shows its output tail and an ETA", async t => {
  if ("NO_COLOR" in process.env || process.env.TERM === "dumb") return t.skip("colors are off in this environment")
  const stream = terminal()
  const progress = fx(stream).progress(2, [1000, 1000])
  await progress.step("[1/2] First", async () => "done")
  let seen = ""
  await progress.step("[2/2] Second", async output => {
    output(Buffer.from("resolving \x1b[32mok\x1b[0m\npartial line"))
    await new Promise(resolve => setTimeout(resolve, 120))
    seen = visible(stream.text)
  })
  assert.match(seen, /╰ partial line/)
  assert.match(seen, /% · ~\d+s left/)
  assert.match(visible(stream.text), /✓ \[1\/2\] First/)
  assert.match(visible(stream.text), /✓ \[2\/2\] Second/)
  assert.equal(progress.timings.length, 2)
  // The cursor is hidden while drawing and always shown again.
  assert.ok(stream.text.lastIndexOf("\x1b[?25h") > stream.text.lastIndexOf("\x1b[?25l"))
})

test("build progress: a failed step prints its captured output and rethrows", async t => {
  if ("NO_COLOR" in process.env || process.env.TERM === "dumb") return t.skip("colors are off in this environment")
  const stream = terminal()
  const progress = fx(stream).progress(1)
  await assert.rejects(
    progress.step("[1/1] Build", async output => {
      output("line one\nerror TS2345: broke\n")
      throw new Error("bun failed (exit 1)")
    }),
    /exit 1/,
  )
  const text = visible(stream.text)
  assert.match(text, /✗ \[1\/1\] Build\n  line one\n  error TS2345: broke/)
  assert.equal(progress.timings.length, 0)
})

test("clock formats running time and estimates", () => {
  assert.equal(clock(4200), "4.2s")
  assert.equal(clock(65_000), "1m 05s")
  assert.equal(clock(400, true), "1s")
  assert.equal(clock(41_600, true), "42s")
})

test("run captures stdout and stderr with output, all of it before resolving", async () => {
  let captured = ""
  const code = await run(process.execPath, ["-e", 'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exit(3)'], { output: chunk => { captured += chunk } })
  assert.equal(code, 3)
  assert.match(captured, /out\n/)
  assert.match(captured, /err\n/)
})
