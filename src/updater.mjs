// InfiniteOC self-updater: fast-forwards this git checkout to its tracked remote branch. It never
// touches stock OpenCode, the pinned upstream tag, or a checkout with local commits or edits.
// The launcher checks at most every six hours (settings.json "updates": {"mode": "auto"|"ask"|"off"}).
import { spawn } from "node:child_process"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fx } from "./fx.mjs"

export const UPDATE_MODES = ["auto", "ask", "off"]
export const INTERVAL = 6 * 60 * 60 * 1000
const COUNTDOWN = 5000

export const updateMode = (saved) => (UPDATE_MODES.includes(saved?.updates?.mode) ? saved.updates.mode : "auto")

// Async so spinners keep animating while git works.
function git(home, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", home, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", LC_ALL: "C" },
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`git ${args[0]} timed out`))
    }, timeout)
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error.code === "ENOENT" ? new Error("git not found on PATH") : error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`git ${args[0]} failed: ${stderr.trim().split("\n").at(-1) || `exit ${code}`}`))
    })
  })
}

/** What updating would bring, or undefined when this is not a git checkout. */
export async function inspect(home, { fetch = true } = {}) {
  try {
    if (await git(home, ["rev-parse", "--is-inside-work-tree"]) !== "true") return undefined
  } catch {
    return undefined
  }
  let upstream
  try {
    upstream = await git(home, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
  } catch {
    return { behind: 0, commits: [], blocked: "the current branch tracks no remote branch" }
  }
  if (fetch) await git(home, ["fetch", "--quiet", "--no-tags"], 20000)
  const behind = Number(await git(home, ["rev-list", "--count", "HEAD..@{u}"]))
  const ahead = Number(await git(home, ["rev-list", "--count", "@{u}..HEAD"]))
  const dirty = await git(home, ["status", "--porcelain", "--untracked-files=no"]) !== ""
  return {
    upstream,
    behind,
    from: await git(home, ["rev-parse", "--short", "HEAD"]),
    to: await git(home, ["rev-parse", "--short", "@{u}"]),
    commits: behind ? (await git(home, ["log", "--format=%s", "--max-count=6", "HEAD..@{u}"])).split("\n") : [],
    blocked: ahead ? "this checkout has local commits" : dirty ? "this checkout has uncommitted changes" : undefined,
  }
}

const statePath = (home) => join(home, ".runtime", "update.json")
const readState = (home) => readFile(statePath(home), "utf8").then(JSON.parse).catch(() => ({}))
const writeState = async (home, state) => {
  await mkdir(join(home, ".runtime"), { recursive: true })
  await writeFile(statePath(home), JSON.stringify(state))
}

// One keypress from a raw TTY: enter or y updates, s/n/q/esc skips, ctrl-c aborts. Times out to `fallback`.
function choose(timeout, fallback, onTick) {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    const started = Date.now()
    const timer = setInterval(() => {
      const left = timeout - (Date.now() - started)
      if (left <= 0) return done(fallback)
      onTick?.(left)
    }, 50)
    const done = (value, error) => {
      clearInterval(timer)
      input.off("data", key)
      input.setRawMode(false)
      input.pause()
      error ? reject(error) : resolve(value)
    }
    const key = (data) => {
      const text = data.toString()
      if (text === "\u0003") return done(undefined, Object.assign(new Error("interrupted"), { exitCode: 130 }))
      if (text === "\r" || text === "\n" || text.toLowerCase() === "y") return done("update")
      if (["s", "n", "q", "\u001b"].includes(text.toLowerCase())) return done("skip")
    }
    input.setRawMode(true)
    input.resume()
    input.on("data", key)
    onTick?.(timeout)
  })
}

