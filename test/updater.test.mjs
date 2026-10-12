import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
process.env.INFINITEOC_OFFLINE = "0" // the checks under test must not depend on this machine's network or battery
process.env.INFINITEOC_BATTERY = "0"
import { update, inspect, updateMode } from "../src/updater.mjs"

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim()
const sink = () => ({ isTTY: false, text: "", write(chunk) { this.text += chunk; return true } })

// origin (bare) <- upstream clone pushes commits; home is the InfiniteOC checkout being updated.
async function checkouts(t) {
  const root = await mkdtemp(join(tmpdir(), "infiniteoc-update-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const origin = join(root, "origin.git"), upstream = join(root, "upstream"), home = join(root, "home")
  git(root, "init", "--quiet", "--bare", "-b", "main", origin)
  git(root, "clone", "--quiet", origin, upstream)
  git(upstream, "checkout", "--quiet", "-b", "main")
  await writeFile(join(upstream, "README.md"), "v1\n")
  git(upstream, "add", ".")
  git(upstream, "commit", "--quiet", "-m", "First")
  git(upstream, "push", "--quiet", "-u", "origin", "main")
  git(root, "clone", "--quiet", origin, home)
  const publish = async (message) => {
    await writeFile(join(upstream, "README.md"), `${message}\n`)
    git(upstream, "commit", "--quiet", "-am", message)
    git(upstream, "push", "--quiet")
  }
  return { home, publish }
}

test("explicit update fast-forwards to the remote branch and reports the commits", async (t) => {
  const { home, publish } = await checkouts(t)
  const stream = sink()
  assert.equal(await update({ home, saved: {}, explicit: true, stream }), undefined)
  assert.match(stream.text, /up to date/)
  await publish("Add goal")
  await publish("Add ponytail")
  const info = await inspect(home)
  assert.equal(info.behind, 2)
  assert.deepEqual(info.commits, ["Add ponytail", "Add goal"])
  const summary = await update({ home, saved: {}, explicit: true, stream: sink() })
  assert.match(summary, /^[0-9a-f]+ → [0-9a-f]+ \(2 commits\)$/)
  assert.equal(await readFile(join(home, "README.md"), "utf8"), "Add ponytail\n")
})

test("never updates over local edits or local commits", async (t) => {
  const { home, publish } = await checkouts(t)
  await publish("Remote change")
  await writeFile(join(home, "README.md"), "my edit\n")
  await assert.rejects(update({ home, saved: {}, explicit: true, stream: sink() }), /uncommitted changes/)
  assert.equal(await readFile(join(home, "README.md"), "utf8"), "my edit\n")
  git(home, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-am", "Local")
  await assert.rejects(update({ home, saved: {}, explicit: true, stream: sink() }), /local commits/)
})

test("launch-time checks honor off, the interval, and stay quiet without a terminal", async (t) => {
  const { home, publish } = await checkouts(t)
  await publish("Remote change")
  assert.equal(await update({ home, saved: { updates: { mode: "off" } }, stream: sink() }), undefined)
  assert.equal(await inspect(home, { fetch: false }).then((info) => info.behind), 0, "off never fetches")
  const stream = sink()
  assert.equal(await update({ home, saved: {}, stream }), undefined)
  assert.match(stream.text, /Update available \(1 commit\); run infiniteoc update/)
  assert.match(await readFile(join(home, ".runtime/update.json"), "utf8"), /checkedAt/)
  const again = sink()
  assert.equal(await update({ home, saved: {}, stream: again }), undefined)
  assert.equal(again.text, "", "within the interval nothing is checked")
})

test("not a git checkout or no tracked branch is handled without errors at launch", async (t) => {
  const plain = await mkdtemp(join(tmpdir(), "infiniteoc-plain-"))
  t.after(() => rm(plain, { recursive: true, force: true }))
  assert.equal(await update({ home: plain, saved: {}, stream: sink() }), undefined)
  await assert.rejects(update({ home: plain, saved: {}, explicit: true, stream: sink() }), /not a git checkout/)
  assert.equal(updateMode({ updates: { mode: "ask" } }), "ask")
  assert.equal(updateMode({ updates: { mode: "bogus" } }), "auto")
  assert.equal(updateMode(undefined), "auto")
})
