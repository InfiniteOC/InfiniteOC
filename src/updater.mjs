// InfiniteOC self-updater: fast-forwards this git checkout to its tracked remote branch. It never
// touches stock OpenCode or a checkout with local commits or edits. When the update moves the pinned
// OpenCode tag, that tag is fetched into .upstream first, so a network failure stops before the code moves.
// The launcher checks at most every six hours (settings.json "updates": {"mode": "auto"|"ask"|"off"}).
import { spawn } from "node:child_process"
import { access, readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fx } from "./fx.mjs"
import { isOffline, onBattery } from "./netpower.mjs"

export const UPDATE_MODES = ["auto", "ask", "off"]
export const INTERVAL = 6 * 60 * 60 * 1000
const COUNTDOWN = 5000

export const updateMode = (saved) => (UPDATE_MODES.includes(saved?.updates?.mode) ? saved.updates.mode : "auto")
/** Opt-in (settings.json "updates": {"requireSigned": true}): only fast-forward to a target git can verify as signed. */
export const requireSigned = (saved) => saved?.updates?.requireSigned === true

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
export async function inspect(home, { fetch = true, tags = false } = {}) {
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
  if (fetch) await git(home, ["fetch", "--quiet", tags ? "--tags" : "--no-tags"], 20000)
  const behind = Number(await git(home, ["rev-list", "--count", "HEAD..@{u}"]))
  const ahead = Number(await git(home, ["rev-list", "--count", "@{u}..HEAD"]))
  const dirty = await git(home, ["status", "--porcelain", "--untracked-files=no"]) !== ""
  return {
    upstream,
    behind,
    from: await git(home, ["rev-parse", "--short", "HEAD"]),
    to: await git(home, ["rev-parse", "--short", "@{u}"]),
    fromFull: await git(home, ["rev-parse", "HEAD"]),
    toFull: await git(home, ["rev-parse", "@{u}"]),
    commits: behind ? (await git(home, ["log", "--format=%s", "--max-count=6", "HEAD..@{u}"])).split("\n") : [],
    pin: behind ? await pinChange(home) : undefined,
    blocked: ahead ? "this checkout has local commits" : dirty ? "this checkout has uncommitted changes" : undefined,
  }
}

// The pinned OpenCode tag (infiniteoc.json "upstream") before and after the update, when it changes.
async function pinChange(home) {
  const pin = async (ref) => JSON.parse(await git(home, ["show", `${ref}:infiniteoc.json`])).upstream
  try {
    const [from, to] = [await pin("HEAD"), await pin("@{u}")]
    return from !== to && /^v\d+\.\d+\.\d+$/.test(to) ? { from, to } : undefined
  } catch {
    return undefined
  }
}

