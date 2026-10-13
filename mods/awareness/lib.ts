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
  infiniteoc: "infiniteoc {op?: 'status'|'mods'|'doctor'|'check'|'new'|'enable'|'disable'|'rebuild'|'update'|'bench'|'remote'|'mod'|'wizard'|'team'|'devflow'|'advantages'|'help', target?: '<mod-ID>'} — manage InfiniteOC and use its advantages. Read ops answer directly; recipes quote the terminal command for the user; user-only ops (update/bench/remote/mod/wizard) stop there. Never execute state-changing ops yourself.",
  parallel: "parallel (guide entry — call tool_guide {tool: 'parallel'}) — Same-block independent calls run concurrently; reads and different-file writes need no sequencing. Rules: batch independent reads/searches in one block; never parallelize edits to the SAME file (per-file locks serialize them — sequence instead); each approval-gated call still prompts separately, so batch only what you would approve together; give disjoint multi-file chunks to parallel general subagents, never two writers on one file; dependent steps (find, then read, then edit, then check) stay sequential.",
}

/** The full cheat-sheet, or one entry; unknown names list what exists. */
export function toolGuide(tool?: string): string {
  const name = (tool ?? "").trim()
  if (!name) return `InfiniteOC custom tools (all codemode:false; batch independent calls in one block):\n\n${Object.entries(TOOL_GUIDE).map(([key, text]) => `- ${text}`).join("\n")}`
  const hit = TOOL_GUIDE[name]
  if (hit) return `- ${hit}`
  return `Unknown tool "${name}". Known custom tools: ${Object.keys(TOOL_GUIDE).join(", ")}.`
}

// --- InfiniteOC manager (the `infiniteoc` tool) -------------------------------------------
// Read-only introspection plus recipes. The tool NEVER executes state-changing
// operations itself: for those it returns the exact terminal command with its
// preconditions, and the user runs it. Levels:
// - read:     answered directly from files (no exec, no network).
// - recipe:   safe for the user to run now; exact command + what it does first.
// - user-only: must not run from agent context at all (money, network listener,
//   remote code, history rewrite); the agent quotes the command and stops.
export type InfiniteocLevel = "read" | "recipe" | "user-only"
export type InfiniteocOp = { level: InfiniteocLevel; run: string; about: string }

export const INFINITEOC_OPS: Record<string, InfiniteocOp> = {
  status: { level: "read", run: "infiniteoc tool: status", about: "Checkout path, upstream pin, configured mods, git branch (best effort). No exec." },
  mods: { level: "read", run: "infiniteoc mods", about: "List configured mods (imports them: only enable trusted mods)." },
  doctor: { level: "read", run: "infiniteoc doctor [--json]", about: "Read-only checks. doctor --fix is user-only: it fetches tools and rebuilds." },
  check: { level: "read", run: "infiniteoc feature check <ID>", about: "Validate a mod's declarations and UI anchors in a disposable tree; edits nothing." },
  new: { level: "recipe", run: "infiniteoc feature new <ID>", about: "Scaffold mods/<ID>/ with a working slash command. Does not enable it; edit command.tsx, then check." },
  enable: { level: "recipe", run: "infiniteoc feature enable <ID>", about: "Checks first, then appends to infiniteoc.json mods (keeps .bak). Rebuild + interact to verify." },
  disable: { level: "recipe", run: "infiniteoc feature disable <ID>", about: "Removes from infiniteoc.json mods (keeps .bak). Restart rebuilds." },
  rebuild: { level: "recipe", run: "infiniteoc rebuild", about: "ONLY at a safe boundary: never during active agent work. Replaces the generated tree." },
  update: { level: "user-only", run: "infiniteoc update", about: "Fast-forwards the checkout and rebuilds. Never from agent context: it rewrites the code under running work." },
  bench: { level: "user-only", run: "infiniteoc bench --a CFG --b CFG", about: "Spends real provider money on real runs. Ask first; never auto-run." },
  remote: { level: "user-only", run: "infiniteoc remote", about: "Opens a network listener (private addresses, token). Opt-in only; never start it yourself." },
  mod: { level: "user-only", run: "infiniteoc mod add URL --commit <hex> --sha256 <hex>", about: "Installs remote git code as a trusted mod. User reviews the commit; ext:: URLs refused." },
  wizard: { level: "user-only", run: "infiniteoc wizard", about: "Interactive first-run setup (provider, model, theme). A person answers; not an agent flow." },
  team: { level: "recipe", run: "infiniteoc team [trust|revoke]", about: "Show or approve the project's infiniteoc.team.json (traffic + updates only)." },
  devflow: { level: "read", run: "FEATURES.md", about: "The mod dev loop: new -> edit command.tsx -> check -> enable -> rebuild -> interact. Tabs are not sessions; persistent changes in mods/ only." },
  advantages: { level: "read", run: "tool_guide", about: "InfiniteOC advantages for real projects: /goal autonomy, /ponytail minimal-code modes, /routing cheap/strong/fallback, /budget limits, memory+glossary+pins context, quality tools (ui_check, mutation_check, coverage_delta), safety gates. Call tool_guide {} for shapes, tool_guide {tool: 'parallel'} for concurrency rules." },
  help: { level: "read", run: "infiniteoc tool: help", about: "This op list." },
}

