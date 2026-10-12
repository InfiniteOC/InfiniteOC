import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
process.env.INFINITEOC_OFFLINE = "0" // the checks under test must not depend on this machine's network or battery
process.env.INFINITEOC_BATTERY = "0"
import { update, inspect, updateMode, settle, verifyTarget, requireSigned } from "../src/updater.mjs"

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
  const publish = async (message, ...flags) => {
    await writeFile(join(upstream, "README.md"), `${message}\n`)
    git(upstream, "commit", "--quiet", "-am", message, ...flags)
    git(upstream, "push", "--quiet")
  }
  return { home, publish, upstream, root }
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

const quiet = () => ({ write() {} })

test("a failed build after an update rolls back to the previous commit and rebuilds it", async (t) => {
  const { home, publish } = await checkouts(t)
  const before = git(home, "rev-parse", "HEAD")
  await publish("Broken release")
  assert.match(await update({ home, saved: {}, explicit: true, stream: sink() }), /\(1 commit\)$/)
  assert.notEqual(git(home, "rev-parse", "HEAD"), before)
  const builds = []
  const result = await settle(home, async () => { builds.push(await readFile(join(home, "README.md"), "utf8")); return builds.length === 1 ? 2 : 0 }, { stream: quiet() })
  assert.deepEqual([result.ok, result.rolledBack, result.restored], [false, true, true])
  assert.deepEqual(builds, ["Broken release\n", "v1\n"], "the second build ran on the previous version")
  assert.equal(git(home, "rev-parse", "HEAD"), before)
  // The rolled-back target is not offered again automatically, but an explicit update retries it.
  const stream = sink()
  assert.equal(await update({ home, saved: {}, stream }), undefined)
  assert.equal(await update({ home, saved: {}, explicit: true, stream: sink() }) !== undefined, true)
})

test("a successful build, an interrupted one or a moved checkout is never rolled back", async (t) => {
  const { home, publish } = await checkouts(t)
  await publish("Good release")
  await update({ home, saved: {}, explicit: true, stream: sink() })
  const head = git(home, "rev-parse", "HEAD")
  assert.equal((await settle(home, async () => 0, { stream: quiet() })).ok, true)
  assert.equal(JSON.parse(await readFile(join(home, ".runtime/update.json"), "utf8")).pending, undefined)
  await publish("Second release")
  await update({ home, saved: {}, explicit: true, stream: sink() })
  assert.equal((await settle(home, async () => 130, { stream: quiet() })).rolledBack, undefined)
  assert.notEqual(git(home, "rev-parse", "HEAD"), head)
  // Edited after the update: failure reports it and leaves the tree alone.
  await publish("Third release")
  await update({ home, saved: {}, explicit: true, stream: sink() })
  await writeFile(join(home, "README.md"), "my edit\n")
  const kept = git(home, "rev-parse", "HEAD")
  assert.equal((await settle(home, async () => 1, { stream: quiet() })).rolledBack, undefined)
  assert.equal(git(home, "rev-parse", "HEAD"), kept)
  assert.equal(await readFile(join(home, "README.md"), "utf8"), "my edit\n")
})

// Stands in for gpg so signatures can be exercised without any key: signs with a marker, and verifies only that marker.
async function fakeGpg(root) {
  const program = join(root, "fake-gpg")
  await writeFile(program, `#!/bin/sh
case "$*" in
  *--verify*) sig=$(cat "$(printf '%s\\n' "$@" | grep -A1 -- --verify | tail -1)"); case "$sig" in *FAKESIG*) echo "[GNUPG:] NEWSIG"; echo "[GNUPG:] GOODSIG 0123456789ABCDEF t <t@t>"; echo "[GNUPG:] VALIDSIG 0123456789ABCDEF0123456789ABCDEF01234567 2026-01-01 1700000000 0 4 0 1 8 00 0123456789ABCDEF0123456789ABCDEF01234567"; echo "[GNUPG:] TRUST_ULTIMATE"; exit 0;; *) echo "[GNUPG:] BADSIG AAAA t <t@t>"; exit 1;; esac;;
  *) cat >/dev/null; echo "-----BEGIN PGP SIGNATURE-----"; echo FAKESIG; echo "-----END PGP SIGNATURE-----"; echo "[GNUPG:] SIG_CREATED D 1 8 00 1 AAAA" >&2;;
esac
`)
  await chmod(program, 0o755)
  return program
}

test("requireSigned refuses an unsigned target and accepts a signed commit or tag", async (t) => {
  const { home, publish, upstream, root } = await checkouts(t)
  const program = await fakeGpg(root)
  git(home, "config", "gpg.program", program)
  const sign = ["-c", `gpg.program=${program}`]
  const saved = { updates: { requireSigned: true } }
  assert.equal(requireSigned(saved), true)
  assert.equal(requireSigned({}), false)

  await publish("Unsigned")
  const before = git(home, "rev-parse", "HEAD")
  await assert.rejects(update({ home, saved, explicit: true, stream: sink() }), /refused: .*not signed/)
  assert.equal(git(home, "rev-parse", "HEAD"), before, "nothing moved")
  const quietly = sink()
  assert.equal(await update({ home, saved, stream: quietly }), undefined)
  assert.match(quietly.text, /refused/)

  await writeFile(join(upstream, "README.md"), "Signed\n")
  git(upstream, ...sign, "commit", "--quiet", "-am", "Signed", "-S", "--gpg-sign=KEYLABEL")
  git(upstream, "push", "--quiet")
  assert.match(await update({ home, saved, explicit: true, stream: sink() }), /\(2 commits\)$/)
  assert.equal(await readFile(join(home, "README.md"), "utf8"), "Signed\n")

  // A signed annotated tag on an unsigned commit also qualifies.
  await publish("Tagged")
  git(upstream, ...sign, "-c", "user.signingkey=KEYLABEL", "tag", "-s", "-m", "release", "v1")
  git(upstream, "push", "--quiet", "origin", "v1")
  assert.match(await update({ home, saved, explicit: true, stream: sink() }), /\(1 commit\)$/)
  assert.equal(await verifyTarget(home, "HEAD"), "signed tag v1")
})
