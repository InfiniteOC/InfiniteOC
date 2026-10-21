import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import mod, { patches } from "./index.mjs"

const checkout = path.resolve(import.meta.dirname, "../..")
const pin = JSON.parse(readFileSync(path.join(checkout, "infiniteoc.json"), "utf8")).upstream
const pristine = (file) => {
  try {
    return execFileSync("git", ["-C", path.join(checkout, ".upstream"), "show", `${pin}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return undefined
  }
}

test("patches only the Windows shell arguments, once, against the pinned upstream", async (t) => {
  const patched = []
  await mod.setup({ async patchExact(file, before, after) { patched.push([file, before, after]) } })
  assert.equal(patched.length, patches.length)
  const [file, before, after] = patched[0]
  assert.equal(file, "packages/core/src/shell/select.ts")
  const source = pristine(file)
  if (source === undefined) return t.skip("no .upstream checkout")
  assert.equal(source.split(before).length, 2, "the anchor appears exactly once")
  // The POSIX branch is untouched; cmd and PowerShell get UTF-8 output before the command.
  assert.doesNotMatch(after, /"-c"/)
  assert.match(after, /chcp 65001>nul 2>&1 & \$\{command\}/)
  assert.match(after, /OutputEncoding=\[Text\.UTF8Encoding\]::new\(\$false\);\$\{command\}`/)
})
