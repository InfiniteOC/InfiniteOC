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
