import { readFile } from "node:fs/promises"

const file = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")

// Inserted before an upstream line that stays intact, so other mods patching the plugin list still find it.
export function internalSource(source) {
  for (const [before, after] of [
    ['import { WarmingPlugin } from "./warming.js"', 'import * as InfiniteocFastlane from "./infiniteoc-fastlane.js"\nimport { WarmingPlugin } from "./warming.js"'],
    ["  WarmingPlugin.Plugin,\n", "  InfiniteocFastlane.Plugin,\n  WarmingPlugin.Plugin,\n"],
  ]) {
    if (source.includes(after)) throw new Error("fastlane: already applied (plugin list)")
    if (source.split(before).length !== 2) throw new Error(`fastlane: expected one source anchor: ${before}`)
    source = source.replace(before, () => after)
  }
  return source
}

// Effect's FetchHttpClient resolves globalThis.fetch once, before plugins load. Provider requests get a
// fetch that looks it up per call, so the wrapper installed by the plugin sees them.
export const platformPatch = [
  "packages/core/src/effect/app-node-platform.ts",
  "      Effect.provideService(FetchHttpClient.RequestInit, { timeout: false } as BunFetchRequestInit),\n",
  "      (effect) =>\n        effect.pipe(\n          Effect.provideService(FetchHttpClient.RequestInit, { timeout: false } as BunFetchRequestInit),\n          Effect.provideService(FetchHttpClient.Fetch, ((input, init) => globalThis.fetch(input, init)) as typeof fetch),\n        ),\n",
]

export default {
  id: "fastlane",
  version: "1.0.0",
  async setup(api) {
    await api.write("packages/core/src/infiniteoc/fastlane.ts", await file("fastlane.ts"))
    await api.write("packages/core/src/plugin/infiniteoc-fastlane.ts", await file("plugin.ts"))
    await api.patch("packages/core/src/plugin/internal.ts", internalSource)
    await api.patchExact(...platformPatch)
  },
}
