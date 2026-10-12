// Launcher-side checks that send no traffic: is any real network interface up, is a Mac on battery.
import { spawnSync } from "node:child_process"
import { networkInterfaces } from "node:os"

// ponytail: an interface with an address is "online"; a Wi-Fi network with no internet still counts as online.
export const isOffline = (env = process.env) => {
  if (env.INFINITEOC_OFFLINE === "1") return true
  if (env.INFINITEOC_OFFLINE === "0") return false
  return !Object.values(networkInterfaces()).some((list) => (list ?? []).some((item) => !item.internal && !/^(169\.254\.|fe80:)/i.test(item.address)))
}

export const onBattery = (platform = process.platform, env = process.env) => {
  if (env.INFINITEOC_BATTERY === "1") return true
  if (env.INFINITEOC_BATTERY === "0" || platform !== "darwin") return false
  const out = spawnSync("pmset", ["-g", "batt"], { encoding: "utf8", timeout: 2000 })
  return /drawing from 'Battery Power'/.test(out.stdout ?? "")
}
