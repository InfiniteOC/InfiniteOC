import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, readlink, stat, utimes, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { keepArchive, patchAppAssets, pruneBrotli, syncTree, webKey } from "../src/build-cache.mjs"

async function lab(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "ioc-cache-")))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
async function put(root, files) {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), text)
  }
}
async function tree(root, rel = "") {
  const out = {}
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const file = path.join(rel, entry.name)
    if (entry.isSymbolicLink()) out[file] = `-> ${await readlink(path.join(root, file))}`
    else if (entry.isDirectory()) Object.assign(out, await tree(root, file))
    else out[file] = await readFile(path.join(root, file), "utf8")
  }
  return out
}

test("syncTree mirrors the source, restores what mods changed, drops extras and keeps node_modules", async t => {
  const dir = await lab(t)
  const from = path.join(dir, "upstream")
  const to = path.join(dir, "runtime")
  await put(from, { "package.json": "{}", "packages/core/a.ts": "a", "packages/app/b.ts": "b", ".git/HEAD": "ref", "node_modules/x/index.js": "upstream-modules" })
  await symlink("b.ts", path.join(from, "packages/app/link.ts"))
  assert.deepEqual(await syncTree(from, to), { copied: 4, removed: 0 })
  assert.deepEqual(await tree(to), { "package.json": "{}", "packages/app/b.ts": "b", "packages/app/link.ts": "-> b.ts", "packages/core/a.ts": "a" })

  // A build: a mod patches and writes, bun installs, the compiler leaves output.
  await put(to, { "packages/core/a.ts": "patched", "packages/core/mod.ts": "written", "node_modules/dep/index.js": "dep", "packages/app/node_modules/y.js": "y", "packages/cli/dist/opencode": "bin" })
  await rm(path.join(to, "packages/app/link.ts"))
  await writeFile(path.join(to, "packages/app/link.ts"), "replaced a symlink")
  // Removed: the written file, the symlink-turned-file and packages/cli (only build output).
  assert.deepEqual(await syncTree(from, to), { copied: 2, removed: 3 })
  assert.deepEqual(await tree(to), {
    "node_modules/dep/index.js": "dep",
    "package.json": "{}",
    "packages/app/b.ts": "b",
    "packages/app/link.ts": "-> b.ts",
    "packages/app/node_modules/y.js": "y",
    "packages/core/a.ts": "a",
  })
  // Nothing changed: nothing is copied.
  assert.deepEqual(await syncTree(from, to), { copied: 0, removed: 0 })
  // Same size, newer mtime (a same-length patch) is still restored; a mode change too.
  await writeFile(path.join(to, "packages/core/a.ts"), "z")
  await utimes(path.join(to, "packages/core/a.ts"), new Date(), new Date(Date.now() + 60_000))
  assert.deepEqual(await syncTree(from, to), { copied: 1, removed: 0 })
  assert.equal(await readFile(path.join(to, "packages/core/a.ts"), "utf8"), "a")
  // A directory replaced by a file and the reverse.
  await rm(path.join(to, "packages/core"), { recursive: true })
  await writeFile(path.join(to, "packages/core"), "not a dir")
  await syncTree(from, to)
  assert.equal(await readFile(path.join(to, "packages/core/a.ts"), "utf8"), "a")
})

const workspace = {
  "package.json": "{}",
  "bun.lock": "lock",
  "packages/app/package.json": JSON.stringify({ name: "@opencode/app", dependencies: { "@opencode/ui": "workspace:*", solid: "1" } }),
  "packages/app/src/index.ts": "app",
  "packages/ui/package.json": JSON.stringify({ name: "@opencode/ui", devDependencies: { "@opencode/theme": "workspace:*" } }),
  "packages/ui/src/button.tsx": "button",
  "packages/theme/package.json": JSON.stringify({ name: "@opencode/theme" }),
  "packages/theme/a.json": "{}",
  "packages/core/package.json": JSON.stringify({ name: "@opencode/core" }),
  "packages/core/src/x.ts": "core",
  "packages/tui/package.json": JSON.stringify({ name: "@opencode/tui", dependencies: { "@opencode/core": "workspace:*" } }),
  "packages/cli/package.json": JSON.stringify({ name: "@opencode/cli" }),
  "packages/cli/script/app-assets.ts": "assets",
  "packages/cli/src/index.ts": "cli",
  "packages/desktop/icons/dev/64.png": "png",
}

