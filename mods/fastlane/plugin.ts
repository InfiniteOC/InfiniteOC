// Written to packages/core/src/plugin/infiniteoc-fastlane.ts by mods/fastlane.
// Installs the fetch wrapper once per server process and exposes `warm` for UIs (InfiniTUI calls it
// when the user starts typing, so the request goes out on a connection that is already open).
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createFastlane } from "../infiniteoc/fastlane.js"

// Container and VM bridges come and go without touching the route to the internet.
const VIRTUAL = /^(lo|veth|docker|br-|virbr|vnet|cni|flannel|kube|vmnet|vboxnet|podman)/

function signature() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !VIRTUAL.test(name))
    .flatMap(([name, addresses]) => (addresses ?? []).filter((a) => !a.internal).map((a) => `${name}=${a.address}`))
    .sort()
    .join(",")
}

const stateFile = () =>
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode", "infiniteoc", "fastlane.json")

function load(): Record<string, number> {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(), "utf8"))
    return value && typeof value.origins === "object" ? value.origins : {}
  } catch {
    return {}
  }
}

function save(origins: Record<string, number>) {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
    fs.writeFileSync(stateFile(), JSON.stringify({ origins }, null, 2))
  } catch {}
}

function tracer() {
  const file = process.env.INFINITEOC_NET_TRACE
  if (!file) return undefined
  return (entry: Record<string, unknown>) => {
    try {
      fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...entry }) + "\n")
    } catch {}
  }
}

type Lane = ReturnType<typeof createFastlane>
const KEY = Symbol.for("infiniteoc.fastlane")

export function install(): Lane | undefined {
  const holder = globalThis as unknown as Record<symbol, Lane | undefined>
  if (holder[KEY] || process.env.INFINITEOC_FASTLANE === "0") return holder[KEY]
  const original = globalThis.fetch
  const lane = createFastlane({ fetch: original.bind(globalThis), signature, load, save, trace: tracer() })
  // Keep Bun's fetch extras (preconnect) reachable on the wrapper.
  globalThis.fetch = Object.assign(lane.fetch, original)
  holder[KEY] = lane
  setTimeout(() => lane.warm("start"), 300).unref?.()
  return lane
}

const contract = {
  id: "fastlane",
  methods: {
    warm: { input: { type: "string" }, output: { type: "string" } },
    reconnect: { input: { type: "string" }, output: { type: "string" } },
  },
  events: {},
} as const

export const Plugin = define({
  id: "infiniteoc.fastlane",
  effect: Effect.fn(function* (ctx) {
    const lane = install()
    yield* ctx.rpc
      .register(contract, {
        warm: () => Effect.sync(() => JSON.stringify(lane ? lane.warm("typing") : [])),
        // Treat the network as changed now: resend stuck requests, purge pooled sockets, rewarm.
        reconnect: () =>
          Effect.sync(() => {
            lane?.onChange("requested")
            return JSON.stringify(lane ? lane.state() : {})
          }),
      })
      .pipe(Effect.orDie)
  }),
})
