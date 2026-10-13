// Pure helpers for mods/awareness. No imports beyond erasable TypeScript so
// node --test can load this file directly; mods/awareness copies it next to
// the server plugin. Nothing here executes commands or reads files: the caller
// supplies the file list and a reader, and the plugin supplies the real fs.
export type Project = { files: string[]; read: (name: string) => string | undefined }
export type CheckKind = "check" | "tests" | "types" | "lint"

const STUB = /no test specified/

/** The project's check command for one kind, from package.json scripts, a Makefile, cargo, go or pytest. */
export function detectCheck(project: Project, kind: CheckKind = "check"): string | undefined {
  const has = (name: string) => project.files.includes(name)
  let scripts: Record<string, string> = {}
  try {
    scripts = JSON.parse(project.read("package.json") ?? "{}").scripts ?? {}
  } catch {}
  const names: Record<CheckKind, string[]> = {
    check: ["check", "verify", "test"],
    tests: ["test"],
    types: ["typecheck", "type-check", "check:types", "tsc"],
    lint: ["lint"],
  }
  const script = names[kind].find((name) => typeof scripts[name] === "string" && !STUB.test(scripts[name]))
  if (script) {
    const runner = has("bun.lock") || has("bun.lockb") ? "bun run" : has("pnpm-lock.yaml") ? "pnpm run" : has("yarn.lock") ? "yarn" : "npm run"
    return `${runner} ${script}`
  }
  if (kind === "types" && has("tsconfig.json") && has("package.json")) return "npx tsc --noEmit"
  const make = project.read("Makefile") ?? project.read("makefile")
  const target = make ? names[kind].find((name) => new RegExp(`^${name}\\s*:`, "m").test(make)) : undefined
  if (target) return `make ${target}`
  if (has("Cargo.toml")) return { check: "cargo check --all-targets", tests: "cargo test", types: "cargo check --all-targets", lint: "cargo clippy --all-targets" }[kind]
  if (has("go.mod")) return { check: "go vet ./... && go test ./...", tests: "go test ./...", types: "go build ./...", lint: "go vet ./..." }[kind]
  if (kind !== "types" && kind !== "lint" && (has("pytest.ini") || /pytest/.test(project.read("pyproject.toml") ?? "") || /pytest/.test(project.read("setup.cfg") ?? ""))) return "python -m pytest -q"
  return undefined
}

/** All four check commands at once; each is a command string or undefined when not detected. */
export function detectChecks(project: Project): Record<CheckKind, string | undefined> {
  return { check: detectCheck(project, "check"), tests: detectCheck(project, "tests"), types: detectCheck(project, "types"), lint: detectCheck(project, "lint") }
}

/** Human-readable rendering of detectChecks: every kind with its command or "not detected". */
export function formatChecks(checks: Record<CheckKind, string | undefined>): string {
  const rows: Array<[CheckKind, string]> = (["check", "tests", "types", "lint"] as const).map((kind) => [kind, checks[kind] ?? "not detected"])
  const found = rows.filter(([, command]) => command !== "not detected")
  const head = found.length
    ? `Detected project checks (run these instead of guessing):\n${rows.map(([kind, command]) => `- ${kind}: ${command}`).join("\n")}`
    : `No check commands detected from package.json scripts, Makefile, Cargo.toml, go.mod or pytest config.\n${rows.map(([kind]) => `- ${kind}: not detected`).join("\n")}\nLook at package.json scripts, Makefile targets, CI config and docs for the real commands.`
  return `${head}\n\nRun the command after your last edit and report its result; a clean build alone is not proof.`
}