test("webKey follows the web UI's own inputs and ignores core, tui and generated files", async t => {
  const root = await lab(t)
  await put(root, workspace)
  const env = { OPENCODE_CHANNEL: "infiniteoc", HOME: "/a" }
  const key = await webKey(root, { env, bun: "1.4.2" })
  assert.match(key, /^[0-9a-f]{64}$/)
  const same = async (files, extra = {}) => { await put(root, files); return (await webKey(root, { env: { ...env, ...extra.env }, bun: extra.bun ?? "1.4.2" })) === key }
  assert.equal(await same({ "packages/core/src/x.ts": "patched", "packages/tui/src/y.ts": "new", "packages/cli/src/index.ts": "patched" }), true)
  assert.equal(await same({ "packages/app/dist/index.html": "out", "packages/app/node_modules/z.js": "z", "packages/ui/.cache/c": "c" }), true)
  assert.equal(await same({}, { env: { HOME: "/b" } }), true)
  assert.equal(await same({}, { bun: "1.4.3" }), false)
  assert.equal(await same({}, { env: { VITE_X: "1" } }), false)
  for (const [file, text] of [["packages/theme/a.json", "{ }"], ["packages/ui/src/new.tsx", "x"], ["packages/app/src/index.ts", "app2"], ["bun.lock", "lock2"], ["packages/cli/script/app-assets.ts", "assets2"], ["packages/desktop/icons/dev/64.png", "png2"]]) {
    const before = await webKey(root, { env, bun: "1.4.2" })
    await put(root, { [file]: text })
    assert.notEqual(await webKey(root, { env, bun: "1.4.2" }), before, file)
  }
})

const assets = `import { $ } from "bun"
import path from "node:path"
import { promisify } from "node:util"
import { brotliCompress, constants } from "node:zlib"
import { AppArchive } from "../src/app-archive"

export async function buildAppArchive(channel: string, options?: { skipBuild?: boolean }) {
  if (options?.skipBuild) return AppArchive.encode([])
  return AppArchive.encode([["a", await compress(Buffer.from("a"))]])
}

function compress(body: Buffer) {
  return promisify(brotliCompress)(body)
}
`

test("patchAppAssets adds both reuses around upstream's code and declines a changed upstream", () => {
  const out = patchAppAssets(assets)
  assert.ok(out.includes('if (options?.skipBuild) return AppArchive.encode([])\n  // InfiniteOC'))
  assert.ok(out.includes("process.env.INFINITEOC_APP_ARCHIVE"))
  assert.ok(out.includes("process.env.INFINITEOC_BROTLI_CACHE"))
  assert.ok(out.includes("function brotli(body: Buffer) {\n  return promisify(brotliCompress)(body)"))
  assert.equal(out.match(/function compress/g).length, 1)
  assert.equal(patchAppAssets(assets.replace("function compress", "function squash")), undefined)
  assert.equal(patchAppAssets(out), undefined, "never applied twice")
})

test("keepArchive keeps the newest two archives; pruneBrotli drops entries this build did not touch", async t => {
  const dir = await lab(t)
  const cache = path.join(dir, "cache")
  await put(dir, { "built.bin": "archive" })
  for (const [i, key] of ["a", "b", "c"].entries()) {
    await keepArchive(path.join(dir, "built.bin"), cache, key.repeat(64))
    const when = new Date(Date.now() - (3 - i) * 60_000)
    await utimes(path.join(cache, `web-${key.repeat(64)}.bin`), when, when)
  }
  await keepArchive(path.join(dir, "built.bin"), cache, "d".repeat(64))
  assert.deepEqual((await readdir(cache)).sort(), [`web-${"c".repeat(64)}.bin`, `web-${"d".repeat(64)}.bin`])

  const brotli = path.join(cache, "brotli-v2.0.32")
  await put(cache, { "brotli-v2.0.32/old.br": "o", "brotli-v2.0.32/used.br": "u", "brotli-v2.0.31/stale.br": "s" })
  const since = Date.now()
  await utimes(path.join(brotli, "old.br"), new Date(since - 60_000), new Date(since - 60_000))
  await pruneBrotli(brotli, since)
  assert.deepEqual(await readdir(brotli), ["used.br"])
  await assert.rejects(stat(path.join(cache, "brotli-v2.0.31")), { code: "ENOENT" })
})
