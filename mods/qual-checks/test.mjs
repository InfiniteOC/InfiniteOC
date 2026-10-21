import test from "node:test"
import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import mod, { guidance } from "./index.mjs"
import { applyMods } from "../../src/mod-loader.mjs"
import { extractTokens, formatTokens, category } from "./lib/tokens.ts"
import { catalog } from "./lib/catalog.ts"
import { prune } from "./lib/prune.ts"
import { parseDeps, addedDeps, inspectInstalled } from "./lib/deps.ts"
import { classifyText, risk, scanLicense, formatLicense } from "./lib/license.ts"
import { parseCoverage, readReport, detectCommand, fmtDelta } from "./lib/coverage.ts"
import { isTestCommand, isTestFile, isSourceFile, testFirstPhase, eventsFromMessages, testFirstEnd, mutate, compareBench, flakyVerdict, targets, MARK } from "./lib/tests.ts"
import { findChrome, findAxe, playwrightChromium, toUrl, viewportSpecs, runCheck, formatReport, serveLocal } from "./lib/browser.ts"
import { checkable, syntaxProblem } from "./lib/syntax.ts"
import { run } from "./lib/exec.ts"

const src = (p, text) => ({ path: p, text })
const tmp = async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "qual-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test("design tokens: variables grouped, alternates kept, reads ignored, tailwind noted", () => {
  const css = `:root { --bg: #fff; --space-2: 8px; --radius: 6px; --font-sans: "Inter", sans-serif; --shadow-1: 0 1px 2px #0003; --ease: cubic-bezier(0,0,1,1); }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; } }
  a { color: var(--bg); }`
  const result = extractTokens([src("a.css", css), src("tailwind.config.js", "module.exports = {\n theme: { extend: { colors: { brand: '#f0f' } } }\n}"), src("b.css", '@import "tailwindcss";')])
  const bg = result.tokens.find((t) => t.name === "--bg")
  assert.deepEqual([bg.value, bg.alternates], ["#fff", ["#111"]])
  assert.equal(result.tokens.length, 6)
  assert.equal(category("--space-2", "8px"), "space")
  assert.equal(category("--font-sans", '"Inter", sans-serif'), "type")
  const out = formatTokens(result)
  assert.match(out, /## color[\s\S]*--bg: #fff {2}\| also: #111/)
  assert.match(out, /tailwind config tailwind\.config\.js[\s\S]*brand/)
  assert.match(out, /tailwind v4/)
  assert.match(formatTokens({ tokens: [], tailwind: [] }), /No CSS custom properties/)
})

test("component catalog: exports, props and usage counts", () => {
  const items = catalog([
    src("src/Button.tsx", `interface ButtonProps {\n  label: string\n  onClick?: () => void\n  style: { a: 1 }\n}\nexport function Button({ label }: ButtonProps) { return <button>{label}</button> }\nexport const helper = 1`),
    src("src/Card.tsx", `export default function Card({ title, body }) { return <div><Button label="x"/></div> }`),
    src("src/Page.tsx", `export const Page = () => <div><Button label="a"/><Card/></div>`),
    src("src/Nav.vue", `<template/>`),
  ])
  const byName = Object.fromEntries(items.map((item) => [item.name, item]))
  assert.deepEqual(byName.Button.props, ["label", "onClick", "style"])
  assert.equal(byName.Button.used, 2)
  assert.deepEqual(byName.Card.props, ["title", "body"])
  assert.equal(byName.Nav.file, "src/Nav.vue")
  assert.ok(!byName.helper)
  assert.equal(items[0].name, "Button")
})

test("prune: unused files and exports, entries and string references kept", () => {
  const files = [
    src("src/index.ts", `import { used } from "./lib/a.js"\nimport b from "./lib/b"\nexport * from "./lib/star"\nused(); b()`),
    src("src/lib/a.ts", `export const used = () => 1\nexport const dead = () => 2\nexport type T = 1`),
    src("src/lib/b.ts", `export default function b() {}`),
    src("src/lib/star.ts", `export const s = 1`),
    src("src/lib/orphan.ts", `export const o = 1`),
    src("src/lib/loaded.ts", `export const l = 1`),
    src("src/lib/other.ts", `readFile(new URL("./loaded.ts", import.meta.url))`),
    src("src/lib/ns.ts", `export const n = 1`),
    src("src/lib/ns-user.ts", `import * as ns from "./ns"\nexport const x = ns`),
    src("test/a.test.ts", `import { used } from "../src/lib/a"`),
  ]
  const result = prune(files)
  assert.deepEqual(result.unusedFiles.sort(), ["src/lib/ns-user.ts", "src/lib/other.ts", "src/lib/orphan.ts"].sort())
  assert.deepEqual(result.unusedExports.find((item) => item.file === "src/lib/a.ts").names.sort(), ["T", "dead"].sort())
  assert.ok(!result.unusedExports.some((item) => item.file === "src/lib/ns.ts" || item.file === "src/lib/star.ts"))
})