/** Throws unless `ref` is a commit git verifies, or carries a tag git verifies. Returns what verified. */
export async function verifyTarget(home, ref) {
  try {
    await git(home, ["verify-commit", ref])
    return "signed commit"
  } catch (commitError) {
    for (const tag of (await git(home, ["tag", "--points-at", ref])).split("\n").filter(Boolean)) {
      try {
        await git(home, ["verify-tag", tag])
        return `signed tag ${tag}`
      } catch {}
    }
    throw new Error(`the update target is not signed or its signature does not verify (${commitError.message.replace(/^git verify-commit failed: /, "")})`)
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
    ...(info.pin ? [{ text: `${ui.gradient("◆")} OpenCode ${ui.bold(info.pin.from)} ${ui.dim("→")} ${ui.bold(info.pin.to)}`, plain: `◆ OpenCode ${info.pin.from} → ${info.pin.to}` }] : []),
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
  // No network, or a laptop on battery: skip the background check (infiniteoc update still works).
  if (!explicit && (isOffline() || onBattery())) return undefined
  const ui = fx(stream, { motion })
  const tags = requireSigned(saved)
  const interactive = ui.tty && !!process.stdin.isTTY
  let info
  try {
    info = explicit ? await ui.spin("Checking for InfiniteOC updates", () => inspect(home, { tags })) : await inspect(home, { tags })
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
  const signed = requireSigned(saved)
  if (signed) {
    try {
      await verifyTarget(home, info.toFull)
    } catch (error) {
      const message = `InfiniteOC update ${info.to} refused: ${error.message}. Set updates.requireSigned to false to allow unsigned updates`
      if (explicit) throw new Error(message)
      ui.write(`${ui.dim(`[InfiniteOC] ${message}`)}\n`)
      return undefined
    }
  }
  if (!explicit && state.skip === info.toFull) {
    ui.write(`${ui.dim(`[InfiniteOC] Update ${info.to} failed to build on this machine earlier and was rolled back; run infiniteoc update to retry`)}\n`)
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
  // A moved pin: fetch the new OpenCode tag before the code moves, so a network failure leaves everything as it was.
  // The build checks it out (launcher pinUpstream); a fresh install without .upstream clones it there.
  const source = join(home, ".upstream")
  if (info.pin && await access(join(source, ".git")).then(() => true, () => false))
    await ui.spin(`Fetching OpenCode ${info.pin.to}`, () => git(source, ["fetch", "--quiet", "--depth", "1", "--no-tags", "origin", "tag", info.pin.to], 180000)).catch((error) => {
      throw new Error(`InfiniteOC was not updated: fetching OpenCode ${info.pin.to} failed (${error.message}); try again when online`)
    })
  // The exact commit that was inspected (and verified), not whatever the branch has since become.
  await ui.spin(`Updating to ${info.to}`, () => git(home, ["merge", "--ff-only", "--quiet", info.toFull]))
  await writeState(home, { ...(await readState(home)), pending: { from: info.fromFull, to: info.toFull } })
  const summary = `${info.from} → ${info.to} (${info.behind} commit${info.behind === 1 ? "" : "s"})`
  ui.write(`${ui.ok(`Updated InfiniteOC ${summary}`)}\n`)
  return summary
}

/**
 * Runs `setup` (-> exit code) right after an update moved the checkout. If it fails, the checkout goes back to
 * the commit it was fast-forwarded from and `setup` runs again to rebuild the previous version.
 * Returns { ok, rolledBack?, restored?, code }. Never touches a checkout that moved or changed since the update.
 */
export async function settle(home, setup, { stream = process.stderr, motion = true } = {}) {
  const code = await setup()
  const state = await readState(home)
  const pending = state.pending
  // A Ctrl+C is the user's choice, not a failed update.
  if (code === 0 || !pending || code === 130 || code === 143) {
    if (pending) await writeState(home, { ...state, pending: undefined })
    return { ok: code === 0, code }
  }
  const ui = fx(stream, { motion })
  const [from, to] = [pending.from.slice(0, 7), pending.to.slice(0, 7)]
  const head = await git(home, ["rev-parse", "HEAD"])
  const dirty = await git(home, ["status", "--porcelain", "--untracked-files=no"]) !== ""
  await writeState(home, { ...state, pending: undefined })
  ui.write("\n")
  if (head !== pending.to || dirty) {
    ui.write(`${ui.fail(`Update ${to} did not build (exit ${code}); this checkout changed since the update, so it was not rolled back`)}\n`)
    return { ok: false, code }
  }
  ui.write(`${ui.fail(`Update ${to} did not build (exit ${code}); its output is above`)}\n`)
  await ui.spin(`Rolling back to ${from}`, () => git(home, ["reset", "--hard", "--quiet", pending.from]))
  await writeState(home, { ...(await readState(home)), skip: pending.to, rolledBack: { ...pending, at: new Date().toISOString() } })
  await ui.shimmer(`◆ Rebuilding ${from}`, { duration: 500 })
  const restored = (await setup()) === 0
  const rows = restored
    ? [`${from} is back and built. ${to} will not be retried automatically.`, "infiniteoc update tries it again."]
    : [`Rolled back to ${from}, but rebuilding it also failed.`, "infiniteoc doctor --fix repairs tools and the build."]
  ui.write(`${restored ? ui.ok("Previous version restored") : ui.fail("Previous version did not rebuild")}\n${ui.box(rows.map((text) => ({ text: ui.dim(text), plain: text })))}\n`)
  return { ok: false, rolledBack: true, restored, code }
}
