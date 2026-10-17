// The "auto" effort and the low-effort guidance contract. Pure (no imports): written to
// packages/core/src/infiniteoc/effort-lib.ts by mods/effort, where the model catalog adds "auto",
// the session context resolves it per prompt and the server plugin picks the matching guidance tier;
// also loaded directly by node tests.

export const AUTO = "auto"
export const INFINICODE = "infinicode"

// "auto" is a selection, not an effort; InfiniCode is mods/infinicode's own strongest-effort mode.
const META = new Set([AUTO, INFINICODE])

export type Tier = "low" | "medium" | "high"

// Upstream variant ids (packages/core/src/variant.ts): efforts none < minimal < low < medium < high
// < xhigh < max, plus the "none"/"thinking" toggle and "high"/"max" thinking budgets.
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
const TARGET: Readonly<Record<Tier, number>> = { low: 2, medium: 3, high: 4 }
const OFF = new Set(["none", "off", "disabled"])
const ON = new Set(["thinking", "enabled"])

export type VariantLike = {
  readonly id: string
  readonly settings?: unknown
  readonly headers?: unknown
  readonly body?: unknown
}

/** Candidate effort ids: everything the model offers except the meta selections. */
export function effortChoices(ids: readonly string[]): string[] {
  return ids.filter((id) => !META.has(id))
}

/**
 * The model's variants plus "auto", so the catalog offers an effort InfiniCode picks per prompt.
 * A model without native effort controls has no choice to make, so it stays as it is. Composed
 * inside mods/infinicode's `withInfinicode(...)` this keeps its variant last.
 */
export function withAutoEffort<V extends VariantLike>(variants: readonly V[]): readonly V[] {
  if (variants.some((variant) => variant.id === AUTO)) return variants
  if (effortChoices(variants.map((variant) => variant.id)).length === 0) return variants
  return [...variants, { id: AUTO } as unknown as V]
}

/**
 * The variant "auto" resolves to for one prompt. An id named after the tier wins when the model
 * offers it; otherwise the closest rank, ties toward the cheaper variant. An on/off model is
 * treated as off for low and on for medium/high. Custom ids without a rank fall back to position.
 */
export function chooseEffort(ids: readonly string[], message: string | undefined): string | undefined {
  const choices = effortChoices(ids)
  if (choices.length === 0) return undefined
  if (choices.length === 1) return choices[0]
  const tier = autoTier(message)
  const named = choices.find((id) => id.toLowerCase() === tier)
  if (named) return named
  const toggle = choices.every((id) => OFF.has(id.toLowerCase()) || ON.has(id.toLowerCase()))
  if (toggle) {
    const off = choices.find((id) => OFF.has(id.toLowerCase()))
    const on = choices.find((id) => ON.has(id.toLowerCase()))
    return tier === "low" ? (off ?? on) : (on ?? off)
  }
  if (!choices.every((id) => RANK[id.toLowerCase()] !== undefined)) {
    const index = tier === "low" ? 0 : tier === "high" ? choices.length - 1 : Math.floor((choices.length - 1) / 2)
    return choices[index]
  }
  const target = TARGET[tier]
  let best = choices[0]!
  let distance = Infinity
  for (const id of choices) {
    const next = Math.abs((RANK[id.toLowerCase()] ?? 0) - target)
    if (next < distance) {
      best = id
      distance = next
    }
  }
  return best
}

// Strong signals that the prompt is real work rather than a lookup or a small edit.
const HARD = /\b(?:debug|debugging|investigate|root cause|regress(?:ion|ed|es|ing)?|why (?:is|are|does|did|do)|design|architect|architecture|refactor|research|analy[sz]e|analysis|review|audit|migrate|migration|optimi[sz]e|benchmark|profil[ei]ng|security|vulnerab\w*|race condition|deadlock|performance|rewrite|spec out|strategy)\b/i
const GREETING = /^(?:hi|hey|hello|thanks|thank you|ty|ok|okay|yes|no|yep|nope|cool|nice|done|continue|go on)[!.?,]*$/i
// Small verbs: the request is a lookup or a one-line change unless a hard signal says otherwise.
const SMALL = /^(?:what|who|where|when|which|is|are|can|could|show|list|print|read|open|explain|summar\w*|fix|typo|rename|tidy|format|bump|update|show|clear|delete|remove|move|change|set|tweak|run)\b/i

/** How much thinking the prompt looks like it needs: low (lookup/small edit), medium, high (real work). */
export function autoTier(message: string | undefined): Tier {
  const text = (message ?? "").trim()
  if (text.length === 0) return "medium"
  if (GREETING.test(text)) return "low"
  const lines = text.split("\n").length
  const questions = (text.match(/\?/g) ?? []).length
  const trace = /\bat [\w.$<>]+\(|Traceback|Error:|Exception|panic:|stack trace|SIGSEGV|segfault|core dumped/.test(text)
  if (text.length > 600 || text.includes("```") || trace) return "high"
  if (HARD.test(text)) return "high"
  if (lines >= 6 || questions >= 3) return "high"
  if (text.length <= 160 && SMALL.test(text)) return "low"
  return "medium"
}

/**
 * The harness guidance tier a variant runs at. Only "low" changes the guidance: the user asked for
 * speed, so the depth-oriented blocks are dropped and the workflow block becomes a lean contract.
 */
export function effortTier(variant: string | undefined): "low" | "standard" {
  if (variant === undefined) return "standard"
  const rank = RANK[variant.toLowerCase()]
  return rank !== undefined && rank <= 2 ? "low" : "standard"
}

export const LOW_EFFORT_GUIDANCE = `[InfiniteOC unified workflow — low effort]
You are running at low effort: the user traded depth for speed, so act instead of deliberating. Answer or make the change directly and keep the loop short — no plan, no option lists, no subagents or workflows, no extra files, no unrequested refactors; make the smallest working change at the root cause and reply. Verify cheaply with one targeted check you can run in seconds and say what you did and did not check; skip full suites and quality-tool batteries unless asked. Simple replies stay 1-3 sentences, with the facts, the uncertainty, and what would settle it. The safety rules, permissions and approvals below still apply. If the request clearly needs deeper work, say so in one short line and take the first concrete step.`

const WORKFLOW_PREFIX = "[InfiniteOC unified workflow"
const DROP_PREFIXES = ["[Deep deliberation]", "[Quality tools]"]

/**
 * Rebuild the guidance text at low effort: the main workflow block becomes the lean contract and
 * the depth-oriented blocks are removed. Other entries (safety, autonomy, tool awareness, project
 * and environment context) are kept byte-for-byte.
 */
export function rewriteLowEffort(text: string, entries: readonly string[]): string {
  let out = text
  for (const entry of entries) {
    if (entry.startsWith(WORKFLOW_PREFIX)) out = out.includes(LOW_EFFORT_GUIDANCE) ? out : out.replace(entry, () => LOW_EFFORT_GUIDANCE)
    else if (DROP_PREFIXES.some((prefix) => entry.startsWith(prefix))) out = out.replace(entry, () => "")
  }
  return out.replace(/\n{3,}/g, "\n\n")
}