test("dependency guard: added packages from manifest diffs, installed facts offline", async (t) => {
  const before = JSON.stringify({ dependencies: { a: "^1" }, devDependencies: { b: "^1" } })
  const after = JSON.stringify({ dependencies: { a: "^1", left: "^2" }, devDependencies: { b: "^2", tiny: "1.0.0" } })
  assert.deepEqual(addedDeps("package.json", before, after).map((d) => `${d.name}:${d.kind}`), ["left:dependencies", "tiny:devDependencies"])
  assert.deepEqual(addedDeps("requirements.txt", "requests==2\n", "requests==2\nflask>=3 # web\n-r other.txt\n").map((d) => d.name), ["flask"])
  const dir = await tmp(t)
  await mkdir(path.join(dir, "node_modules/left"), { recursive: true })
  await writeFile(path.join(dir, "node_modules/left/package.json"), JSON.stringify({ name: "left", version: "2.1.0", license: "MIT", dependencies: { x: "1" } }))
  await writeFile(path.join(dir, "node_modules/left/index.js"), "x".repeat(5000))
  const info = inspectInstalled(dir, "left")
  assert.deepEqual([info.version, info.license, info.deps], ["2.1.0", "MIT", 1])
  assert.ok(info.size > 5000)
  assert.equal(inspectInstalled(dir, "missing"), undefined)
  assert.deepEqual(parseDeps("package.json", "{bad"), [])
})

test("license check: text classification, risk, SPDX and nearest license file", async (t) => {
  assert.equal(classifyText("Permission is hereby granted, free of charge, to any person"), "MIT")
  assert.equal(classifyText("GNU AFFERO GENERAL PUBLIC LICENSE Version 3"), "AGPL-3.0")
  assert.equal(classifyText("GNU LESSER GENERAL PUBLIC LICENSE"), "LGPL")
  assert.equal(classifyText("Apache License\n Version 2.0, January 2004"), "Apache-2.0")
  assert.deepEqual(["MIT", "GPL-3.0-only", "AGPL-3.0", "LGPL-2.1", "MPL-2.0", "Weird"].map(risk), ["permissive", "copyleft", "copyleft", "weak-copyleft", "weak-copyleft", "unknown"])
  const dir = await tmp(t)
  await mkdir(path.join(dir, "vendor/lib"), { recursive: true })
  await writeFile(path.join(dir, "vendor/lib/a.js"), "// SPDX-License-Identifier: GPL-3.0-only\n")
  let result = scanLicense(path.join(dir, "vendor/lib"), dir)
  assert.deepEqual(result.ids, ["GPL-3.0-only"])
  assert.match(formatLicense("vendor/lib", result, "MIT"), /Copyleft[\s\S]*project is MIT/)
  await mkdir(path.join(dir, "vendor/bare"), { recursive: true })
  await writeFile(path.join(dir, "vendor/bare/a.js"), "// Copyright (c) Someone\n")
  result = scanLicense(path.join(dir, "vendor/bare"), dir)
  assert.deepEqual(result.ids, [])
  assert.match(formatLicense("vendor/bare", result), /NO LICENSE FOUND/)
  await writeFile(path.join(dir, "vendor/bare/LICENSE"), "Permission is hereby granted, free of charge, to any person")
  assert.deepEqual(scanLicense(path.join(dir, "vendor/bare/a.js"), dir).ids, ["MIT"])
})

test("coverage: parses node, istanbul, summary and pytest output; reads reports; reports the delta", async (t) => {
  assert.deepEqual(parseCoverage("# start of coverage report\n# all files           |  91.45 |    80.00 |   88.89 |\n"), { lines: 91.45, branches: 80, functions: 88.89 })
  assert.deepEqual(parseCoverage("All files |   70 |   60 |   50 |   82.5 |"), { lines: 82.5, branches: 60, functions: 50 })
  assert.equal(parseCoverage("Statements   : 90% ( 9/10 )\nLines        : 77.7% ( 7/9 )").lines, 77.7)
  assert.equal(parseCoverage("TOTAL    1234    56    95%").lines, 95)
  assert.equal(parseCoverage("nothing"), undefined)
  const dir = await tmp(t)
  await mkdir(path.join(dir, "coverage"))
  await writeFile(path.join(dir, "coverage/lcov.info"), "SF:a\nLF:10\nLH:7\nend_of_record\nSF:b\nLF:10\nLH:9\nend_of_record\n")
  assert.deepEqual(readReport(dir), { lines: 80 })
  assert.equal(detectCommand(JSON.stringify({ scripts: { "test:coverage": "c8 npm test" } })), "npm run test:coverage")
  assert.equal(detectCommand(JSON.stringify({ scripts: { test: "node --test test/*.test.mjs" } })), "node --test test/*.test.mjs --experimental-test-coverage")
  assert.equal(detectCommand("{}"), undefined)
  assert.match(fmtDelta({ lines: 90 }, { lines: 85 }), /-5\.00 points[\s\S]*went down/)
  assert.match(fmtDelta(undefined, { lines: 85 }), /baseline/)
})

