// InfiniteOC workflows: automatic model choice per step. Pure (no imports): the core plugin passes
// the models the user actually has available (configured, enabled providers) and the caller's model.
// Written to packages/core/src/plugin/infiniteoc-wf-models.ts by mods/workflows.

export type Tier = "fast" | "strong" | "default"
export type Ref = { providerID: string; id: string; variant?: string }

/** The fields of an available model this module needs (from Model.Info). */
export type Candidate = {
  providerID: string
  id: string
  family?: string
  status: string
  released: number
  /** USD per million output tokens of the base (untiered) price; 0 when unknown. */
  outputCost: number
  tools: boolean
  text: boolean
  variants: string[]
}

export type Policy = {
  models: { fast: string; strong: string; default: string; strongMaxCostRatio: number }
  agents: Record<string, Tier>
  kinds: Record<string, Tier>
}

export type StepInput = { title: string; prompt: string; agent: string; kind?: string; model?: string }

export type Choice = {
  /** Undefined means the session default (no model could be determined). */
  ref?: Ref
  tier: Tier
  kind: string
  reason: string
}

const TIER_WORDS: Record<string, Tier> = { fast: "fast", cheap: "fast", strong: "strong", best: "strong", default: "default", inherit: "default" }

export function parseRef(input: string): Ref {
  const slash = input.indexOf("/")
  if (slash <= 0) throw new Error(`Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`)
  const hash = input.indexOf("#", slash + 1)
  const id = input.slice(slash + 1, hash === -1 ? undefined : hash)
  const variant = hash === -1 ? undefined : input.slice(hash + 1)
  if (!id || input.slice(0, slash).includes("#") || (variant !== undefined && (!variant || variant.includes("#"))))
    throw new Error(`Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`)
  return { providerID: input.slice(0, slash), id, ...(variant ? { variant } : {}) }
}

export const formatRef = (ref: Ref) => `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`

// Checked against the title first, then the start of the prompt; the first group that matches wins.
const KEYWORDS: [string, RegExp][] = [
  ["review", /\b(review|audit|critique|second opinion|security check|code review)\b/],
  ["plan", /\b(plan|planning|design|architect|architecture|break down|strategy|roadmap)\b/],
  ["reason", /\b(root cause|prove|reason about|analy[sz]e|analysis|trade-?offs?|investigate why|diagnose|debug)\b/],
  ["search", /\b(search|grep|find|locate|look up|lookup|scan|explore|inventory|list (all|the|every))\b/],
  ["summarize", /\b(summari[sz]e|summary|digest|condense|tl;?dr|extract)\b/],
  ["test", /\b(run (the )?tests?|write tests?|test suite|unit tests?)\b/],
  ["implement", /\b(implement|add|write|edit|fix|refactor|migrate|update|create|build|port)\b/],
]

export function inferKind(title: string, prompt: string): string | undefined {
  for (const source of [title.toLowerCase(), prompt.slice(0, 400).toLowerCase()])
    for (const [kind, pattern] of KEYWORDS) if (pattern.test(source)) return kind
}

/** The tier for a step: explicit kind, then the agent's tier, then keywords, then default. */
export function classify(step: StepInput, policy: Policy): { kind: string; tier: Tier; source: string } {
  if (step.kind && policy.kinds[step.kind]) return { kind: step.kind, tier: policy.kinds[step.kind], source: "kind" }
  const agent = policy.agents[step.agent]
  const inferred = inferKind(step.title, step.prompt)
  if (agent) return { kind: inferred ?? "other", tier: agent, source: `agent ${step.agent}` }
  if (inferred) return { kind: inferred, tier: policy.kinds[inferred] ?? "default", source: "keywords" }
  return { kind: "other", tier: policy.kinds.other ?? "default", source: "default" }
}

const find = (available: readonly Candidate[], ref: Ref) =>
  available.find((model) => model.providerID === ref.providerID && model.id === ref.id)

