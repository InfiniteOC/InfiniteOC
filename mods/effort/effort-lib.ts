// The "auto" effort and the low-effort guidance contract. Pure (no imports): written to
// packages/core/src/infiniteoc/effort-lib.ts by mods/effort, where the model catalog adds "auto",
// the session context resolves it per prompt and the server plugin picks the matching guidance tier;
// also loaded directly by node tests.

export const AUTO = "auto"
export const INFINICODE = "infinicode"

// "auto" is a selection, not an effort; InfiniCode is mods/infinicode's own strongest-effort mode.
const META = new Set([AUTO, INFINICODE])

export type Tier = "low" | "medium" | "high" | "max"

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
const TARGET: Readonly<Record<Tier, number>> = { low: 2, medium: 3, high: 4, max: 5 }
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
export function chooseEffort(ids: readonly string[], input: string | TurnSignals | undefined): string | undefined {
  return variantFor(ids, autoTier(input))
}

/** The model's variant for a tier (see chooseEffort). */
export function variantFor(ids: readonly string[], tier: Tier): string | undefined {
  const choices = effortChoices(ids)
  if (choices.length === 0) return undefined
  if (choices.length === 1) return choices[0]
  const named = choices.find((id) => id.toLowerCase() === tier)
  if (named) return named
  const toggle = choices.every((id) => OFF.has(id.toLowerCase()) || ON.has(id.toLowerCase()))
  if (toggle) {
    const off = choices.find((id) => OFF.has(id.toLowerCase()))
    const on = choices.find((id) => ON.has(id.toLowerCase()))
    return tier === "low" ? (off ?? on) : (on ?? off)
  }
  if (!choices.every((id) => RANK[id.toLowerCase()] !== undefined)) {
    const index = tier === "low" ? 0 : tier === "medium" ? Math.floor((choices.length - 1) / 2) : choices.length - 1
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

// What the newest turn looks like, from the session at the moment the turn starts. Everything here is
// fixed for the whole turn, so "auto" picks one effort per turn and never flips (and re-caches) mid-turn.
export type TurnSignals = {
  /** The newest user message. */
  readonly text: string | undefined
  /** Its attachments, by MIME type. */
  readonly attachments?: readonly string[]
  /** The user message before it. */
  readonly previousText?: string
  /** The concrete effort the previous turn ran at (the last assistant message's variant). */
  readonly previousVariant?: string
  /** Failed tool calls and assistant errors in the previous turn. */
  readonly previousFailures?: number
  /** The agent the session runs. */
  readonly agent?: string
  /** A subagent session: its prompt is a brief the parent already thought through. */
  readonly subagent?: boolean
}

type UserLike = { readonly type: string; readonly text?: string; readonly files?: ReadonlyArray<{ readonly mime: string }> }
type AssistantLike = {
  readonly type: string
  readonly model?: { readonly variant?: string }
  readonly error?: unknown
  readonly content?: ReadonlyArray<{ readonly type: string; readonly state?: { readonly status?: string } }>
}

/** The signals of the newest turn from the stored messages (newest user, the one before it, the assistant messages between). */
export function turnSignals(
  latest: UserLike,
  previous: UserLike | undefined,
  between: ReadonlyArray<AssistantLike>,
  session: { readonly agent?: string; readonly parentID?: string } = {},
): TurnSignals {
  const assistants = between.filter((message) => message.type === "assistant")
  const failures = assistants.reduce(
    (sum, message) =>
      sum + (message.error ? 1 : 0) + (message.content ?? []).filter((part) => part.type === "tool" && part.state?.status === "error").length,
    0,
  )
  return {
    text: latest.text,
    attachments: (latest.files ?? []).map((file) => file.mime),
    previousText: previous?.text,
    previousVariant: assistants.at(-1)?.model?.variant,
    previousFailures: failures,
    agent: session.agent,
    subagent: session.parentID !== undefined,
  }
}

export type AutoDecision = { readonly tier: Tier; readonly score: number; readonly reasons: readonly string[] }

// Strong signals that the prompt is real work rather than a lookup or a small edit.
const HARD = /\b(?:debug|debugging|investigate|root cause|regress(?:ion|ed|es|ing)?|why (?:is|are|does|did|do|isn'?t|doesn'?t|won'?t)|design|architect|architecture|refactor|research|analy[sz]e|analysis|review|audit|migrate|migration|optimi[sz]e|benchmark|profil[ei]ng|security|vulnerab\w*|race condition|deadlock|memory leak|performance|rewrite|spec out|strategy|concurren\w*|from scratch|end[- ]to[- ]end|algorithm|proof|prove)\b/gi
// Thanks and greetings end the work; they never need thinking.
const SOCIAL = /^(?:hi|hey|hello|thanks|thank you|thx|ty|cool|nice|great|awesome|perfect|good job|nice work|well done)[!.?, ]*$/i
// A go-ahead continues the previous turn's work, so it keeps that turn's effort.
const FOLLOW_UP = /^(?:y|yes|yep|yeah|sure|ok|okay|k|go|go on|go ahead|continue|proceed|do it|next|carry on|keep going|sounds good|lgtm|ship it|approved?|please do|yes please|confirm(?:ed)?|done|try again|retry|again)[!.?, ]*$/i
// Small verbs: the request is a lookup or a one-line change unless a hard signal says otherwise.
const SMALL = /^(?:what|who|where|when|which|is|are|can|could|show|list|print|read|open|explain|summar\w*|fix|typo|rename|tidy|format|bump|update|clear|delete|remove|move|change|set|tweak|run)\b/i
// The user saying how hard to think wins over everything the text merely suggests.
const QUICK = /\b(?:quick(?:ly)?|briefly|short answer|tl;?dr|one[- ]liner|no need to (?:think|explain)|don'?t overthink|simple question|just (?:tell|show|give|list|run|do))\b/i
const DEEP = /\b(?:think (?:hard|carefully|deeply|it through)|carefully|thorough(?:ly)?|in[- ]depth|deep[- ]dive|step[- ]by[- ]step|rigorous(?:ly)?|exhaustive(?:ly)?|edge cases?|make sure|double[- ]check)\b/i
const MAX = /\b(?:ultrathink|think (?:harder|really hard|as hard as \w+|longer)|max(?:imum)? effort|as hard as (?:you|possible))\b/i
// The last attempt did not land: the same effort is likely to miss again.
const FRUSTRATED = /\b(?:still (?:not|broken|fail\w*|wrong|doesn'?t|don'?t|isn'?t|crash\w*|the same|getting)|(?:doesn'?t|didn'?t|isn'?t|not|won'?t) work(?:ing|s)?|same (?:error|issue|problem|bug|thing)|you broke|broke it|regressed|nothing changed|no change|that'?s wrong|not fixed|wrong again)\b/i
const TRACE = /\bat [\w.$<>]+ ?\(|Traceback|\b\w*Error:|\bException\b|panic:|stack trace|SIGSEGV|segfault|core dumped|exit code [1-9]/
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+\S/
const PATH = /(?:^|[\s`'"(])(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|lua|sql|json|ya?ml|toml|md|css|scss|html|vue|svelte|sh)\b/g

const RANKED: readonly Tier[] = ["low", "medium", "high", "max"]
// The lowest score of each tier.
const LOWEST: Readonly<Record<Tier, number>> = { low: -Infinity, medium: 1, high: 3, max: 10 }
const step = (tier: Tier, by: number): Tier => RANKED[Math.max(0, Math.min(RANKED.length - 1, RANKED.indexOf(tier) + by))]!
const atLeast = (a: Tier, b: Tier): Tier => (RANKED.indexOf(a) >= RANKED.indexOf(b) ? a : b)

/** The tier a concrete variant ran at; undefined for ids without a known rank. */
export function variantTier(variant: string | undefined): Tier | undefined {
  const rank = variant === undefined ? undefined : RANK[variant.toLowerCase()]
  if (rank === undefined) return undefined
  return rank <= 2 ? "low" : rank === 3 ? "medium" : rank === 4 ? "high" : "max"
}

/**
 * How much thinking the turn needs, with the reasons. Scored, not first-match: every signal adds or
 * removes weight, then explicit user cues and the previous turn set floors. Max is only reached on
 * an explicit ask or a pile-up of hard signals.
 */
export function autoDecision(input: string | TurnSignals | undefined): AutoDecision {
  const signals: TurnSignals = typeof input === "object" && input !== null ? input : { text: input }
  const decision = decide(signals)
  // A subagent's prompt is a detailed brief (lists, paths, "thorough"), not a sign of a hard problem.
  if (signals.subagent && decision.tier === "max") return { ...decision, tier: "high", reasons: [...decision.reasons, "subagent: at most high"] }
  return decision
}

function decide(signals: TurnSignals): AutoDecision {
  // Quotes or backticks around the whole prompt (pasted or passed through a shell) are not part of the ask.
  const text = (signals.text ?? "").trim().replace(/^(["'`])([\s\S]*)\1$/, "$2").trim()
  const previous = variantTier(signals.previousVariant) ?? (signals.previousText ? autoDecision(signals.previousText).tier : undefined)
  if (text.length === 0) return { tier: previous ?? "medium", score: 1, reasons: [previous ? "empty: keeps the previous turn's effort" : "empty"] }
  if (MAX.test(text)) return { tier: "max", score: 10, reasons: ["asked for maximum effort"] }
  if (SOCIAL.test(text)) return { tier: "low", score: 0, reasons: ["greeting or thanks"] }
  const failures = signals.previousFailures ?? 0
  if (FOLLOW_UP.test(text)) {
    const kept = previous ?? "medium"
    // "again" after a failing turn is a retry that already missed once.
    const retried = failures >= 2 ? step(kept, 1) : kept
    const tier = retried === "max" && kept !== "max" ? "high" : retried
    return { tier, score: 1, reasons: [previous ? `go-ahead: keeps the previous turn's ${previous}` : "go-ahead"] }
  }
  const reasons: string[] = []
  let score = 1
  const add = (weight: number, reason: string) => {
    score += weight
    reasons.push(`${weight > 0 ? "+" : ""}${weight} ${reason}`)
  }
  const hard = new Set((text.match(HARD) ?? []).map((word) => word.toLowerCase()))
  if (hard.size > 0) add(hard.size >= 3 ? 3 : 2, `hard work (${[...hard].slice(0, 3).join(", ")})`)
  if (TRACE.test(text)) add(3, "error or stack trace")
  else if (text.includes("```")) add(2, "code block")
  if (text.length > 1500) add(2, "long prompt")
  else if (text.length > 600) add(1, "longish prompt")
  const lines = text.split("\n")
  const items = lines.filter((line) => LIST_ITEM.test(line)).length
  if (items >= 3) add(2, `${items} separate items`)
  else if (lines.length >= 6) add(1, `${lines.length} lines`)
  if ((text.match(/\?/g) ?? []).length >= 3) add(1, "several questions")
  if (new Set(text.match(PATH) ?? []).size >= 3) add(1, "several files")
  const attachments = signals.attachments ?? []
  if (attachments.some((mime) => mime.startsWith("image/"))) add(1, "screenshot or image")
  if (attachments.length >= 3) add(1, `${attachments.length} attachments`)
  if (failures >= 5) add(2, `${failures} failures last turn`)
  else if (failures >= 2) add(1, `${failures} failures last turn`)
  if (signals.agent === "plan") add(1, "plan agent")
  const deep = DEEP.test(text)
  if (hard.size === 0 && !deep && text.length <= 160 && SMALL.test(text)) add(-2, "lookup or small edit")
  if (QUICK.test(text)) add(-2, "asked for a quick answer")
  if (deep) add(3, "asked for care")
  let tier: Tier = score <= 0 ? "low" : score <= 2 ? "medium" : score <= 9 ? "high" : "max"
  // Sticky downward: a score one point under the previous turn's tier keeps that tier. Each switch can
  // cost the provider's prompt cache, and a borderline turn in the middle of real work is still real work.
  if (previous && RANKED.indexOf(previous) === RANKED.indexOf(tier) + 1 && score === LOWEST[previous] - 1) {
    tier = previous
    reasons.push(`borderline: keeps the previous turn's ${previous}`)
  }
  if (FRUSTRATED.test(text)) {
    // A complaint about the last attempt is never handled with less thought than that attempt had,
    // and gets one step more (up to high; max only when the last attempt already ran at max).
    const bumped = step(previous ?? "medium", 1)
    const floor = previous === "max" ? "max" : bumped === "max" ? "high" : bumped
    tier = atLeast(tier, floor)
    reasons.push(`previous attempt missed: at least ${tier}`)
  }
  return { tier, score, reasons }
}

/** How much thinking the prompt looks like it needs: low (lookup/small edit) to max (explicit ask or pile-up). */
export function autoTier(input: string | TurnSignals | undefined): Tier {
  return autoDecision(input).tier
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

/**
 * The same contract for a turn that "auto" judged simple, sent as a note after the conversation instead
 * of replacing the system blocks: auto can change tier every turn, and a changed system prompt makes the
 * provider re-read the whole conversation uncached. A trailing note only touches the uncached tail.
 */
export const lowEffortTurnNote = (reasons: readonly string[]) => `[Low effort for this turn]
Auto effort judged this turn simple${reasons.length ? ` (${reasons.join("; ")})` : ""}. For this turn only, it overrides the depth instructions above (deliberation, plans, subagents and workflows, full quality-tool batteries): answer or make the change directly, smallest working change at the root cause, one cheap targeted check, and a 1-3 sentence reply saying what you did and did not check. Safety rules, permissions and approvals still apply. If the request clearly needs deeper work, say so in one short line and take the first concrete step.`

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
