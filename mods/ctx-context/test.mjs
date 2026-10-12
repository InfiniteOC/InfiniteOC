import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import * as store from "./store.ts"
import * as K from "./knowledge.ts"
import mod, { compactionRules } from "./index.mjs"

const root = path.resolve(import.meta.dirname, "../../.upstream")

async function sandbox(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "ctx-test-"))
  const before = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = path.join(dir, "data")
  t.after(async () => {
    if (before === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = before
    await rm(dir, { recursive: true, force: true })
  })
  const project = path.join(dir, "proj")
  await mkdir(project, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: project })
  return { dir, project }
}

test("memory and glossary: add, replace, remove, refuse secrets", async (t) => {
  const { project } = await sandbox(t)
  const file = store.memoryFile(project)
  assert.deepEqual(store.listItems(file), [])
  store.addItem(file, "Run tests with  npm test\n")
  assert.equal(store.addItem(file, "run tests with npm test").replaced, true)
  store.addItem(file, "Never edit dist/")
  assert.deepEqual(store.listItems(file), ["run tests with npm test", "Never edit dist/"])
  assert.throws(() => store.addItem(file, "token sk-abcdefghijklmnopqrstuvwxyz123456"), /credential/)
  assert.equal(store.removeItem(file, "dist"), "Never edit dist/")
  assert.equal(store.removeItem(file, 1), "run tests with npm test")
  assert.throws(() => store.removeItem(file, "nothing"), /No entry/)
  store.addTerm(project, "frob", "turns widgets into gizmos")
  store.addTerm(project, "FROB", "new meaning")
  assert.deepEqual(store.listItems(store.glossaryFile(project)), ["FROB: new meaning"])
  assert.equal(store.projectRoot(path.join(project, "a", "b")), project)
})

test("pins: add, size limit, refreshed content, removal", async (t) => {
  const { project } = await sandbox(t)
  const file = path.join(project, "a.txt")
  await writeFile(file, "v1")
  store.addPin("ses_1", file)
  store.addPin("ses_1", file)
  assert.deepEqual(store.listPins("ses_1"), [file])
  assert.match(store.renderPins("ses_1", project), /<pinned path="a.txt">\nv1\n<\/pinned>/)
  await writeFile(file, "v2")
  assert.match(store.renderPins("ses_1", project), /v2/)
  await writeFile(path.join(project, "big.txt"), "x".repeat(store.MAX_PIN_BYTES + 1))
  assert.throws(() => store.addPin("ses_1", path.join(project, "big.txt")), /Too large/)
  assert.throws(() => store.addPin("ses_1", project), /Not a file/)
  assert.deepEqual(store.removePin("ses_1", "a.txt"), [file])
  assert.equal(store.renderPins("ses_1", project), undefined)
  assert.deepEqual(store.listPins("ses_other"), [])
})

test("breakdown classifies system, instructions, files, tool output and injected blocks", () => {
  const request = {
    system: [{ text: "base prompt" }, { text: "<available_skills>x</available_skills>" }, { text: "[InfiniteOC unified workflow]" }, { text: "Today's date: x" }, { text: "memory block" }],
    tools: { read: { description: "d", input: {} } },
    messages: [
      { role: "system", content: [{ type: "text", text: "AGENTS rules" }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "tool-call", name: "read", input: { path: "a" } }] },
      { role: "tool", content: [{ type: "tool-result", name: "read", result: { value: "x".repeat(400) } }] },
      { role: "tool", content: [{ type: "tool-result", name: "shell", result: { value: "y".repeat(80) } }] },
    ],
  }
  const report = store.breakdown(request, ["memory block"])
  const row = (label) => report.rows.find((item) => item.label === label)?.tokens
  assert.equal(row("Files read"), 100)
  assert.equal(row("Tool output"), 20)
  assert.ok(row("InfiniteOC context (memory, pins, ...)") > 0 && row("System prompt") > 0 && row("Skills list") > 0 && row("InfiniteOC guidance") > 0 && row("Environment and date") > 0 && row("Instructions") > 0 && row("User messages") > 0)
  assert.equal(report.total, report.rows.reduce((sum, item) => sum + item.tokens, 0))
  assert.match(store.formatSnapshot({ at: 0, agent: "build", ...report }), /Files read +100 /)
})

