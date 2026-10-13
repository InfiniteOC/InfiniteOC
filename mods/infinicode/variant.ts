// InfiniCode effort: one extra variant on every model, a copy of the model's strongest native
// variant (or no overlay at all when the model has no effort controls, so its defaults apply).
// Pure (no imports): written to packages/core/src/infiniteoc/infinicode-variant.ts, where the model
// catalog adds it, and to packages/tui/src/infiniteoc-features/infinicode-variant.ts by
// mods/infinicode, and loaded directly by node tests.

export const INFINICODE = "infinicode"

// Upstream variant ids (packages/core/src/variant.ts): efforts none < minimal < low < medium < high
// < xhigh < max, the "none"/"thinking" toggle, and "high"/"max" thinking budgets.
const RANK: Readonly<Record<string, number>> = {
  none: 0,
  off: 0,
  disabled: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  thinking: 3,
  enabled: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}
// Overlay fields that carry an effort level or a thinking budget across upstream's protocols.
const EFFORT_KEYS = new Set(["effort", "reasoningEffort", "reasoning_effort", "thinkingLevel", "maxReasoningEffort"])
const BUDGET_KEYS = new Set(["budgetTokens", "budget_tokens", "thinkingBudget", "tokenBudget", "token_budget", "reasoning_budget", "max_tokens"])

export type VariantLike = {
  readonly id: string
  readonly settings?: unknown
  readonly headers?: unknown
  readonly body?: unknown
}

/**
 * [effort rank, thinking budget] of a variant: the higher of its id's rank and the effort values in
 * its overlays (-1 when neither is known), and its largest thinking budget (-1, "dynamic", counts as
 * unlimited). Custom variants from config are ranked by what they send, not by their name.
 */
export function strength(variant: VariantLike): [number, number] {
  let rank = RANK[variant.id.toLowerCase()] ?? -1
  let budget = 0
  const visit = (value: unknown, key?: string) => {
    if (typeof value === "string" && key && EFFORT_KEYS.has(key)) rank = Math.max(rank, RANK[value.toLowerCase()] ?? -1)
    else if (typeof value === "number" && key && BUDGET_KEYS.has(key)) budget = Math.max(budget, value < 0 ? Infinity : value)
    else if (value !== null && typeof value === "object") for (const [name, item] of Object.entries(value)) visit(item, name)
  }
  visit(variant.settings)
  visit(variant.body)
  return [rank, budget]
}

/** The model's strongest native variant; on a tie the later one (upstream lists efforts ascending). */
export function strongestVariant<V extends VariantLike>(variants: readonly V[]): V | undefined {
  let best: { variant: V; score: [number, number] } | undefined
  for (const variant of variants) {
    if (variant.id === INFINICODE) continue
    const score = strength(variant)
    if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] >= best.score[1])) best = { variant, score }
  }
  return best?.variant
}

/** The model's variants plus InfiniCode, last so the variant cycle reaches it after max. A configured "infinicode" variant wins. */
export function withInfinicode<V extends VariantLike>(variants: readonly V[]): readonly V[] {
  if (variants.some((variant) => variant.id === INFINICODE)) return variants
  const strongest = strongestVariant(variants)
  const overlay = strongest ? { settings: strongest.settings, headers: strongest.headers, body: strongest.body } : {}
  const infinicode = Object.fromEntries(Object.entries({ id: INFINICODE, ...overlay }).filter(([, value]) => value !== undefined))
  return [...variants, infinicode as unknown as V]
}