test("test-first: red-green state machine over transcript events", () => {
  const edit = (...files) => ({ kind: "edit", files })
  const runOf = (exit, command = "npm test") => ({ kind: "run", run: { command, exit } })
  assert.equal(testFirstPhase([edit("src/a.ts")]), "off")
  assert.equal(testFirstPhase([{ kind: "start" }]), "need-test")
  assert.equal(testFirstPhase([{ kind: "start" }, runOf(1)]), "need-test")
  assert.equal(testFirstPhase([{ kind: "start" }, edit("test/a.test.ts")]), "need-red")
  assert.equal(testFirstPhase([{ kind: "start" }, edit("test/a.test.ts"), runOf(0)]), "need-red")
  assert.equal(testFirstPhase([{ kind: "start" }, edit("test/a.test.ts"), runOf(1, "ls")]), "need-red")
  assert.equal(testFirstPhase([{ kind: "start" }, edit("test/a.test.ts"), runOf(1)]), "red")
  assert.equal(testFirstPhase([{ kind: "start" }, edit("test/a.test.ts"), runOf(1), edit("src/a.ts"), runOf(1)]), "red")
  assert.equal(testFirstPhase([{ kind: "start" }, edit("test/a.test.ts"), runOf(1), edit("src/a.ts"), runOf(0)]), "green")
  assert.equal(testFirstPhase([{ kind: "start" }, edit("test/a.test.ts"), runOf(1), runOf(0), edit("test/b.test.ts"), edit("src/b.ts")]), "green")
  assert.equal(testFirstPhase([{ kind: "start" }, { kind: "stop" }]), "off")
  assert.deepEqual(["need-test", "need-red", "red", "green", "off"].map((phase) => testFirstEnd(phase, 0)), ["remind", "remind", "remind", "done", "none"])
  assert.equal(testFirstEnd("red", 2), "gave-up")
  assert.ok(isSourceFile("src/a.ts") && !isSourceFile("test/a.ts") && !isSourceFile("a.test.ts") && !isSourceFile("README.md") && !isSourceFile("tests/x.py") && isSourceFile("lib/x.py"))
  assert.ok(isTestFile("src/__tests__/a.ts") && isTestFile("pkg/test_a.py") && isTestFile("a_test.go") && !isTestFile("src/latest.ts"))
})

test("test-first: events from a transcript, including refused edits and user shell runs", () => {
  const tool = (name, input, status = "completed", metadata) => ({ type: "tool", name, state: { status, input, metadata } })
  const events = eventsFromMessages([
    { type: "user", text: `${MARK.start}\nTask: x` },
    { type: "assistant", content: [tool("write", { path: "test/a.test.mjs" }), tool("shell", { command: "node --test" }, "completed", { exit: 1 }), tool("edit", { path: "src/a.ts" }, "error"), { type: "text", text: "hi" }] },
    { type: "shell", command: "npm test", exit: 0 },
    { type: "synthetic", text: `${MARK.reminder}\nx` },
    { type: "assistant", content: [tool("patch", { patchText: "*** Update File: src/b.ts\n@@\n*** Add File: src/c.ts\n" })] },
  ])
  assert.deepEqual(events, [
    { kind: "start" },
    { kind: "edit", files: ["test/a.test.mjs"] },
    { kind: "run", run: { command: "node --test", exit: 1 } },
    { kind: "run", run: { command: "npm test", exit: 0 } },
    { kind: "edit", files: ["src/b.ts", "src/c.ts"] },
  ])
  assert.equal(testFirstPhase(events), "green")
  assert.deepEqual(targets("write", { path: "a.css" }), ["a.css"])
  assert.deepEqual(targets("shell", { path: "a.css" }), [])
})

test("test commands are recognised", () => {
  for (const command of ["npm test", "npm run test:unit", "pnpm test -- --watch=false", "node --test test/*.mjs", "node --experimental-test-coverage --test", "pytest -x", "python -m pytest tests", "go test ./...", "cargo test", "vitest run", "cd app && yarn test", "./gradlew test", "bun test"])
    assert.ok(isTestCommand(command), command)
  for (const command of ["ls", "git status", "npm install", "echo test", "node build.js", "cat tests.txt"]) assert.ok(!isTestCommand(command), command)
  assert.equal(flakyVerdict([1, 1, 1]), "consistent")
  assert.equal(flakyVerdict([1, 0, 1]), "flaky")
  assert.equal(flakyVerdict([1, 0, 0]), "flaky")
})