/** An explicit model must be available, with the variant it names. */
export function checkAvailable(ref: Ref, available: readonly Candidate[]): string | undefined {
  const model = find(available, ref)
  if (!model) return `Model "${formatRef({ ...ref, variant: undefined })}" is not available. Use the models tool to see what is available.`
  if (ref.variant !== undefined && !model.variants.includes(ref.variant))
    return model.variants.length === 0
      ? `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`
      : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${model.variants.join(", ")}.`
}

const usable = (model: Candidate) => model.status === "active" && model.tools && model.text

/** The small model with its lowest reasoning variant, like InfiniteOC's fast explore. */
export function fastRef(small: Candidate | undefined): Ref | undefined {
  if (!small) return
  const variant = ["none", "minimal", "low"].find((id) => small.variants.includes(id))
  return { providerID: small.providerID, id: small.id, ...(variant ? { variant } : {}) }
}

/**
 * The strongest usable model of the parent's provider: the newest of each family, ranked by output
 * price (a proxy for capability within one provider), never above `ratio` times the parent's price.
 */
export function strongest(available: readonly Candidate[], parent: Ref, ratio: number): { ref: Ref; why: string } {
  const own = find(available, parent)
  const parentCost = own?.outputCost ?? 0
  // Without the caller's price there is no safe ceiling, so never pick something pricier blindly.
  if (parentCost <= 0) return { ref: parent, why: "no pricing data for the caller's model; using it" }
  const newest = new Map<string, Candidate>()
  for (const model of available) {
    if (model.providerID !== parent.providerID || !usable(model)) continue
    const key = model.family ?? `id:${model.id}`
    const current = newest.get(key)
    if (!current || model.released > current.released) newest.set(key, model)
  }
  const ranked = [...newest.values()]
    .filter((model) => model.outputCost <= parentCost * ratio)
    .toSorted((a, b) => b.outputCost - a.outputCost || b.released - a.released)
  const top = ranked[0]
  if (!top || top.outputCost <= 0) return { ref: parent, why: "no pricing data for this provider; using the caller's model" }
  if (top.outputCost <= parentCost || (top.id === parent.id && top.providerID === parent.providerID))
    return { ref: parent, why: "the caller's model is already the strongest available" }
  return { ref: { providerID: top.providerID, id: top.id }, why: `strongest available ${top.providerID} model` }
}

/** Resolves a tier setting ("auto", "inherit" or a model) to a model. */
function resolveTier(
  tier: Tier,
  input: { policy: Policy; parent?: Ref; available: readonly Candidate[]; small?: Candidate },
): { ref?: Ref; why: string } {
  const setting = input.policy.models[tier]
  const parent = input.parent
  const inherit = (why: string) => (parent ? { ref: parent, why } : { why: `${why}; no caller model, using the session default` })
  if (setting !== "auto" && setting !== "inherit") {
    try {
      const ref = parseRef(setting)
      if (!checkAvailable(ref, input.available)) return { ref, why: `configured ${tier} model` }
      if (tier === "default") return inherit(`configured default ${setting} is not available`)
    } catch {}
    // A configured model that is gone falls back to the automatic choice below.
  }
  if (tier === "default" || setting === "inherit") return inherit(tier === "default" ? "caller's model" : `${tier} tier set to inherit`)
  if (!parent) return { why: "no caller model, using the session default" }
  if (tier === "fast") {
    const ref = fastRef(input.small)
    return ref ? { ref, why: `${parent.providerID}'s small model` } : inherit("no small model for this provider; using the caller's model")
  }
  const best = strongest(input.available, parent, input.policy.models.strongMaxCostRatio)
  return { ref: best.ref, why: best.why }
}

/**
 * The model a step runs on. An explicit model (or tier word) on the step wins, then a model set in
 * the agent's own configuration, then the tier from classify(). Only available models are used.
 */
export function chooseModel(input: {
  step: StepInput
  policy: Policy
  parent?: Ref
  agentModel?: Ref
  available: readonly Candidate[]
  small?: Candidate
}): Choice | { error: string } {
  const classified = classify(input.step, input.policy)
  const requested = input.step.model?.trim()
  if (requested) {
    const word = TIER_WORDS[requested.toLowerCase()]
    if (word) {
      const resolved = resolveTier(word, input)
      return { ref: resolved.ref, tier: word, kind: classified.kind, reason: `requested ${word}: ${resolved.why}` }
    }
    let ref: Ref
    try {
      ref = parseRef(requested)
    } catch (error) {
      return { error: `Step model: ${(error as Error).message} Or use a tier: fast, strong, default.` }
    }
    const missing = checkAvailable(ref, input.available)
    if (missing) return { error: missing }
    return { ref, tier: classified.tier, kind: classified.kind, reason: "requested model" }
  }
  if (input.agentModel)
    return { ref: input.agentModel, tier: classified.tier, kind: classified.kind, reason: `the ${input.step.agent} agent's configured model` }
  const resolved = resolveTier(classified.tier, input)
  return { ref: resolved.ref, tier: classified.tier, kind: classified.kind, reason: `${classified.tier} (${classified.source}): ${resolved.why}` }
}