test("config: only well-formed fields are read", async (t) => {
  const { project } = await sandbox(t)
  await mkdir(path.join(project, ".infiniteoc"))
  await writeFile(path.join(project, ".infiniteoc", "context.json"), JSON.stringify({ sqlite: "a.db", docs: ["d", 3], logs: { dev: "x.log", bad: 1 }, repos: "no" }))
  assert.deepEqual(store.readConfig(project), { sqlite: "a.db", openapi: undefined, docs: ["d"], repos: undefined, logs: { dev: "x.log" } })
  assert.deepEqual(store.readConfig(path.join(project, "none")), {})
})

test("libraries: installed versions beat declared ranges", async (t) => {
  const { project } = await sandbox(t)
  await writeFile(path.join(project, "package.json"), JSON.stringify({ dependencies: { a: "^1.0.0", b: "^2.0.0" } }))
  await mkdir(path.join(project, "node_modules", "a"), { recursive: true })
  await writeFile(path.join(project, "node_modules", "a", "package.json"), JSON.stringify({ version: "1.4.2" }))
  await writeFile(path.join(project, "go.mod"), "module x\n\nrequire (\n\tgithub.com/foo/bar v1.2.3\n\tgithub.com/x/y v0.1.0 // indirect\n)\n")
  const text = K.libraries(project)
  assert.match(text, /a 1\.4\.2/)
  assert.match(text, /b \^2\.0\.0 \(declared, not installed\)/)
  assert.match(text, /github\.com\/foo\/bar v1\.2\.3/)
  assert.doesNotMatch(text, /github\.com\/x\/y/)
  assert.equal(K.libraries(path.join(project, "empty")), undefined)
})

test("machine profile is probed once and cached", async (t) => {
  const { dir } = await sandbox(t)
  const cache = path.join(dir, "machine.json")
  const first = K.machineProfile(cache, 1000)
  assert.match(first, /^Installed tools on this machine: .*node \d+/)
  await writeFile(cache, JSON.stringify({ at: 1000, tools: { node: "9.9.9", go: null } }))
  assert.equal(K.machineProfile(cache, 2000), "Installed tools on this machine: node 9.9.9. Not installed: go.")
})

test("repo map lists symbols per file, filters, and reuses its cache", async (t) => {
  const { project, dir } = await sandbox(t)
  await mkdir(path.join(project, "src"))
  await writeFile(path.join(project, "src", "a.ts"), "export function alpha() {}\nexport class Beta {}\nconst hidden = 1\n  indented()\n")
  await writeFile(path.join(project, "b.py"), "def gamma():\n  pass\nclass Delta: pass\n")
  await writeFile(path.join(project, "notes.md"), "# not code")
  const cache = path.join(dir, "map.json")
  const all = K.repoMap(project, cache)
  assert.match(all, /src\/a\.ts: alpha, Beta, hidden/)
  assert.match(all, /b\.py: gamma, Delta/)
  assert.doesNotMatch(all, /notes\.md/)
  assert.match(K.repoMap(project, cache, { path: "src" }), /^src\/a\.ts/)
  assert.doesNotMatch(K.repoMap(project, cache, { query: "gamma" }), /a\.ts/)
  assert.match(JSON.parse(await readFile(cache, "utf8"))["b.py"][2].join(), /gamma/)
})