test("mutation: flips one condition, targets a line, restores nothing itself", () => {
  const source = "const a = 1\n// x === y\nif (a === b && c) {\n  return a < 3\n}\nconst ok = true\n"
  const first = mutate(source)
  assert.deepEqual([first.line, first.after], [3, "if (a !== b && c) {"])
  assert.equal(mutate(source, 4).after, "return a >= 3")
  assert.equal(mutate(source, 6).after, "const ok = false")
  assert.equal(mutate(source, 1), undefined)
  assert.equal(mutate(source, 2), undefined)
  assert.equal(mutate("plain text\nmore"), undefined)
  assert.equal(mutate("if x == y:\n  pass", 1).after, "if x != y:")
  assert.equal(mutate("x => y", 1), undefined)
  assert.equal(mutate(source, 4).text.split("\n").length, source.split("\n").length)
})

test("benchmark guard compares against the baseline within tolerance", () => {
  assert.match(compareBench(undefined, 100, 15).message, /No baseline yet/)
  assert.equal(compareBench(100, 110, 15).regressed, false)
  const slow = compareBench(100, 130, 15)
  assert.equal(slow.regressed, true)
  assert.match(slow.message, /\+30\.0%[\s\S]*REGRESSION/)
  assert.equal(compareBench(100, 70, 15).regressed, false)
})

test("run: exit codes, output and timeout", async (t) => {
  const dir = await tmp(t)
  const ok = await run("echo hi; exit 3", dir)
  assert.deepEqual([ok.exit, ok.output.trim(), ok.timedOut], [3, "hi", false])
  const slow = await run("sleep 5", dir, 200)
  assert.deepEqual([slow.exit, slow.timedOut], [undefined, true])
})

test("viewports and URL policy", () => {
  assert.deepEqual(viewportSpecs(undefined).map((v) => v.width), [375, 768, 1280])
  assert.deepEqual(viewportSpecs(["desktop", 500]).map((v) => [v.name, v.width, v.mobile]), [["desktop", 1280, false], ["500px", 500, false]])
  assert.throws(() => viewportSpecs(["huge"]), /Unknown viewport/)
  assert.equal(toUrl("http://localhost:3000/x", false), "http://localhost:3000/x")
  assert.equal(toUrl("http://[::1]:3000", false), "http://[::1]:3000")
  assert.throws(() => toUrl("https://example.com", false), /only localhost/)
  assert.equal(toUrl("https://example.com", true), "https://example.com")
  assert.throws(() => toUrl("/definitely/not/here.html", false), /Not found/)
})

test("axe-core is resolved from the project, never fetched", async (t) => {
  const dir = await tmp(t)
  await mkdir(path.join(dir, "node_modules/axe-core"), { recursive: true })
  await mkdir(path.join(dir, "a/b"), { recursive: true })
  await writeFile(path.join(dir, "node_modules/axe-core/axe.min.js"), "")
  assert.equal(findAxe(path.join(dir, "a/b"), {}), path.join(dir, "node_modules/axe-core/axe.min.js"))
  assert.equal(findAxe(dir, { INFINITEOC_AXE_CORE: path.join(dir, "node_modules/axe-core/axe.min.js") }), path.join(dir, "node_modules/axe-core/axe.min.js"))
})

test("finds Playwright's newest downloaded Chromium when no system Chrome is configured", async (t) => {
  const dir = await tmp(t)
  for (const revision of ["chromium-1100", "chromium-1194", "chromium_headless_shell-1194"]) {
    await mkdir(path.join(dir, revision, "chrome-linux"), { recursive: true })
    await writeFile(path.join(dir, revision, "chrome-linux", "chrome"), "")
  }
  assert.equal(playwrightChromium({ PLAYWRIGHT_BROWSERS_PATH: dir }), path.join(dir, "chromium-1194", "chrome-linux", "chrome"))
  assert.equal(playwrightChromium({ HOME: path.join(dir, "nowhere") }), undefined)
  assert.equal(playwrightChromium({ PLAYWRIGHT_BROWSERS_PATH: "0", HOME: path.join(dir, "nowhere") }), undefined)
})

