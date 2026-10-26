import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import mod, { IMPORT, LOCAL_TYPE, LOCAL_VALUE, SPAWN } from "./index.mjs"
import { environment, npmCache, resolve } from "./npx.ts"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")
const skip = !existsSync(path.join(upstream, "package.json")) && "no .upstream checkout"
const PATCHES = [LOCAL_TYPE, LOCAL_VALUE, IMPORT, SPAWN]

// A fake npm cache holding `spec` the way npx installs it.
async function cache(spec, manifest) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-direct-"))
  const dir = path.join(root, "_npx", createHash("sha512").update(spec).digest("hex").slice(0, 16), "node_modules")
  await mkdir(path.join(dir, manifest.name), { recursive: true })
  await mkdir(path.join(dir, ".bin"))
  await writeFile(path.join(dir, manifest.name, "package.json"), JSON.stringify(manifest))
  const bins = typeof manifest.bin === "string" ? { [manifest.name.split("/").pop()]: manifest.bin } : manifest.bin ?? {}
  for (const [bin, file] of Object.entries(bins)) {
    await mkdir(path.dirname(path.join(dir, manifest.name, file)), { recursive: true })
    await writeFile(path.join(dir, manifest.name, file), "")
    await symlink(path.join("..", manifest.name, file), path.join(dir, ".bin", bin))
  }
  return { root, bin: path.join(dir, ".bin") }
}

test("a cached exact version runs its program directly, with npx's flags dropped and arguments kept", { skip: process.platform === "win32" }, async (t) => {
  const { root, bin } = await cache("rea-agents@4.0.1", { name: "rea-agents", version: "4.0.1", bin: { rea: "scripts/rea.mjs", "rea-agents": "scripts/rea.mjs" } })
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(resolve("npx", ["-y", "rea-agents@4.0.1", "mcp", "--x"], root), { command: path.join(bin, "rea"), args: ["mcp", "--x"], bin })
  assert.deepEqual(resolve("/usr/bin/npx", ["--yes", "rea-agents@4.0.1"], root)?.args, [])
  assert.deepEqual(resolve("npx", ["rea-agents@4.0.1"], root)?.command, path.join(bin, "rea"))
})

test("scoped packages pick the program named after the package", { skip: process.platform === "win32" }, async (t) => {
  const { root, bin } = await cache("@scope/tool@1.2.3", { name: "@scope/tool", version: "1.2.3", bin: { other: "a.js", tool: "b.js" } })
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(resolve("npx", ["-y", "@scope/tool@1.2.3"], root)?.command, path.join(bin, "tool"))
})

test("npx keeps everything it has to decide itself", { skip: process.platform === "win32" }, async (t) => {
  const { root } = await cache("pkg@1.0.0", { name: "pkg", version: "1.0.0", bin: { a: "a.js", b: "b.js" } })
  const other = await cache("solo@1.0.0", { name: "solo", version: "1.0.1", bin: "x.js" })
  t.after(() => Promise.all([root, other.root].map((dir) => rm(dir, { recursive: true, force: true }))))
  assert.equal(resolve("npx", ["-y", "pkg@1.0.0"], root), undefined, "several programs, none named after the package")
  assert.equal(resolve("npx", ["-y", "solo@1.0.0"], other.root), undefined, "cached version differs")
  assert.equal(resolve("npx", ["-y", "pkg@latest"], root), undefined, "tag")
  assert.equal(resolve("npx", ["-y", "pkg@^1.0.0"], root), undefined, "range")
  assert.equal(resolve("npx", ["-y", "pkg"], root), undefined, "no version")
  assert.equal(resolve("npx", ["-p", "pkg@1.0.0", "a"], root), undefined, "other npx flags")
  assert.equal(resolve("npx", ["-y", "missing@1.0.0"], root), undefined, "not cached")
  assert.equal(resolve("node", ["pkg@1.0.0"], root), undefined, "not npx")
})

test("the program finds its own .bin first on PATH; declared variables stay", () => {
  const direct = { command: "/c/.bin/x", args: [], bin: "/c/.bin" }
  assert.deepEqual(environment(direct, { A: "1" }, "/usr/bin"), { A: "1", PATH: ["/c/.bin", "/usr/bin"].join(path.delimiter) })
  assert.equal(environment(direct, { PATH: "/mine" }, "/usr/bin").PATH, ["/c/.bin", "/mine"].join(path.delimiter))
  assert.equal(npmCache({ npm_config_cache: "/x" }, "/home/u"), "/x")
  assert.equal(npmCache({}, "/home/u"), path.join("/home/u", ".npm"))
})

test("setup writes the resolver and applies each patch once", async () => {
  const calls = []
  await mod.setup({ write: async (file) => calls.push(["write", file]), patchExact: async (...args) => calls.push(args) })
  assert.deepEqual(calls, [["write", "packages/core/src/mcp/npx-direct.ts"], ...PATCHES])
})

test("anchors are unique in the pinned upstream and the result keeps workspace spawns on npx", { skip }, async () => {
  const files = new Map()
  for (const [file, before, after] of PATCHES) {
    const source = files.get(file) ?? (await readFile(path.join(upstream, file), "utf8"))
    assert.equal(source.split(before).length, 2, `${file}: ${before.slice(0, 40)}`)
    files.set(file, source.replace(before, () => after))
  }
  assert.match(files.get("packages/core/src/environment/environment.ts"), /local: !location\.workspaceID/)
  assert.match(files.get("packages/core/src/mcp/stdio.ts"), /environment\.local && process\.env\.INFINITEOC_MCP_NPX !== "1"/)
})
