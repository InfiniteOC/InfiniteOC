import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { archive, exportProject, measure, resetExports, __test } from "../src/project-export.mjs"
import { installExportTool } from "../src/export-tool.mjs"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tarList = async (file) => {
  const { spawnSync } = await import("node:child_process")
  const result = spawnSync("tar", ["-tzf", file], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.split("\n").filter(Boolean)
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "ioc-export-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  t.after(() => resetExports())
  await writeFile(path.join(dir, "index.mjs"), "export me\n")
  await mkdir(path.join(dir, "src"), { recursive: true })
  await writeFile(path.join(dir, "src/app.mjs"), "app\n")
  await mkdir(path.join(dir, ".git/objects"), { recursive: true })
  await writeFile(path.join(dir, ".git/HEAD"), "ref\n")
  await mkdir(path.join(dir, "node_modules/dep"), { recursive: true })
  await writeFile(path.join(dir, "node_modules/dep/index.js"), "dep\n")
  return dir
}

test("archives exclude .git and node_modules and report a hash", async t => {
  const dir = await fixture(t)
  const built = await archive(dir, "tar.gz")
  t.after(() => rm(path.dirname(built.file), { recursive: true, force: true }))
  assert.equal(built.format, "tar.gz")
  assert.match(built.filename, /\.tar\.gz$/)
  assert.match(built.sha256, /^[0-9a-f]{64}$/)
  assert.ok(built.bytes > 0)
  const names = await tarList(built.file)
  assert.ok(names.some(name => name.endsWith("index.mjs")), names.join("\n"))
  assert.ok(names.some(name => name.endsWith("src/app.mjs")), names.join("\n"))
  assert.ok(names.every(name => !name.includes(".git") && !name.includes("node_modules")), names.join("\n"))
})

test("zip is used when requested and available, else tar.gz is reported", async t => {
  const dir = await fixture(t)
  const built = await archive(dir, "zip")
  t.after(() => rm(path.dirname(built.file), { recursive: true, force: true }))
  assert.ok(["zip", "tar.gz"].includes(built.format))
  if (built.format === "zip") assert.match(built.filename, /\.zip$/)
  else assert.match(built.filename, /\.tar\.gz$/)
})

test("measure counts inputs and enforces caps", async t => {
  const dir = await fixture(t)
  const { files, bytes } = await measure(dir)
  assert.equal(files, 2)
  assert.ok(bytes > 0)
  await assert.rejects(measure(dir, { maxBytes: 1 }), /Too large/)
  await assert.rejects(measure(dir, { maxFiles: 1 }), /Too many/)
})

test("archive rejects missing paths, files and bad formats", async t => {
  await assert.rejects(archive(path.join(tmpdir(), "ioc-export-missing"), "tar.gz"), /not a directory/)
  const dir = await mkdtemp(path.join(tmpdir(), "ioc-export-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, "file.txt"), "x")
  await assert.rejects(archive(path.join(dir, "file.txt"), "tar.gz"), /not a directory/)
  await assert.rejects(archive(dir, "rar"), /format must be/)
})

test("a download link works once, on loopback, then dies", async t => {
  const dir = await fixture(t)
  const result = await exportProject({ directory: dir, format: "tar.gz" })
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/download\/[0-9a-f]{64}$/)
  assert.equal(result.format, "tar.gz")
  const first = await fetch(result.url, { redirect: "manual" })
  assert.equal(first.status, 200)
  assert.match(first.headers.get("content-disposition"), /attachment; filename="/)
  assert.ok(Number(first.headers.get("content-length")) > 0)
  await first.arrayBuffer()
  assert.equal((await fetch(result.url)).status, 404)
  assert.equal((await fetch(result.url.replace(/download\/.*/, "download/0".repeat(32)))).status, 404)
})

test("expired links are refused without revealing why", async t => {
  const dir = await fixture(t)
  const result = await exportProject({ directory: dir, format: "tar.gz" })
  const token = result.url.split("/").at(-1)
  __test.pending.get(token).expiresAt = Date.now() - 1
  assert.equal((await fetch(result.url)).status, 404)
})

test("the tool installs into the plugin tree with approval and project scoping", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "ioc-tool-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, "packages/core/src/tool/plugin/opencode.ts")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, 'import { Effect, Schema } from "effect"\n    yield* ctx.session.hook("generate", hook)\n    yield* ctx.tool\n        draft.add({\n          name: "session_rename",\n')
  await installExportTool(root)
  const installed = await readFile(file, "utf8")
  assert.ok(installed.includes('name: "project_export"'))
  assert.ok(installed.includes('import { exportProject } from "./infiniteoc-export.mjs"'))
  assert.ok(installed.includes('import { FileAccess } from "../../file-access.js"'))
  assert.ok(installed.includes('import { Permission } from "../../permission.js"'))
  assert.ok(installed.includes("access.resolve({ path: input.path ??"))
  assert.ok(installed.includes("access.authorizeExternal([target], context)"))
  // Services come from plugin setup (execute requires nothing); every failure reaches the agent as a ToolFailure.
  assert.ok(installed.includes("    const access = yield* FileAccess.Service\n    const permission = yield* Permission.Service\n    yield* ctx.tool\n"))
  assert.ok(!/execute: \(input, context\) =>\s+Effect\.gen\(function\* \(\) \{\s+const access/.test(installed))
  assert.ok(installed.includes("Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure("))
  assert.ok(installed.includes('permission.assert({ action: "project_export"'))
  assert.ok(installed.includes("The link works once, on this machine"))
  const shipped = await readFile(path.join(root, "packages/core/src/tool/plugin/infiniteoc-export.mjs"), "utf8")
  assert.equal(shipped, await readFile(path.join(repo, "src/project-export.mjs"), "utf8"))
})

test("the tool installs after the daemon tool into the real upstream file", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "ioc-tool-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, "packages/core/src/tool/plugin/opencode.ts")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, await readFile(path.join(repo, ".upstream/packages/core/src/tool/plugin/opencode.ts"), "utf8"))
  const { installDaemonTool } = await import("../src/opendaemon-tool.mjs")
  await installDaemonTool(root)
  await installExportTool(root)
  const installed = await readFile(file, "utf8")
  assert.ok(installed.includes('name: "project_export"'))
  assert.ok(installed.includes('name: "opendaemon"'))
  assert.ok(installed.includes('name: "session_rename"'))
  assert.ok((await import("node:fs/promises").then(fs => fs.stat(path.join(root, "packages/core/src/tool/plugin/infiniteoc-export.mjs")))).isFile())
}, { timeout: 30000 })