test("serveLocal serves one folder on 127.0.0.1: types, index, no dotfiles, no escape, GET/HEAD only", async (t) => {
  const dir = await tmp(t)
  await mkdir(path.join(dir, "site", "sub"), { recursive: true })
  await mkdir(path.join(dir, "site", ".git"), { recursive: true })
  await writeFile(path.join(dir, "site", "index.html"), "<!doctype html><title>home</title>")
  await writeFile(path.join(dir, "site", "app.mjs"), "export const x = 1")
  await writeFile(path.join(dir, "site", "sub", "index.html"), "sub")
  await writeFile(path.join(dir, "site", "my file.css"), "body{}")
  await writeFile(path.join(dir, "site", ".env"), "SECRET=1")
  await writeFile(path.join(dir, "site", ".git", "config"), "[core]")
  await writeFile(path.join(dir, "outside.txt"), "outside")
  const server = await serveLocal(path.join(dir, "site", "index.html"))
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/)
    assert.equal(server.root, path.join(dir, "site"))
    const get = (p, init) => fetch(`${server.origin}${p}`, init)
    const page = await get("/index.html")
    assert.equal(page.status, 200)
    assert.match(page.headers.get("content-type"), /^text\/html/)
    assert.equal(page.headers.get("cache-control"), "no-store")
    assert.match((await get("/app.mjs")).headers.get("content-type"), /^text\/javascript/)
    assert.equal(await (await get("/sub/")).text(), "sub")
    assert.equal(await (await get("/my%20file.css")).text(), "body{}")
    for (const blocked of ["/.env", "/.git/config", "/%2e%2e/outside.txt", "/..%2foutside.txt", "/missing.js", "/favicon.ico", "/missing.js"]) assert.equal((await get(blocked)).status, 404, blocked)
    // Requested files that do not exist are listed once; refused paths and favicon.ico are not. The URL parser
    // already resolves /%2e%2e/outside.txt to /outside.txt inside the folder, a plain missing file.
    assert.deepEqual(server.missing, ["outside.txt", "missing.js"])
    assert.equal((await get("/index.html", { method: "POST" })).status, 405)
    const head = await get("/index.html", { method: "HEAD" })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), "")
  } finally {
    await server.close()
  }
  await assert.rejects(fetch(`${server.origin}/index.html`))
})

test("syntax check: names the file, line and error of a saved file that does not parse", () => {
  // Bun-shaped error: the runtime's transpiler reports the first problem with its position.
  const bunError = (message, line, lineText) => Object.assign(new Error(message), { errors: [{ message, position: { line, lineText } }] })
  const fail = (message, line, text) => () => { throw bunError(message, line, text) }
  const ok = () => {}
  // Eval run eval4/b-1: a second getMonthList made logic.js a SyntaxError and the model reported success.
  const note = syntaxProblem("logic.js", "x", fail('"getMonthList" has already been declared', 212, "  export const getMonthList = (xs) => xs"))
  assert.match(note, /^Syntax check: logic\.js does not parse: "getMonthList" has already been declared at line 212 \(`export const getMonthList = \(xs\) => xs`\)\. The file was saved as written/)
  assert.equal(syntaxProblem("logic.js", "export const a = 1", ok), undefined)
  // JS parses as JSX; TS and TSX use their own loaders; Flow files and other types are skipped; no transpiler, no check.
  const seen = []
  const spy = (loader) => { seen.push(loader) }
  for (const file of ["a.js", "a.mjs", "a.cjs", "a.jsx", "a.ts", "a.mts", "a.tsx"]) syntaxProblem(file, "x", spy)
  assert.deepEqual(seen, ["jsx", "jsx", "jsx", "jsx", "ts", "ts", "tsx"])
  assert.equal(syntaxProblem("a.js", "// @flow\nconst a: number = 1", fail("Parse error", 2)), undefined)
  assert.equal(syntaxProblem("a.js", "broken", undefined), undefined)
  assert.equal(syntaxProblem("a.py", "def (", fail("x", 1)), undefined)
  for (const file of ["a.js", "b.ts", "c.tsx", "package.json", "d.MJS"]) assert.ok(checkable(file), file)
  for (const file of ["a.py", "b.css", "c.html", "README.md", "json"]) assert.ok(!checkable(file), file)
  // JSON: strict JSON passes; comments and trailing commas (tsconfig, VS Code) pass; real breakage is reported.
  assert.equal(syntaxProblem("package.json", '{"name": "x", "scripts": {"test": "node --test"}}'), undefined)
  assert.equal(syntaxProblem("tsconfig.json", '{\n  // strict mode\n  "compilerOptions": { "strict": true, /* x */ "url": "http://a//b", },\n}'), undefined)
  assert.equal(syntaxProblem("empty.json", "  "), undefined)
  assert.match(syntaxProblem("package.json", '{"name": "x" "version": "1"}'), /^Syntax check: package\.json does not parse: /)
  assert.match(syntaxProblem("package.json", '{"name": "x",'), /does not parse/)
})