// Exact input shapes and when-to-use for every InfiniteOC custom tool.
// Kept here (returned on demand by the tool_guide tool) so the every-turn
// guidance stays short; this text is only in context when the agent asks.
export const TOOL_GUIDE: Record<string, string> = {
  free_port: "free_port {} — no input. Returns `Free port: N. ...`. Call before starting ANY dev server or listener; pass as PORT=N (or --port N) and report http://localhost:N. One-off check: start in background, stop when done. Long-lived: tell the user to use /serve.",
  env_diff: "env_diff {example?: '.env.example', env?: '.env'} — compares template with .env, returns missing/empty/extra NAMES only. Use instead of reading .env; never print values.",
  project_checks: "project_checks {} — no input. Returns detected check/tests/types/lint commands (this mod). Call before claiming how to build, test or lint; run the returned command.",
  tool_guide: "tool_guide {tool?: name} — no required input. Returns this cheat-sheet (or one entry). Call when unsure of a custom tool's shape.",
  memory: "memory {action: 'add'|'list'|'remove', text?} — one short line per durable fact (build commands, gotchas, preferences); never secrets or task progress. text required for add/remove.",
  repo_map: "repo_map {path?: 'src/server', query?: 'auth'} — cached file:symbol outline. Start here in unfamiliar code; narrow with path or query before grepping.",
  trace_lookup: "trace_lookup {trace: '<verbatim stack trace>', context?: 2} — maps frames to local file:line with source. Call FIRST when the user pastes an error.",
  type_lookup: "type_lookup {name: 'Request'|'useState', package?: 'express'} — installed .d.ts + configured docs. Use instead of recalling an API from memory.",
  log_tail: "log_tail {name?: '<key from logs in .infiniteoc/context.json or path>', lines?: 100, match?: 'error'} — recent log output. Omit name to list configured logs.",
  sql_peek: "sql_peek {sql?: 'schema'|'SELECT ...', limit?: 50} — read-only SELECT/WITH/EXPLAIN/introspection PRAGMAs against the configured SQLite file. 'schema' lists tables+DDL.",
  openapi_lookup: "openapi_lookup {query?: 'order', operation?: 'GET /users/{id}'} — query lists 'METHOD /path - summary'; operation returns params/body/responses with $refs resolved.",
  linked_repo: "linked_repo {repo: '<folder name>', path?: '.', grep?: 'literal', offset?: 1, limit?: 400} — read-only list/read/grep of a linked sibling repo. Never edits.",
  ui_check: "ui_check {target: 'http://localhost:PORT/...'|'path.html', viewports?, schemes?, full_page?, a11y?, save_baseline?, mockup?} — headless-Chrome screenshots (phone 375/tablet 768/desktop 1280 + dark), overflow, console errors, axe audit, pixel diff. Capture BEFORE editing so after shows a diff.",
  design_tokens: "design_tokens {path?: dir} — CSS vars + Tailwind theme grouped by color/type/space/radius/shadow/motion. Read before writing UI.",
  component_catalog: "component_catalog {path?: dir} — existing components with file, props, usage count. Reuse instead of creating.",
  coverage_delta: "coverage_delta {command?: 'npm run coverage', save_baseline?: false} — runs coverage, reports line % vs baseline. First call stores baseline.",
  mutation_check: "mutation_check {file: 'src/x.ts', test_command: 'npm test', line?: 42} — flips one condition, expects test failure ('killed' = covered, 'SURVIVED' = add a test). Suite must pass first; file is restored.",
  bench_guard: "bench_guard {command?, runs?: 3, tolerance_pct?: 15, save_baseline?: false} — best-of-N benchmark vs baseline; warns on regression. Call before + after perf work.",
  prune_scan: "prune_scan {path?: dir} — unused files/exports candidates only, never deletes. Spot-check dynamic imports before presenting.",
  license_check: "license_check {path: 'vendor/foo'} — LICENSE/package.json/SPDX scan, permissive/copyleft/unknown + what is needed. Run when vendoring code.",
}

/** The full cheat-sheet, or one entry; unknown names list what exists. */
export function toolGuide(tool?: string): string {
  const name = (tool ?? "").trim()
  if (!name) return `InfiniteOC custom tools (all codemode:false; batch independent calls in one block):\n\n${Object.entries(TOOL_GUIDE).map(([key, text]) => `- ${text}`).join("\n")}`
  const hit = TOOL_GUIDE[name]
  if (hit) return `- ${hit}`
  return `Unknown tool "${name}". Known custom tools: ${Object.keys(TOOL_GUIDE).join(", ")}.`
}