test("stack traces map to local files, by suffix when paths came from elsewhere", async (t) => {
  const { project } = await sandbox(t)
  await mkdir(path.join(project, "src"))
  await writeFile(path.join(project, "src", "app.ts"), "l1\nl2\nthrow new Error('boom')\nl4\nl5\n")
  await writeFile(path.join(project, "src", "dup.ts"), "x")
  await mkdir(path.join(project, "lib"))
  await writeFile(path.join(project, "lib", "dup.ts"), "y")
  const trace = [
    "Error: boom",
    `    at helper (${project}/src/app.ts:3:9)`,
    "    at startApp (/build/ci/work/src/app.ts:3:9)",
    "    at run (/build/node_modules/express/lib/router.js:10:3)",
    "    at node:internal/main:5:5",
    "    at x (/srv/dup.ts:1:1)",
    "    at y (/srv/missing.ts:9:1)",
    'File "/app/src/app.ts", line 2, in main',
  ].join("\n")
  const out = K.lookupTrace(project, trace)
  assert.match(out, /src\/app\.ts:3\n.*\n.*\n> +3  throw new Error/)
  assert.match(out, /express\/lib\/router\.js:10\s+\(dependency/)
  assert.match(out, /dup\.ts:1  ambiguous: lib\/dup\.ts, src\/dup\.ts/)
  assert.match(out, /missing\.ts:9  not found in this project/)
  assert.match(out, /src\/app\.ts:2/)
  assert.match(K.lookupTrace(project, "no frames here"), /No file:line frames/)
})

test("type lookup finds declarations in @types and docs", async (t) => {
  const { project } = await sandbox(t)
  const types = path.join(project, "node_modules", "@types", "widget")
  await mkdir(types, { recursive: true })
  await writeFile(path.join(types, "index.d.ts"), "export interface Widget {\n  id: string\n  render(opts: RenderOptions): string\n}\nexport declare function makeWidget(name: string): Widget\n")
  await mkdir(path.join(project, "docs"))
  await writeFile(path.join(project, "docs", "w.md"), "intro\nThe Widget is rendered lazily.\nmore")
  const out = K.lookupTypes(project, { name: "Widget", docs: [path.join(project, "docs")] })
  assert.match(out, /index\.d\.ts:1\nexport interface Widget \{\n  id: string[\s\S]*\}/)
  assert.match(out, /w\.md:2/)
  assert.match(K.lookupTypes(project, { name: "makeWidget", pkg: "widget" }), /declare function makeWidget/)
  assert.match(K.lookupTypes(project, { name: "Nope" }), /No definition of Nope/)
  assert.throws(() => K.lookupTypes(project, { name: "a b" }), /identifier/)
})

test("log tail returns the last lines, filtered, with bounds", async (t) => {
  const { project } = await sandbox(t)
  const file = path.join(project, "dev.log")
  await writeFile(file, Array.from({ length: 1000 }, (_, i) => `line ${i}${i === 5 ? " ERROR" : ""}`).join("\n") + "\n")
  const out = K.tailFile(file, { lines: 3 })
  assert.match(out, /line 997\nline 998\nline 999\n\[/)
  assert.match(K.tailFile(file, { match: "error" }), /^line 5 ERROR\n/)
  assert.equal(K.tailFile(file, { lines: 9999 }).split("\n").length, 500 + 1)
})

test("sql peek allows reads and refuses every write", async (t) => {
  const { project } = await sandbox(t)
  const { DatabaseSync } = await import("node:sqlite")
  const file = path.join(project, "app.db")
  const db = new DatabaseSync(file)
  db.exec("create table users(id integer primary key, name text); insert into users(name) values ('ada'), ('bob'), ('cy')")
  db.close()
  assert.match(await K.queryReadOnly(file, "select name from users order by id", 2), /"ada"\}\n\{"name":"bob"\}\n\(limited to 2 rows\)/)
  assert.match(await K.queryReadOnly(file, "schema"), /create table users/i)
  assert.match(await K.queryReadOnly(file, "PRAGMA table_info(users)"), /"name":"name"/)
  assert.match(await K.queryReadOnly(file, "with t as (select 1 as x) select x from t;"), /"x":1/)
  for (const sql of ["delete from users", "insert into users(name) values ('z')", "drop table users", "select 1; delete from users", "pragma journal_mode=delete", "attach database 'x' as y", "with t as (select 1) delete from users", "update users set name='x'", "create table t(a)", "vacuum"])
    await assert.rejects(() => K.queryReadOnly(file, sql), /Read-only|Only one|Empty/, sql)
  assert.match(await K.queryReadOnly(file, "select 'drop table x' as s"), /drop table x/)
  assert.match(await K.queryReadOnly(file, "select count(*) as n from users"), /"n":3/)
  await assert.rejects(() => K.queryReadOnly(path.join(project, "missing.db"), "select 1"), /not found/)
})

test("openapi lookup lists, filters and resolves references", async (t) => {
  const { project } = await sandbox(t)
  const spec = {
    info: { title: "Lab", version: "1" },
    paths: { "/users/{id}": { get: { summary: "Get user", operationId: "getUser", responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } } } }, "/orders": { post: { summary: "Create order" } } },
    components: { schemas: { User: { type: "object", properties: { name: { type: "string" } } } } },
  }
  const file = path.join(project, "api.json")
  await writeFile(file, JSON.stringify(spec))
  const loaded = K.loadSpec(file)
  assert.match(K.lookupOpenApi(loaded, {}), /Lab 1 \(2 endpoints\)[\s\S]*GET \/users\/\{id\} - Get user \[getUser\][\s\S]*POST \/orders/)
  assert.match(K.lookupOpenApi(loaded, { query: "order" }), /\(1 endpoints matching "order"\)\nPOST \/orders/)
  assert.match(K.lookupOpenApi(loaded, { operation: "GET /users/{id}" }), /"name": \{\s+"type": "string"/)
  assert.throws(() => K.lookupOpenApi(loaded, { operation: "DELETE /nope" }), /No operation/)
})

