import { readFile } from "node:fs/promises"
import { onBattery } from "../../src/netpower.mjs"

// Mod order: after mods/infiniteoc, whose goal plugin, guidance marker and animations default are patched here.
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`prov-kit: expected one source anchor: ${before}`)
  return source.replace(before, () => after)
}

export const guidance = `[Local environment]
Ports: never assume free. free_port {} for every server/listener → PORT/--port + URL. Keep-alive via /serve; one-off background+stop.
Env: env_diff names only; never read/print .env values.
Spending: /budget limit; on refusal stop, don't work around.`

const marker = "// infiniteoc:guidance-extensions"
const read = (name) => readFile(new URL(name, import.meta.url), "utf8")

export default {
  id: "prov-kit",
  version: "1.0.0",
  async setup(api) {
    const lib = await read("./lib.ts")
    await api.write("packages/core/src/plugin/infiniteoc-prov-lib.ts", lib)
    await api.write("packages/core/src/plugin/infiniteoc-prov.ts", await read("./plugin.ts"))
    // Before /goal so a budget stop is posted before the goal loop decides to continue.
    await api.patch("packages/core/src/plugin/internal.ts", (source) => {
      source = replace(source, 'import * as InfiniteocGoal from "./infiniteoc-goal.js"', 'import * as InfiniteocProv from "./infiniteoc-prov.js"\nimport * as InfiniteocGoal from "./infiniteoc-goal.js"')
      return replace(source, "  InfiniteocGoal.Plugin,\n", "  InfiniteocProv.Plugin,\n  InfiniteocGoal.Plugin,\n")
    })
    await api.patch("packages/core/src/infiniteoc/guidance.ts", (source) =>
      replace(source, marker, `infiniteocGuidance.build.push(${JSON.stringify(guidance)})\n${marker}`))
    // Every tool's object schema lists `required`, even when empty: strict OpenAI-compatible proxies
    // (agentrouter) reject the whole request otherwise ("Invalid schema for function 'free_port': null
    // is not of type array"), which made such providers unusable for any agent with an all-optional tool.
    await api.patch("packages/core/src/tool/runtime.ts", (source) =>
      replace(
        source,
        "const inputJsonSchema = (schema: Tool.ValueSchema<any>): JsonSchema.JsonSchema => {\n  if (schema === undefined || schema === null) return {}\n",
        "const inputJsonSchema = (schema: Tool.ValueSchema<any>): JsonSchema.JsonSchema => {\n  const json = inputJsonSchemaOf(schema) as Record<string, unknown>\n  return (json.type === \"object\" && !Array.isArray(json.required) ? { ...json, required: [] } : json) as JsonSchema.JsonSchema\n}\n\nconst inputJsonSchemaOf = (schema: Tool.ValueSchema<any>): JsonSchema.JsonSchema => {\n  if (schema === undefined || schema === null) return {}\n",
      ))
    // Battery saver: the launcher sets INFINITEOC_BATTERY=1 on battery; animations then default to off
    // unless the user's own config says otherwise.
    await api.patch("packages/tui/src/config/index.tsx", (source) =>
      replace(source, "    animations: input.animations ?? ", '    animations: input.animations ?? (process.env.INFINITEOC_BATTERY === "1" ? false : undefined) ?? '))
    await api.write("packages/tui/src/infiniteoc-features/prov-lib.ts", lib)
    for (const [id, title, slash, category, file] of [
      ["usage", "Spend by day, project and provider", "usage", "Providers", "usage.tsx"],
      ["serve", "Dev servers: start, list, logs, stop", "serve", "Providers", "serve.tsx"],
      ["local", "Set up Ollama or LM Studio as a provider", "local", "Providers", "local.tsx"],
      ["envdiff", "Compare .env.example with .env (names only)", "envdiff", "Providers", "envdiff.tsx"],
    ]) api.tui.command({ id, title, slash, category, source: await read(`./tui/${file}`) })
    api.on("beforeLaunch", (context) => {
      if (onBattery()) context.env.INFINITEOC_BATTERY = "1"
    })
  },
}