const bun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0
test("syntax check with Bun's transpiler: real errors found, valid JSX/TS accepted", { skip: !bun && "bun not on PATH" }, async (t) => {
  const dir = await tmp(t)
  const script = path.join(dir, "check.ts")
  await writeFile(script, `import { syntaxProblem } from ${JSON.stringify(new URL("./lib/syntax.ts", import.meta.url).pathname)}
const cases = {
  redeclared: ["logic.js", "export function getMonthList() {}\\nexport const getMonthList = () => 1\\n"],
  unclosed: ["a.js", "export function a() {\\n  return 1\\n"],
  jsx: ["App.js", "export const A = () => <div className='x'>{1 < 2 ? 'a' : 'b'}</div>\\n"],
  ts: ["a.ts", "export function f(a: number): number { return a }\\n"],
  badTs: ["b.ts", "export function f(a: number { return a }\\n"],
  tla: ["c.mjs", "const r = await Promise.resolve(1)\\nexport default r\\n"],
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(cases).map(([k, [f, t]]) => [k, syntaxProblem(f, t) ?? null]))))`)
  const out = JSON.parse(spawnSync("bun", [script], { encoding: "utf8" }).stdout)
  assert.match(out.redeclared, /logic\.js does not parse: .*already been declared at line 2/)
  assert.match(out.unclosed, /a\.js does not parse: Unexpected end of file/)
  assert.match(out.badTs, /b\.ts does not parse/)
  assert.equal(out.jsx, null)
  assert.equal(out.ts, null)
  assert.equal(out.tla, null)
})

const chrome = findChrome()
test("browser check: screenshots, overflow, dark mode, diff and mockup against real Chrome", { skip: !chrome && "no Chrome installed", timeout: 600000 }, async (t) => {
  const dir = await tmp(t)
  const page = path.join(dir, "page.html")
  await writeFile(page, `<!doctype html><html lang="en"><head><title>t</title><style>
    body { margin: 0; font: 16px sans-serif; background: #fff; color: #111 }
    @media (prefers-color-scheme: dark) { body { background: #111; color: #eee } }
    .wide { width: 600px; height: 40px; background: #08f }
    </style></head><body><h1>Hello</h1><div class="wide"></div><script>console.error("boom")</script></body></html>`)
  const url = toUrl(page, false)
  const plan = [{ viewport: viewportSpecs(["phone"])[0], scheme: "light" }, { viewport: viewportSpecs(["desktop"])[0], scheme: "dark" }]
  const first = await runCheck({ chrome, url, plan, fullPage: true })
  assert.equal(first.shots.length, 2)
  assert.equal(first.shots[0].overflow, 225)
  assert.deepEqual(first.shots[0].offenders, ["div.wide (600px wide, right edge at 600px)"])
  assert.equal(first.shots[1].overflow, undefined)
  assert.equal(first.shots[1].offenders, undefined)
  assert.ok(first.consoleErrors.some((line) => line.includes("boom")), JSON.stringify(first.consoleErrors))
  for (const shot of first.shots) assert.equal(Buffer.from(shot.png, "base64").subarray(1, 4).toString(), "PNG")
  assert.notEqual(first.shots[0].png, first.shots[1].png)
  // Identical page: zero change. Changed page: a diff with a bounding box.
  const same = await runCheck({ chrome, url, plan, fullPage: true, baseline: (label) => first.shots.find((s) => s.label === label)?.png })
  assert.deepEqual(same.shots.map((s) => s.diff.changedPct), [0, 0])
  await writeFile(page, (await readFile(page, "utf8")).replace("#08f", "#f80"))
  const changed = await runCheck({ chrome, url, plan, fullPage: true, baseline: (label) => first.shots.find((s) => s.label === label)?.png, mockup: { file: "m.png", base64: first.shots[1].png } })
  assert.ok(changed.shots[0].diff.changedPct > 1, String(changed.shots[0].diff.changedPct))
  assert.ok(changed.shots[0].diff.box)
  assert.equal(changed.mockup.shot.width, 1280)
  assert.ok(changed.mockup.diff.changedPct > 0 && changed.mockup.diff.hot.length > 0)
})