test("linked repo access stays inside the repo and never writes", async (t) => {
  const { dir } = await sandbox(t)
  const repo = path.join(dir, "sibling")
  await mkdir(path.join(repo, "src"), { recursive: true })
  await writeFile(path.join(repo, "src", "lib.ts"), "a\nneedle here\nc\n")
  await writeFile(path.join(dir, "secret.txt"), "outside")
  assert.match(K.inspectRepo(repo, {}), /src\//)
  assert.match(K.inspectRepo(repo, { path: "src/lib.ts", offset: 2, limit: 1 }), /^2: needle here$/)
  assert.match(K.inspectRepo(repo, { grep: "NEEDLE" }), /src\/lib\.ts:2: needle here/)
  assert.throws(() => K.inspectRepo(repo, { path: "../secret.txt" }), /escapes/)
  assert.throws(() => K.inspectRepo(repo, { path: "../sibling-evil" }), /escapes|ENOENT/)
})

test("url mentions: only @http(s) tokens, trimmed, deduplicated and capped", () => {
  assert.deepEqual(K.urlMentions("see @https://a.dev/x. and @http://b.dev/y), also @https://a.dev/x"), ["https://a.dev/x", "http://b.dev/y"])
  assert.deepEqual(K.urlMentions("mail me@example.com or @src/file.ts or https://plain.dev"), [])
  assert.equal(K.urlMentions("@https://1.dev @https://2.dev @https://3.dev @https://4.dev").length, 3)
})

test("mod patches compaction, read tool, internal plugin list and guidance against upstream source", async () => {
  const files = new Map()
  await mod.setup({
    root,
    async patch(file, transform) {
      const original = files.get(file) ?? (file.endsWith("guidance.ts") ? "export const infiniteocGuidance: any = {}\n// infiniteoc:guidance-extensions\n" : await readFile(path.join(root, file), "utf8"))
      files.set(file, await transform(original))
    },
    async write(file, content) { files.set(file, content) },
    tui: { command(command) { files.set(`command:${command.slash}`, command.source) } },
  })
  assert.ok(files.get("packages/core/src/session/compaction.ts").includes(compactionRules))
  assert.match(files.get("packages/core/src/session/compaction.ts"), /Include at most 30/)
  const read = files.get("packages/core/src/tool/plugin/read.ts")
  assert.match(read, /targets: \[FILENAME, "CLAUDE\.md"\]/)
  assert.match(read, /paths: nearby/)
  assert.match(files.get("packages/core/src/plugin/internal.ts"), /import \* as InfiniteocCtx from ".\/infiniteoc-ctx.js"\nimport \{ WarmingPlugin \}[\s\S]*  InfiniteocCtx\.Plugin,\n  WarmingPlugin\.Plugin,/)
  assert.match(files.get("packages/core/src/infiniteoc/guidance.ts"), /\[Project context\][\s\S]*\/\/ infiniteoc:guidance-extensions/)
  for (const name of ["infiniteoc-ctx.ts", "infiniteoc-ctx-store.ts", "infiniteoc-ctx-knowledge.ts"]) assert.ok(files.has(`packages/core/src/plugin/${name}`), name)
  for (const slash of ["context", "memory", "pins"]) assert.match(files.get(`command:${slash}`), /export async function run\(ctx: FeatureContext\)/)
  // The pure source files must not depend on each other under names that only exist in one place.
  assert.doesNotMatch(files.get("packages/core/src/plugin/infiniteoc-ctx-knowledge.ts"), /from "\.\//)
})
