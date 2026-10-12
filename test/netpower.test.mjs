import test from "node:test"
import assert from "node:assert/strict"
import { isOffline, onBattery } from "../src/netpower.mjs"

test("environment overrides decide offline and battery without probing", () => {
  assert.equal(isOffline({ INFINITEOC_OFFLINE: "1" }), true)
  assert.equal(isOffline({ INFINITEOC_OFFLINE: "0" }), false)
  assert.equal(onBattery("darwin", { INFINITEOC_BATTERY: "1" }), true)
  assert.equal(onBattery("darwin", { INFINITEOC_BATTERY: "0" }), false)
  // pmset is macOS only.
  assert.equal(onBattery("linux", {}), false)
})

import { mkdtemp, rm, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { update } from "../src/updater.mjs"

test("the launch-time update check is skipped offline and on battery, and runs otherwise", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "infiniteoc-netpower-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const state = join(home, ".runtime", "update.json")
  const saved = process.env
  t.after(() => { process.env = saved })
  for (const env of [{ INFINITEOC_OFFLINE: "1", INFINITEOC_BATTERY: "0" }, { INFINITEOC_OFFLINE: "0", INFINITEOC_BATTERY: "1" }]) {
    process.env = { ...saved, ...env }
    assert.equal(await update({ home, saved: {}, motion: false }), undefined)
    await assert.rejects(access(state), "no check, so no state file")
  }
  // Online on AC the check runs; this directory is not a git checkout, so it records the check and returns.
  process.env = { ...saved, INFINITEOC_OFFLINE: "0", INFINITEOC_BATTERY: "0" }
  assert.equal(await update({ home, saved: {}, motion: false }), undefined)
  await access(state)
})