test("an ES-module page that file:// blocks renders cleanly when served from its folder", { skip: !chrome && "no Chrome installed", timeout: 300000 }, async (t) => {
  const dir = await tmp(t)
  const page = path.join(dir, "index.html")
  await writeFile(page, '<!doctype html><html lang="en"><head><title>m</title></head><body><main id="out">loading</main><script type="module" src="./app.mjs"></script></body></html>')
  await writeFile(path.join(dir, "app.mjs"), 'import { label } from "./lib.mjs"\nlocalStorage.setItem("k", "v")\ndocument.getElementById("out").textContent = label + localStorage.getItem("k")')
  await writeFile(path.join(dir, "lib.mjs"), 'export const label = "ready-"')
  const plan = [{ viewport: viewportSpecs(["phone"])[0], scheme: "light" }]
  const blocked = await runCheck({ chrome, url: toUrl(page, false), plan, fullPage: false })
  assert.ok(blocked.consoleErrors.some((line) => /CORS|ERR_FAILED/.test(line)), JSON.stringify(blocked.consoleErrors))
  const server = await serveLocal(page)
  try {
    const served = await runCheck({ chrome, url: server.url, plan, fullPage: false })
    assert.deepEqual(served.consoleErrors, [])
    assert.notEqual(served.shots[0].png, blocked.shots[0].png)
  } finally {
    await server.close()
  }
})

test("overflow culprits: the outermost element that sticks out, not content of a scrolling box", { skip: !chrome && "no Chrome installed", timeout: 300000 }, async (t) => {
  const dir = await tmp(t)
  const page = path.join(dir, "wide.html")
  await writeFile(page, `<!doctype html><html lang="en"><head><title>w</title><meta name="viewport" content="width=device-width"><style>
    body { margin: 0 } .scroll { overflow-x: auto } .scroll div { width: 900px; height: 10px }
    main { padding: 8px } table { width: 520px } td { height: 10px }
    </style></head><body><div class="scroll"><div></div></div><main><table class="list"><tr><td>x</td></tr></table></main></body></html>`)
  const [shot] = (await runCheck({ chrome, url: toUrl(page, false), plan: [{ viewport: viewportSpecs(["phone"])[0], scheme: "light" }], fullPage: false })).shots
  assert.equal(shot.overflow, 528 - 375)
  assert.deepEqual(shot.offenders, ["main > table.list (520px wide, right edge at 528px)"])
})

test("filled states: storage seeds the app, setup adds items once per capture, empty lists are flagged", { skip: !chrome && "no Chrome installed", timeout: 300000 }, async (t) => {
  const dir = await tmp(t)
  const page = path.join(dir, "index.html")
  await writeFile(page, `<!doctype html><html lang="en"><head><title>l</title><meta name="viewport" content="width=device-width"></head><body>
    <form id="f"><label>Item <input id="name"></label><button>Add</button></form><ul id="list"></ul>
    <script>
      const items = JSON.parse(localStorage.getItem("items") || "[]")
      const render = () => { document.getElementById("list").innerHTML = items.map((i) => "<li>" + i + " <button>Delete</button></li>").join("") }
      document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); items.push(document.getElementById("name").value); localStorage.setItem("items", JSON.stringify(items)); render() })
      render()
    </script></body></html>`)
  const plan = [{ viewport: viewportSpecs(["phone"])[0], scheme: "light" }, { viewport: viewportSpecs(["desktop"])[0], scheme: "light" }]
  const server = await serveLocal(page)
  try {
    const empty = await runCheck({ chrome, url: server.url, plan, fullPage: false, basicAudit: true })
    assert.equal(empty.emptyLists, true)
    assert.match(formatReport(empty, "basic", "index.html"), /Lists on the page are empty[\s\S]*pass storage[\s\S]*or setup/)
    // Seeded storage: the list renders filled, the note goes away, and the row audit sees same-named actions.
    const seeded = await runCheck({ chrome, url: server.url, plan, fullPage: false, basicAudit: true, storage: { items: JSON.stringify(["Lunch", "Bus"]) } })
    assert.equal(seeded.emptyLists, undefined)
    assert.ok(seeded.violations.some((v) => v.id === "repeated-action-name"), JSON.stringify(seeded.violations.map((v) => v.id)))
    // A setup that submits the form twice: two rows at every width, not two more per capture.
    const setup = 'for (const name of ["a", "b"]) { document.getElementById("name").value = name; document.getElementById("f").requestSubmit() }'
    const added = await runCheck({ chrome, url: server.url, plan, fullPage: false, basicAudit: true, setup })
    assert.equal(added.emptyLists, undefined)
    const rows = await runCheck({ chrome, url: server.url, plan, fullPage: false, setup: `${setup}; if (document.querySelectorAll("#list li").length !== 2) throw new Error("rows: " + document.querySelectorAll("#list li").length)` })
    assert.equal(rows.shots.length, 2)
    await assert.rejects(runCheck({ chrome, url: server.url, plan, fullPage: false, setup: "throw new Error('no such button')" }), /The setup script failed: .*no such button/)
  } finally {
    await server.close()
  }
})

