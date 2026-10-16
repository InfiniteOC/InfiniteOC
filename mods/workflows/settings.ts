// InfiniteOC workflows: the `workflows` section of the InfiniteOC settings file, with defaults.
// Pure (no imports): used by the core plugin, the TUI and node tests alike.
// Written to packages/core/src/plugin/infiniteoc-wf-settings.ts and
// packages/tui/src/infiniteoc-features/workflows-settings.ts by mods/workflows.

export type Tier = "fast" | "strong" | "default"
export const TIERS: readonly Tier[] = ["fast", "strong", "default"]
export const KINDS = ["search", "summarize", "plan", "review", "reason", "implement", "test", "other"] as const
export type Kind = (typeof KINDS)[number]

export type Settings = {
  /** The contract flag: when false the model sees no workflow tools and the tool refuses to start. */
  enabled: boolean
  /** Steps of one workflow that may run at the same time. */
  maxParallel: number
  /** Steps per workflow. */
  maxSteps: number
  /** Characters of a step's result passed to dependent steps and the final notification. */
  maxOutputChars: number
  /** "end": one notification when the workflow finishes; "each": also a short note per finished step. */
  notify: "end" | "each"
  models: {
    /** "auto" (the provider's small model), "inherit" (the caller's model) or "provider/model[#variant]". */
    fast: string
    /** "auto" (the strongest model of the caller's provider within strongMaxCostRatio), "inherit" or a model. */
    strong: string
    /** "inherit" or a model. */
    default: string
    /** "auto" for strong never picks a model whose output price exceeds this multiple of the caller's. */
    strongMaxCostRatio: number
  }
  /** Tier per subagent ID; wins over keyword inference. */
  agents: Record<string, Tier>
  /** Tier per step kind (explicit or inferred from the step's title and prompt). */
  kinds: Record<Kind, Tier>
}

export const DEFAULTS: Settings = Object.freeze({
  enabled: false,
  maxParallel: 5,
  maxSteps: 12,
  maxOutputChars: 12000,
  notify: "end",
  models: { fast: "auto", strong: "auto", default: "inherit", strongMaxCostRatio: 4 },
  agents: { explore: "fast", researcher: "fast", reviewer: "strong" },
  kinds: {
    search: "fast",
    summarize: "fast",
    plan: "strong",
    review: "strong",
    reason: "strong",
    implement: "default",
    test: "default",
    other: "default",
  },
}) as Settings

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const int = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback

const MODEL = /^[^/\s#]+\/[^\s#]+(#[^\s#]+)?$/
/** "auto", "inherit" or a "provider/model[#variant]" reference. */
export const validModelSetting = (value: unknown, allowAuto = true): value is string =>
  typeof value === "string" && ((allowAuto && value === "auto") || value === "inherit" || MODEL.test(value))

/**
 * Settings with defaults; unknown or invalid values fall back field by field, so a bad edit never
 * disables the rest. `buildDefault` is the enabled default baked in at build time
 * (infiniteoc.json options.workflows.enabled); an explicit boolean in the file always wins.
 */
export function normalize(raw: unknown, buildDefault = DEFAULTS.enabled): Settings {
  const input = record(raw) ? raw : {}
  const models = record(input.models) ? input.models : {}
  const agents = record(input.agents) ? input.agents : {}
  const kinds = record(input.kinds) ? input.kinds : {}
  const tier = (value: unknown, fallback: Tier): Tier => (TIERS.includes(value as Tier) ? (value as Tier) : fallback)
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : buildDefault,
    maxParallel: int(input.maxParallel, DEFAULTS.maxParallel, 1, 8),
    maxSteps: int(input.maxSteps, DEFAULTS.maxSteps, 1, 32),
    maxOutputChars: int(input.maxOutputChars, DEFAULTS.maxOutputChars, 500, 100000),
    notify: input.notify === "each" ? "each" : "end",
    models: {
      fast: validModelSetting(models.fast) ? models.fast : DEFAULTS.models.fast,
      strong: validModelSetting(models.strong) ? models.strong : DEFAULTS.models.strong,
      default: validModelSetting(models.default, false) ? models.default : DEFAULTS.models.default,
      strongMaxCostRatio:
        typeof models.strongMaxCostRatio === "number" && models.strongMaxCostRatio >= 1 && models.strongMaxCostRatio <= 100
          ? models.strongMaxCostRatio
          : DEFAULTS.models.strongMaxCostRatio,
    },
    agents: {
      ...DEFAULTS.agents,
      ...Object.fromEntries(
        Object.entries(agents)
          .filter(([key, value]) => /^[\w.-]+$/.test(key) && TIERS.includes(value as Tier))
          .map(([key, value]) => [key, value as Tier]),
      ),
    },
    kinds: Object.fromEntries(KINDS.map((kind) => [kind, tier(kinds[kind], DEFAULTS.kinds[kind])])) as Record<Kind, Tier>,
  }
}

/**
 * One settings change as the UIs offer it: enabled, maxParallel, notify, models.fast,
 * models.strong, models.default. Returns the next raw `workflows` object (other keys kept)
 * or an error message for the dialog.
 */
export function applyChange(raw: unknown, key: string, value: string): { next: Record<string, unknown> } | { error: string } {
  const current = record(raw) ? { ...raw } : {}
  const text = value.trim()
  if (key === "enabled") {
    if (!["on", "off", "true", "false"].includes(text)) return { error: "Use on or off" }
    return { next: { ...current, enabled: text === "on" || text === "true" } }
  }
  if (key === "maxParallel") {
    const n = Number(text)
    if (!Number.isInteger(n) || n < 1 || n > 8) return { error: "Parallel steps must be 1–8" }
    return { next: { ...current, maxParallel: n } }
  }
  if (key === "notify") {
    if (text !== "end" && text !== "each") return { error: "Use end or each" }
    return { next: { ...current, notify: text } }
  }
  const tier = /^models\.(fast|strong|default)$/.exec(key)?.[1]
  if (tier) {
    if (!validModelSetting(text, tier !== "default"))
      return { error: tier === "default" ? "Use inherit or provider/model" : "Use auto, inherit or provider/model" }
    const models = record(current.models) ? current.models : {}
    return { next: { ...current, models: { ...models, [tier]: text } } }
  }
  return { error: `Unknown workflows setting: ${key}` }
}

/** One line for status surfaces. */
export const summary = (settings: Settings) =>
  `${settings.enabled ? "on" : "off"} · fast ${settings.models.fast} · strong ${settings.models.strong} · ${settings.maxParallel} parallel`
