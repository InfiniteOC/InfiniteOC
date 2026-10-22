import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import module from "node:module"
import path from "node:path"
import mod, { EXIT_AFTER_MS, LEASE_EXIT } from "./index.mjs"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")
const [file, before, after] = LEASE_EXIT
const skip = !existsSync(upstream) && "no .upstream checkout"

test("patches the stdin lease once", async () => {
  const patched = []
  await mod.setup({ async patchExact(...args) { patched.push(args) } })
  assert.deepEqual(patched, [LEASE_EXIT])
  assert.equal(file, "packages/cli/src/server-process.ts")
})

test("the anchor is unique in the pinned upstream", { skip }, async () => {
  const source = await readFile(path.join(upstream, file), "utf8")
  assert.equal(source.split(before).length, 2)
})

// The patched waitForStdinClose, run with a minimal Effect: stdin closes or the wait is interrupted (the
// launcher's SIGTERM), then shutdown either finishes or hangs with a handle still open.
async function lease({ end, shutdown }) {
  const source = (await readFile(path.join(upstream, file), "utf8")).replace(before, () => after)
  const start = source.indexOf("function waitForStdinClose()")
  const fn = module.stripTypeScriptTypes(source.slice(start, source.indexOf("\n}\n", start) + 3)).replace(String(EXIT_AFTER_MS), "300")
  const program = `let cancel
const Effect = { void: undefined, sync: (f) => f, callback: (register) => (cancel = register(() => shutdown())) }
const shutdown = () => { ${shutdown} }
${fn}
waitForStdinClose()
${end === "interrupt" ? "setTimeout(() => { cancel(); shutdown() }, 200)" : ""}`
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", program], { stdio: ["pipe", "ignore", "inherit"] })
    const started = Date.now()
    child.on("exit", (code) => resolve({ code, ms: Date.now() - started }))
    if (end === "stdin") setTimeout(() => child.stdin.end(), 200)
    // Without the timer a hanging shutdown never ends; fail instead of hanging the suite.
    setTimeout(() => child.kill(), 3000).unref()
  })
}

const HANG = "setInterval(() => {}, 1000)"

test("a server whose shutdown hangs still exits once stdin closes", { skip }, async () => {
  const { code, ms } = await lease({ end: "stdin", shutdown: HANG })
  assert.equal(code, 0)
  assert.ok(ms >= 450 && ms < 3000, `${ms} ms`)
})

test("a server stopped by its launcher still exits when its shutdown hangs and stdin stays open", { skip }, async () => {
  const { code, ms } = await lease({ end: "interrupt", shutdown: HANG })
  assert.equal(code, 0)
  assert.ok(ms >= 450 && ms < 3000, `${ms} ms`)
})

test("a clean shutdown is not delayed", { skip }, async () => {
  const { code, ms } = await lease({ end: "stdin", shutdown: "" })
  assert.equal(code, 0)
  assert.ok(ms < 450, `${ms} ms`)
})
