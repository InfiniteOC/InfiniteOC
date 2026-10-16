// infiniteoc bench: runs a fixed set of small coding tasks against two configurations (model, agent, ponytail level)
// and compares pass rate, tokens and wall time. Each trial gets a fresh temp directory; a task passes when its
// check command exits 0 there. The built-in tasks are deliberately tiny and deterministic; --tasks FILE brings your own.
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir, cp } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { dirname, join } from "node:path"

const assertNode = (code) => ["node", "--input-type=module", "-e", code]
export const TASKS = [
  { id: "fix-sum", prompt: "sum.mjs exports sum(a, b) but returns the wrong result. Fix it.", files: { "sum.mjs": "export const sum = (a, b) => a - b\n" },
    check: assertNode(`import { sum } from "./sum.mjs"; if (sum(2, 3) !== 5 || sum(-1, 1) !== 0) process.exit(1)`) },
  { id: "add-slugify", prompt: "Create slug.mjs exporting slugify(text): lowercase, non-alphanumeric runs become a single dash, no leading or trailing dash. slugify('Hello, World!') must be 'hello-world'.", files: {},
    check: assertNode(`import { slugify } from "./slug.mjs"; if (slugify("Hello, World!") !== "hello-world" || slugify("  A  b ") !== "a-b") process.exit(1)`) },
  { id: "last-item", prompt: "last.mjs exports last(list) which should return the final element but fails for single-item lists. Fix it.", files: { "last.mjs": "export const last = (list) => list[list.length - 2]\n" },
    check: assertNode(`import { last } from "./last.mjs"; if (last([1]) !== 1 || last([1, 2, 3]) !== 3) process.exit(1)`) },
  { id: "add-is-even", prompt: "Add and export isEven(n) to math.mjs without changing double(n).", files: { "math.mjs": "export const double = (n) => n * 2\n" },
    check: assertNode(`import { isEven, double } from "./math.mjs"; if (!isEven(4) || isEven(3) || double(4) !== 8) process.exit(1)`) },
  { id: "rename-export", prompt: "In greet.mjs rename the export hi to greet and update main.mjs, which imports it.", files: { "greet.mjs": "export const hi = (name) => `Hello, ${name}`\n", "main.mjs": "import { hi } from './greet.mjs'\nexport const out = hi('bench')\n" },
    check: assertNode(`import { greet } from "./greet.mjs"; import { out } from "./main.mjs"; if (greet("x") !== "Hello, x" || out !== "Hello, bench") process.exit(1)`) },
]

/** "model=lab/fake,ponytail=off" -> { model, ponytail }. */
export function parseConfig(text) {
  const config = Object.fromEntries(text.split(",").filter(Boolean).map((pair) => { const [key, ...rest] = pair.split("="); return [key.trim(), rest.join("=").trim()] }))
  if (!config.model || !/^[^\s/]+\/\S+$/.test(config.model)) throw new Error(`Configuration "${text}" needs model=provider/model`)
  const unknown = Object.keys(config).filter((key) => !["model", "agent", "ponytail", "label"].includes(key))
  if (unknown.length) throw new Error(`Unknown configuration key ${unknown.join(", ")}; use model, agent, ponytail, label`)
  if (config.ponytail && !["auto", "lite", "full", "ultra", "off"].includes(config.ponytail)) throw new Error("ponytail must be auto, lite, full, ultra or off")
  return { label: config.label ?? text, ...config }
}

/** Sums the token counts of every step_finish event in `opencode run --format json` output. */
export function countTokens(stdout) {
  const total = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  for (const line of stdout.split("\n")) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    const tokens = event?.type === "step_finish" ? event.part?.tokens : undefined
    if (!tokens) continue
    total.input += tokens.input ?? 0; total.output += tokens.output ?? 0; total.reasoning += tokens.reasoning ?? 0
    total.cacheRead += tokens.cache?.read ?? 0; total.cacheWrite += tokens.cache?.write ?? 0
  }
  return total
}

const run = (command, args, options) => new Promise((resolve) => {
  const started = Date.now()
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.resume()
  const timer = options.timeout ? setTimeout(() => child.kill("SIGKILL"), options.timeout) : undefined
  child.on("error", () => { clearTimeout(timer); resolve({ code: 127, stdout, ms: Date.now() - started }) })
  child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 137, stdout, ms: Date.now() - started }) })
})