function banner(ui, info) {
  const count = `${info.behind} new commit${info.behind === 1 ? "" : "s"}`
  const rows = [
    { text: `${ui.bold(info.from)} ${ui.dim("→")} ${ui.bold(info.to)}  ${ui.dim(`${count} on ${info.upstream}`)}`, plain: `${info.from} → ${info.to}  ${count} on ${info.upstream}` },
    ...info.commits.map((subject) => {
      const short = subject.length > 64 ? `${subject.slice(0, 63)}…` : subject
      return { text: `${ui.gradient("•")} ${short}`, plain: `• ${short}` }
    }),
    ...(info.behind > info.commits.length ? [{ text: ui.dim(`… and ${info.behind - info.commits.length} more`), plain: `… and ${info.behind - info.commits.length} more` }] : []),
  ]
  ui.write(`${ui.box(rows)}\n`)
}

/**
 * Offers and applies an update. Returns a summary string when the checkout moved, else undefined.
 * `explicit` (infiniteoc update) ignores the interval and mode and applies without asking.
 */
export async function update({ home, saved, motion = true, explicit = false, stream = process.stderr }) {
  const mode = explicit ? "auto" : updateMode(saved)
  if (mode === "off") return undefined
  const state = await readState(home)
  if (!explicit && Date.now() - (state.checkedAt ?? 0) < INTERVAL) return undefined
  const ui = fx(stream, { motion })
  const interactive = ui.tty && !!process.stdin.isTTY
  let info
  try {
    info = explicit ? await ui.spin("Checking for InfiniteOC updates", () => inspect(home)) : await inspect(home)
  } catch (error) {
    if (explicit) throw error
    // Offline or no access: stay quiet and try again next interval.
    await writeState(home, { ...state, checkedAt: Date.now(), error: error.message })
    return undefined
  }
  if (!explicit) await writeState(home, { ...state, checkedAt: Date.now(), error: undefined })
  if (!info) {
    if (explicit) throw new Error("this InfiniteOC is not a git checkout; reinstall it with git clone to get updates")
    return undefined
  }
  if (!info.behind) {
    if (explicit) ui.write(`${ui.ok(`InfiniteOC is up to date (${info.from ?? "local"})`)}\n`)
    return undefined
  }
  if (info.blocked) {
    const message = `InfiniteOC update available (${info.behind} commit${info.behind === 1 ? "" : "s"}), but ${info.blocked}; run git pull --ff-only in ${home}`
    if (explicit) throw new Error(message)
    ui.write(`${ui.dim(`[InfiniteOC] ${message}`)}\n`)
    return undefined
  }
  if (!explicit && !interactive) {
    ui.write(`[InfiniteOC] Update available (${info.behind} commit${info.behind === 1 ? "" : "s"}); run infiniteoc update\n`)
    return undefined
  }

  ui.write("\n")
  await ui.shimmer("◆ InfiniteOC update available", { passes: 2 })
  banner(ui, info)
  if (!explicit) {
    const wait = mode === "auto" ? COUNTDOWN : 30000
    const fallback = mode === "auto" ? "update" : "skip"
    const choice = await choose(wait, fallback, (left) => {
      const filled = Math.round(((wait - left) / wait) * 20)
      const bar = ui.gradient("■".repeat(filled)) + ui.dim("□".repeat(20 - filled))
      const lead = mode === "auto" ? `updating in ${Math.ceil(left / 1000)}s` : "update now?"
      ui.line(`${bar} ${lead} ${ui.dim("· enter: update · s: skip")}`)
    })
    ui.line("")
    if (choice !== "update") {
      ui.write(`${ui.dim("Skipped; run infiniteoc update any time.")}\n`)
      return undefined
    }
  }
  await ui.spin(`Updating to ${info.to}`, () => git(home, ["merge", "--ff-only", "--quiet", "@{u}"]))
  const summary = `${info.from} → ${info.to} (${info.behind} commit${info.behind === 1 ? "" : "s"})`
  ui.write(`${ui.ok(`Updated InfiniteOC ${summary}`)}\n`)
  return summary
}
