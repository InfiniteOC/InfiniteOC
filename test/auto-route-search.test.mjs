import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../skills/auto-route/", import.meta.url))
const script = path.join(root, "scripts/find.py")

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "auto-route-search-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const rows = [
    { id: "react-best-practices", category: "web", description: "React implementation patterns" },
    { id: "playwright-cli", category: "web", description: "Browser verification and testing" },
    { id: "systematic-debugging", category: "engineering", description: "Debug regressions and bugs" },
    { id: "fiction-writing-prose", category: "writing", description: "Write a story" },
    { id: "missing-skill", category: "web", description: "Browser verification" },
  ].map(row => ({ ...row, installed: path.join(directory, row.id) }))
  for (const row of rows.filter(row => row.id !== "missing-skill")) {
    await mkdir(row.installed)
    await writeFile(path.join(row.installed, "SKILL.md"), "This body must not be read or executed.")
  }
  const catalog = path.join(directory, "catalog.json")
  await writeFile(catalog, JSON.stringify(rows))
  return { rows, catalog, run: (...args) => spawnSync("python3", [script, "--catalog", catalog, ...args], { encoding: "utf8", timeout: 5000 }) }
}

test("search ranks exact IDs and actual stack, returns bounded metadata rather than bodies", async t => {
  const { run } = await fixture(t)
  for (const id of ["playwright-cli", "react-best-practices", "fiction-writing-prose"]) {
    const result = run(id, "--json", "--limit", "1")
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout)[0].id, id)
    assert.doesNotMatch(result.stdout, /This body/)
  }
  assert.equal(JSON.parse(run("react component", "--json").stdout)[0].id, "react-best-practices")
})

test("search omits missing paths unless requested and does not claim tool availability", async t => {
  const { run } = await fixture(t)
  const normal = JSON.parse(run("browser", "--json").stdout)
  assert.deepEqual(normal.map(row => row.id), ["playwright-cli"])
  assert.equal(normal[0].status, "file-present")
  const diagnostic = JSON.parse(run("browser", "--json", "--include-missing").stdout)
  assert.equal(diagnostic.find(row => row.id === "missing-skill").status, "missing")
})

test("search keeps non-code categories and supports empty results without fabricated matches", async t => {
  const { run } = await fixture(t)
  assert.deepEqual(JSON.parse(run("--categories", "--json").stdout), ["engineering", "web", "writing"])
  assert.deepEqual(JSON.parse(run("--category", "writing", "--json").stdout).map(row => row.id), ["fiction-writing-prose"])
  assert.deepEqual(JSON.parse(run("nonsenseunmatched", "--json").stdout), [])
})

test("search fails closed on duplicate IDs, malformed catalog, invalid limits or categories", async t => {
  const { run, rows, catalog } = await fixture(t)
  for (const args of [["--limit", "0"], ["--limit", "99"], ["--category", "absent"]]) assert.equal(run(...args).status, 2)
  for (const invalid of [[rows[0], rows[0]], [{ ...rows[0], installed: "relative" }], { secret: "DO_NOT_PRINT" }]) {
    await writeFile(catalog, JSON.stringify(invalid))
    const result = run("--json")
    assert.equal(result.status, 2)
    assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT/)
  }
})

test("routing skill retains general-domain routes and every local reference resolves", async () => {
  const source = await readFile(path.join(root, "SKILL.md"), "utf8")
  assert.ok(source.startsWith("---\nname: auto-route\ndescription:"))
  for (const id of ["fiction-writing-prose", "statistical-analysis", "impeccable", "systematic-debugging", "infiniteoc-mod-development"]) assert.ok(source.includes(id), id)
  for (const match of source.matchAll(/\]\((references\/[^)]+)\)/g)) await access(path.join(root, match[1]))
  assert.ok(source.length < 19000, "keep routing instructions bounded; put depth in references")
})