/** A config directory that mirrors the user's opencode config (symlinks) except for the ponytail level this trial needs. */
async function configFor(config, env) {
  const { opencodeConfigDir, isWindows } = await import("./platform.mjs")
  const real = opencodeConfigDir(env)
  const root = await mkdtemp(join(tmpdir(), "infiniteoc-bench-cfg-"))
  const dir = join(root, "opencode")
  await mkdir(dir)
  if (config.ponytail) {
    for (const name of await readdir(real).catch(() => [])) {
      if (name === ".ponytail-active") continue
      // Symlinks need elevation/Developer Mode on Windows; copy there instead.
      if (isWindows) await cp(join(real, name), join(dir, name), { recursive: true }).catch(() => {})
      else await symlink(join(real, name), join(dir, name))
    }
    await writeFile(join(dir, ".ponytail-active"), config.ponytail)
    return { XDG_CONFIG_HOME: root, cleanup: () => rm(root, { recursive: true, force: true }) }
  }
  await rm(root, { recursive: true, force: true })
  return { cleanup: async () => {} }
}

/** One trial: fixture directory, agent run, check. Returns { pass, ms, tokens, code }. */
export async function trial({ binary, env, config, task, timeout = 180_000, exec = run }) {
  const dir = await mkdtemp(join(tmpdir(), "infiniteoc-bench-"))
  const cfg = await configFor(config, env)
  try {
    for (const [name, content] of Object.entries(task.files)) { await mkdir(dirname(join(dir, name)), { recursive: true }); await writeFile(join(dir, name), content) }
    const args = ["run", "--standalone", "--format", "json", "--auto", "--title", `infiniteoc bench ${task.id}`, "-m", config.model, ...(config.agent ? ["--agent", config.agent] : []), task.prompt]
    // PWD too: the agent resolves relative paths from it, and spawn's cwd option does not update it.
    const result = await exec(binary, args, { cwd: dir, env: { ...env, PWD: dir, ...(cfg.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: cfg.XDG_CONFIG_HOME } : {}) }, timeout })
    const check = await exec(task.check[0], task.check.slice(1), { cwd: dir, env: { ...process.env, PWD: dir }, timeout: 30_000 })
    return { task: task.id, pass: result.code === 0 && check.code === 0, ms: result.ms, tokens: countTokens(result.stdout), code: result.code }
  } finally { await cfg.cleanup(); await rm(dir, { recursive: true, force: true }) }
}

export function summarize(trials) {
  const sum = (pick) => trials.reduce((total, item) => total + pick(item), 0)
  return { count: trials.length, passed: sum((item) => (item.pass ? 1 : 0)), passRate: trials.length ? sum((item) => (item.pass ? 1 : 0)) / trials.length : 0,
    tokens: sum((item) => item.tokens.input + item.tokens.output + item.tokens.reasoning), input: sum((item) => item.tokens.input), output: sum((item) => item.tokens.output),
    meanMs: trials.length ? Math.round(sum((item) => item.ms) / trials.length) : 0 }
}

/** Runs every task under both configurations, interleaved so drift (rate limits, load) hits both alike. */
export async function bench({ binary, env, configs, tasks = TASKS, runs = 1, timeout, exec, progress = () => {} }) {
  const results = configs.map((config) => ({ config, trials: [] }))
  for (const task of tasks)
    for (let round = 0; round < runs; round++)
      for (const result of results) {
        const done = await trial({ binary, env, config: result.config, task, timeout, exec })
        result.trials.push(done)
        progress(result.config, done)
      }
  return results.map(({ config, trials }) => ({ config, trials, ...summarize(trials) }))
}

export function format(results) {
  const pct = (value) => `${Math.round(value * 100)}%`
  const rows = [["", ...results.map((r) => r.config.label)],
    ["pass rate", ...results.map((r) => `${r.passed}/${r.trials.length} (${pct(r.passRate)})`)],
    ["tokens", ...results.map((r) => `${r.tokens} (in ${r.input}, out ${r.output})`)],
    ["mean time", ...results.map((r) => `${(r.meanMs / 1000).toFixed(1)}s`)]]
  const width = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))
  const lines = rows.map((row) => row.map((cell, column) => cell.padEnd(width[column])).join("  ").trimEnd())
  if (results.length === 2) {
    const [a, b] = results
    const delta = (x, y, unit = "") => (x ? `${y >= x ? "+" : ""}${Math.round(((y - x) / x) * 100)}%${unit}` : "n/a")
    lines.push("", `B vs A: pass rate ${Math.round((b.passRate - a.passRate) * 100)} points, tokens ${delta(a.tokens, b.tokens)}, time ${delta(a.meanMs, b.meanMs)}`)
  }
  const failed = results.flatMap((r) => r.trials.filter((trial) => !trial.pass).map((trial) => `${r.config.label}: ${trial.task}${trial.code ? ` (exit ${trial.code})` : ""}`))
  if (failed.length) lines.push("", `failed: ${failed.join("; ")}`)
  return lines.join("\n")
}