export const INFINITEOC_OP_NAMES = Object.keys(INFINITEOC_OPS)

/** Upward search for infiniteoc.json from startDir; exists tests one directory. Pure except exists. */
export function findCheckout(startDir: string, exists: (dir: string) => boolean, maxDepth = 6): string | undefined {
  const parts = startDir.split("/").filter(Boolean)
  const rooted = startDir.startsWith("/")
  for (let depth = 0; depth <= maxDepth && depth <= parts.length; depth++) {
    const dir = (rooted ? "/" : "") + parts.slice(0, parts.length - depth).join("/") || "/"
    try {
      if (exists(dir)) return dir === "" ? "/" : dir
    } catch {
      return undefined
    }
  }
  return undefined
}

export type CheckoutInfo = { dir: string; upstream: string; mods: string[]; branch?: string }

/** Parse an infiniteoc.json text; returns info or an error line (never throws, never prints secrets). */
export function readCheckout(dir: string, text: string | undefined, branch?: string): CheckoutInfo | string {
  if (text === undefined) return `No infiniteoc.json in ${dir}. Pass the checkout path or run inside one.`
  try {
    const parsed = JSON.parse(text) as { upstream?: unknown; mods?: unknown }
    if (typeof parsed.upstream !== "string" || !Array.isArray(parsed.mods)) return `infiniteoc.json in ${dir} has no upstream string or mods array.`
    return { dir, upstream: parsed.upstream, mods: parsed.mods.filter((m): m is string => typeof m === "string"), branch }
  } catch {
    return `infiniteoc.json in ${dir} is not strict JSON; not reading further.`
  }
}

/** One-line status rendering; secrets never included (only pin + mod paths + branch). */
export function formatCheckout(info: CheckoutInfo): string {
  const mods = info.mods.length ? info.mods.map((m) => `- ${m}`).join("\n") : "(no mods configured)"
  return `InfiniteOC checkout: ${info.dir}\nUpstream pin: ${info.upstream}${info.branch ? `\nGit branch: ${info.branch}` : ""}\nMods (${info.mods.length}):\n${mods}`
}

const USER_ONLY_WHY: Record<string, string> = {
  update: "it fast-forwards the checkout and rebuilds under running work",
  bench: "it spends real provider money",
  remote: "it opens a network listener",
  mod: "it installs remote code as trusted local code",
  wizard: "it is an interactive person-facing flow",
}

/** Dispatch the infiniteoc tool: read ops answer directly, others return exact commands with guards. */
export function infiniteoc(op: string | undefined, target: string | undefined, status: CheckoutInfo | string): string {
  const name = (op ?? "status").trim() || "status"
  if (name === "status") return typeof status === "string" ? status : formatCheckout(status)
  if (name === "help") return `InfiniteOC ops:\n${INFINITEOC_OP_NAMES.map((key) => `- ${key} (${INFINITEOC_OPS[key].level}): ${INFINITEOC_OPS[key].about}`).join("\n")}\n\nState-changing ops are never executed by this tool: recipes quote the terminal command for the user; user-only ops stop there.`
  const entry = INFINITEOC_OPS[name]
  if (!entry) return `Unknown op "${name}". Known ops: ${INFINITEOC_OP_NAMES.join(", ")}.`
  const needsTarget = ["check", "new", "enable", "disable"].includes(name)
  if (needsTarget && !(target ?? "").trim()) return `Usage: infiniteoc {op: "${name}", target: "<mod-ID>"}. ${entry.about} Run: ${entry.run.replace("<ID>", "<mod-ID>")}`
  const run = needsTarget ? entry.run.replace("<ID>", (target ?? "").trim()) : entry.run
  if (entry.level === "read") {
    if (name === "mods") return `${typeof status === "string" ? status : formatCheckout(status)}\n\nTo change them: ${INFINITEOC_OPS.enable.run} / ${INFINITEOC_OPS.disable.run} (user runs it).`
    if (name === "doctor") return `${entry.about}\nUser runs: ${run}`
    if (name === "check") return `${entry.about}\nUser runs: ${run}`
    return `${entry.about}`
  }
  if (entry.level === "recipe") {
    const guard = name === "rebuild"
      ? "Precondition: run ONLY at a safe boundary, never during active agent work (it replaces the generated tree)."
      : name === "enable"
        ? "Precondition: feature check passes first (enable runs it); rebuild + interact to verify."
        : "The user runs this in a terminal; do not execute it yourself."
    return `${entry.about}\n${guard}\nUser runs: ${run}`
  }
  return `${entry.about}\nRefused from agent context: ${USER_ONLY_WHY[name] ?? "it changes state outside safe agent operation"}. Quote the command and stop; the user decides.\nUser runs: ${run}`
}
