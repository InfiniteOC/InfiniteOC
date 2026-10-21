// A/B eval of two InfiniteOC checkouts on one task with a real model: alternating trials, then a browser
// score (score.mjs), the project's own tests and run stats per trial. Builds must already exist (infiniteoc setup).
// Usage: node scripts/eval/run.mjs --a ~/InfiniteOC-main --b ~/InfiniteOC [--model opencode/beam-free]
//          [--runs 3] [--task scripts/eval/task-expense-tracker.md] [--out DIR] [--user NAME]
// --user (Linux, as root) runs each agent as that unprivileged user, so it cannot read other trials or the grader.
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { binaryPath } from "../../src/platform.mjs"
import { summarize } from "./stats.mjs"

const here = path.dirname(new URL(import.meta.url).pathname)
const flags = Object.fromEntries(process.argv.slice(2).join(" ").split(/\s+--/).filter(Boolean).map((part) => { const [key, ...rest] = part.replace(/^--/, "").split(/\s+/); return [key, rest.join(" ")] }))
const sides = { a: flags.a, b: flags.b }
if (!sides.a || !sides.b) { console.error("Usage: node scripts/eval/run.mjs --a CHECKOUT --b CHECKOUT [--model M] [--runs N] [--task FILE] [--out DIR] [--user NAME]"); process.exit(2) }
const model = flags.model || "opencode/beam-free"
const runs = Number(flags.runs || 3)
const task = fs.readFileSync(flags.task || path.join(here, "task-expense-tracker.md"), "utf8")
const out = path.resolve(flags.out || fs.mkdtempSync(path.join(os.tmpdir(), "ioc-eval-")))
const user = flags.user
for (const [side, home] of Object.entries(sides)) if (!fs.existsSync(binaryPath(path.resolve(home)))) throw new Error(`--${side}: no build in ${home} (run infiniteoc setup there)`)

function trial(name, home) {
  const dir = path.join(out, name), project = path.join(dir, "project")
  fs.mkdirSync(project, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: project })
  const env = { ...process.env, INFINITEOC: "1", OPENCODE_CLIENT: "InfiniteOC", INFINITEOC_HOME: home, INFINITEOC_SKILLS: path.join(home, "skills") }
  let command = binaryPath(home), args = ["run", "-m", model, "--format", "json", task]
  if (user) {
    execFileSync("chown", ["-R", user, dir])
    const keep = ["PATH", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "PLAYWRIGHT_BROWSERS_PATH", "INFINITEOC", "OPENCODE_CLIENT", "INFINITEOC_HOME", "INFINITEOC_SKILLS"]
    const home_ = execFileSync("getent", ["passwd", user], { encoding: "utf8" }).split(":")[5]
    args = ["-u", user, "--", "env", "-i", `HOME=${home_}`, `USER=${user}`, ...keep.filter((k) => env[k]).map((k) => `${k}=${env[k]}`), command, ...args]
    command = "runuser"
  }
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: project, env, stdio: ["ignore", fs.openSync(path.join(dir, "run.jsonl"), "w"), fs.openSync(path.join(dir, "run.err"), "w")] })
    const timer = setTimeout(() => child.kill("SIGKILL"), 25 * 60_000)
    child.on("close", (code) => {
      clearTimeout(timer)
      // Dev servers the agent left running would answer the next trial on the same port with the wrong project.
      if (user) try { execFileSync("pkill", ["-KILL", "-u", user]) } catch {}
      resolve({ name, code, ms: Date.now() - started, dir, project })
    })
  })
}

const serve = () => new Promise((resolve) => {
  const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" }
  const server = http.createServer((req, res) => {
    const file = path.join(out, decodeURIComponent(new URL(req.url, "http://x").pathname))
    if (!file.startsWith(out) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end() }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" }); fs.createReadStream(file).pipe(res)
  }).listen(0, "127.0.0.1", () => resolve(server))
})
const capture = (command, args, cwd) => new Promise((resolve) => { let text = ""; const child = spawn(command, args, { cwd }); child.stdout.on("data", (d) => (text += d)); child.stderr.on("data", (d) => (text += d)); child.on("close", () => resolve(text)) })

const trials = []
for (let i = 1; i <= runs; i++) for (const side of ["a", "b"]) {
  const result = await trial(`${side}-${i}`, path.resolve(sides[side]))
  console.error(`${result.name}: exit ${result.code}, ${(result.ms / 1000).toFixed(0)} s`)
  trials.push(result)
}
const server = await serve()
for (const t of trials) {
  const url = `http://127.0.0.1:${server.address().port}/${t.name}/project/index.html`
  const report = await capture(process.execPath, [path.join(here, "score.mjs"), url], out)
  t.score = report.match(/SCORE (\d+)\/(\d+)/)?.slice(1).map(Number) ?? [0, 0]
  t.failed = report.split("\n").filter((line) => line.startsWith("FAIL")).map((line) => line.slice(5).split(" — ")[0])
  t.tests = (await capture(process.execPath, ["--test"], t.project)).match(/# pass (\d+)[\s\S]*# fail (\d+)/)?.slice(1).map(Number)
  t.stats = summarize(path.join(t.dir, "run.jsonl"))
}
server.close()
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
console.log(`\nmodel ${model}, ${runs} run(s) per side, results in ${out}\n`)
console.log("trial  score  tests   time  steps  out+reason tok  failed checks")
for (const t of trials) console.log(`${t.name.padEnd(6)} ${String(t.score.join("/")).padEnd(6)} ${String(t.tests ? `${t.tests[0]}/${t.tests[0] + t.tests[1]}` : "-").padEnd(7)} ${String((t.ms / 1000).toFixed(0) + "s").padStart(5)} ${String(t.stats.steps).padStart(6)} ${String(t.stats.output + t.stats.reasoning).padStart(15)}  ${t.failed.join("; ")}`)
for (const side of ["a", "b"]) {
  const mine = trials.filter((t) => t.name.startsWith(side))
  console.log(`${side} (${sides[side]}): mean score ${mean(mine.map((t) => t.score[0])).toFixed(1)}, mean time ${mean(mine.map((t) => t.ms / 1000)).toFixed(0)} s, mean out+reason ${mean(mine.map((t) => t.stats.output + t.stats.reasoning)).toFixed(0)} tok`)
}
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(trials.map(({ dir, project, ...t }) => t), null, 2))