test("applies to the pinned source: files, plugin registration, guidance; fails closed", async (t) => {
  const root = await tmp(t)
  const write = async (file, text) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text) }
  await write("packages/core/src/plugin/internal.ts", 'import { PlanPlugin } from "./plan.js"\nexport const plugins = [\n  PlanPlugin.Plugin,\n  Other.Plugin,\n]\n')
  await write("packages/core/src/infiniteoc/guidance.ts", "export const infiniteocGuidance: Record<string, string[]> = { build: [] }\n// infiniteoc:guidance-extensions\n")
  const result = await applyMods([mod], root)
  assert.equal(result.changes.length, 12 + 1 + 2)
  const internal = await readFile(path.join(root, "packages/core/src/plugin/internal.ts"), "utf8")
  assert.match(internal, /import \* as InfiniteocQuality from "\.\/infiniteoc-quality\.js"/)
  assert.match(internal, /  InfiniteocQuality\.Plugin,\n  PlanPlugin\.Plugin,\n  Other\.Plugin,/)
  const guide = await readFile(path.join(root, "packages/core/src/infiniteoc/guidance.ts"), "utf8")
  assert.ok(guide.includes(JSON.stringify(guidance)) && guide.endsWith("// infiniteoc:guidance-extensions\n"))
  for (const name of ["browser", "tests", "store"]) assert.ok(existsSync(path.join(root, `packages/core/src/infiniteoc/quality/${name}.ts`)))
  const lib = await readFile(path.join(root, "packages/core/src/infiniteoc/quality/tokens.ts"), "utf8")
  assert.match(lib, /from "\.\/scan\.js"/)
  assert.doesNotMatch(lib, /from "\.\/\w+\.ts"/)
  await assert.rejects(applyMods([mod], root), /already applied/)
  await write("packages/core/src/plugin/internal.ts", "nothing\n")
  await write("packages/core/src/infiniteoc/guidance.ts", "// infiniteoc:guidance-extensions\n")
  await assert.rejects(applyMods([mod], root), /expected one internal\.ts plugin anchor/)
})

test("formatReport: built-in audit wording, and nothing about accessibility when it is off", () => {
  const base = { shots: [{ label: "phone-light", viewport: "phone", scheme: "light", width: 375, png: "" }], consoleErrors: [], violations: [] }
  assert.match(formatReport(base, "basic", "x.html"), /Accessibility \(built-in checks; add axe-core as a devDependency for a full audit\): no violations.*tab through/)
  assert.doesNotMatch(formatReport(base, "off", "x.html"), /Accessibility/)
  const found = { ...base, violations: [{ id: "color-contrast", impact: "serious", help: "Text contrast below 4.5:1", nodes: ["button"], seen: ["phone-light"] }] }
  assert.match(formatReport(found, "basic", "x.html"), /built-in checks.*1 violation[\s\S]*\[serious\] color-contrast/)
  // Overflow names the elements that stick out, so the model does not script its own browser to find them.
  const wide = { ...base, shots: [{ ...base.shots[0], overflow: 233, offenders: ["main > canvas#chart (608px wide, right edge at 608px)"] }] }
  assert.match(formatReport(wide, "basic", "x.html"), /phone-light by 233px\. Fix it\.\n  Sticking out at phone-light: main > canvas#chart \(608px wide, right edge at 608px\)/)
})

test("built-in audit finds labels, names, repeated actions, contrast, alt and lang without axe-core", { skip: !chrome && "no Chrome installed", timeout: 300000 }, async (t) => {
  const dir = await tmp(t)
  const bad = path.join(dir, "bad.html"), good = path.join(dir, "good.html")
  await writeFile(bad, `<!doctype html><html><head><title>t</title><style>
    .pale { color: #fff; background: #60a5fa; padding: 4px }
    </style></head><body><main><h1>List</h1><input type="text"><button></button><img src="x.png" width="10" height="10">
    <ul><li>Lunch <button>Edit</button></li><li>Rent <button>Edit</button></li></ul><p class="pale">Low contrast</p></main></body></html>`)
  await writeFile(good, `<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>List</h1>
    <label for="a">Amount</label><input id="a"><button>Save</button><img src="x.png" alt="" width="10" height="10">
    <ul><li>Lunch <button aria-label="Edit Lunch">Edit</button></li><li>Rent <button aria-label="Edit Rent">Edit</button></li></ul><p>Readable</p></main></body></html>`)
  const plan = [{ viewport: viewportSpecs(["desktop"])[0], scheme: "light" }]
  const ids = async (file) => (await runCheck({ chrome, url: toUrl(file, false), plan, fullPage: false, basicAudit: true })).violations.map((v) => v.id).sort()
  assert.deepEqual(await ids(bad), ["button-name", "color-contrast", "html-has-lang", "image-alt", "label", "repeated-action-name"])
  assert.deepEqual(await ids(good), [])
})
