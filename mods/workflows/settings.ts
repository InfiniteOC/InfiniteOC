// InfiniteOC workflows: the `workflows` section of the InfiniteOC settings file, with defaults.
// Pure (no imports): used by the core plugin, the TUI and node tests alike.
// Written to packages/core/src/plugin/infiniteoc-wf-settings.ts and
// packages/tui/src/infiniteoc-features/workflows-settings.ts by mods/workflows.

export type Tier = "fast" | "strong" | "default"
export const CLAUDE_MODES = ["readonly", "auto", "bypass"] as const
export type ClaudeMode = (typeof CLAUDE_MODES)[number]
export const TIERS: readonly Tier[] = ["fast", "strong", "default"]
export const KINDS = ["search", "summarize", "plan", "review", "reason", "implement", "test", "other"] as const
export type Kind = (typeof KINDS)[number]

export type Settings = {
  /** The contract flag: when false the model sees no workflow tools and the tool refuses to start. */
  enabled: boolean
  /** Fleet mode: the primary agent delegates nearly all work through many parallel workflow steps, told to finish fast, never on Claude Code. */
  fleet: boolean
  /** Steps of one workflow that may run at the same time. */
  maxParallel: number
  /** Claude Code worker processes running at once, across all workflows (each is a ~300 MB process). */
  claudeParallel: number
  /**
   * What Claude Code workers may do: "readonly" (search, read, web), "auto" (everything, Claude Code's
   * classifier blocks risky actions) or "bypass" (everything, no checks).
   */
  claudeMode: ClaudeMode
  /** Steps per workflow, after `each` fan-outs are expanded. */
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
  maxParallel: 16,
  fleet: false,
  claudeParallel: 4,
  claudeMode: "readonly",
  maxSteps: 500,
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

/**
 * Free OpenCode models with separate capacity: the scheduler spreads steps over them and learns which is
 * fastest right now. Measured on 34 real per-file steps: glm-5.3-flash-free 24 s with no errors,
 * mimo-v2.6-flash-free 29 s, deepseek-v4.1-flash-free 3 s to 101 s depending on load (503s when busy).
 * nemotron-3.5-lightning-free is fast on tiny prompts but slow and failing on real ones, so it is left out.
 */
export const FREE_POOL = "opencode/glm-5.3-flash-free, opencode/deepseek-v4.1-flash-free, opencode/mimo-v2.6-flash-free"

/** Tier model sets `/fleet preset <name>` (or applyChange("preset", name)) writes in one go. */
export const PRESETS: Record<string, { fast: string; strong: string; default: string; label: string }> = {
  "free-cc": {
    fast: FREE_POOL,
    strong: "claude-code/opus",
    default: "claude-code/sonnet",
    label: "free DeepSeek for search, Claude Code for planning and review",
  },
  free: { fast: FREE_POOL, strong: "auto", default: "inherit", label: "free GLM, DeepSeek and MiMo for search, the rest automatic" },
  cc: { fast: "claude-code/haiku", strong: "claude-code/opus", default: "claude-code/sonnet", label: "every read-only step on Claude Code" },
  // Measured fastest: 34 per-file steps in 11.3 s (Claude Code haiku alone 15.9 s, the free pool 23-67 s).
  // Without the claude CLI the pool is just the free models.
  turbo: {
    fast: `claude-code/haiku, ${FREE_POOL}`,
    strong: "claude-code/opus",
    default: "inherit",
    label: "fan-outs over Claude Code haiku plus the free models, whichever is fastest right now",
  },
  auto: { fast: "auto", strong: "auto", default: "inherit", label: "the built-in automatic choice" },
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const int = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback

const MODEL = /^[^/\s#,]+\/[^\s#,]+(#[^\s#,]+)?$/
/** "auto", "inherit", a "provider/model[#variant]" reference, or a pool of references separated by commas. */
export const validModelSetting = (value: unknown, allowAuto = true): value is string =>
  typeof value === "string" &&
  ((allowAuto && value === "auto") ||
    value === "inherit" ||
    MODEL.test(value) ||
    (value.includes(",") && value.split(",").every((part) => MODEL.test(part.trim()))))

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
    fleet: input.fleet === true,
    maxParallel: int(input.maxParallel, DEFAULTS.maxParallel, 1, 64),
    claudeParallel: int(input.claudeParallel, DEFAULTS.claudeParallel, 1, 16),
    claudeMode: CLAUDE_MODES.includes(input.claudeMode as ClaudeMode) ? (input.claudeMode as ClaudeMode) : DEFAULTS.claudeMode,
    maxSteps: int(input.maxSteps, DEFAULTS.maxSteps, 1, 1000),
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
 * One settings change as the UIs offer it: enabled, fleet (on also enables workflows at full parallelism), maxParallel, notify, models.fast,
 * models.strong, models.default, preset, claudeMode, claudeParallel. Returns the next raw `workflows` object (other keys kept)
 * or an error message for the dialog.
 */
export function applyChange(raw: unknown, key: string, value: string): { next: Record<string, unknown> } | { error: string } {
  const current = record(raw) ? { ...raw } : {}
  const text = value.trim()
  if (key === "enabled") {
    if (!["on", "off", "true", "false"].includes(text)) return { error: "Use on or off" }
    return { next: { ...current, enabled: text === "on" || text === "true" } }
  }
  if (key === "fleet") {
    if (!["on", "off", "true", "false"].includes(text)) return { error: "Use on or off" }
    const on = text === "on" || text === "true"
    // Fleet mode is about throughput: as many steps at once as allowed; learned per-model limits still back off.
    return { next: { ...current, fleet: on, ...(on ? { enabled: true, maxParallel: 64 } : {}) } }
  }
  if (key === "maxParallel") {
    const n = Number(text)
    if (!Number.isInteger(n) || n < 1 || n > 64) return { error: "Parallel steps must be 1–64" }
    return { next: { ...current, maxParallel: n } }
  }
  if (key === "claudeParallel") {
    const n = Number(text)
    if (!Number.isInteger(n) || n < 1 || n > 16) return { error: "Claude Code workers must be 1–16 (each is a ~300 MB process)" }
    return { next: { ...current, claudeParallel: n } }
  }
  if (key === "claudeMode") {
    if (!CLAUDE_MODES.includes(text as ClaudeMode)) return { error: `Use ${CLAUDE_MODES.join(", ")}` }
    return { next: { ...current, claudeMode: text } }
  }
  if (key === "notify") {
    if (text !== "end" && text !== "each") return { error: "Use end or each" }
    return { next: { ...current, notify: text } }
  }
  if (key === "preset") {
    const preset = PRESETS[text]
    if (!preset) return { error: `Unknown preset: use ${Object.keys(PRESETS).join(", ")}` }
    const models = record(current.models) ? current.models : {}
    return { next: { ...current, models: { ...models, fast: preset.fast, strong: preset.strong, default: preset.default } } }
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
  `${settings.enabled ? (settings.fleet ? "fleet" : "on") : "off"} · fast ${settings.models.fast} · strong ${settings.models.strong} · ${settings.maxParallel} parallel`
