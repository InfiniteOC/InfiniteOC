// InfiniteOC workflows: how many steps each model may run at once, and which pool member a step
// starts on. Providers throttle: the free DeepSeek endpoint answered 12 of 16 parallel requests with
// 503 "Endpoint is unavailable", and the retry backoff stretched a 3 s fan-out to 17-40 s. Measured
// over 9 models at 16 parallel, wall times ranged from 2.8 s to 100 s and changed run to run.
// So both are learned per model:
// - the limit (AIMD): halved on a throttling error (429, 5xx, overload; once per burst), raised by one
//   after `cap` successes;
// - the speed: a moving average of step time. A step goes to the member that should finish it first,
//   (running + 1) × average, and a member not measured yet is assumed as fast as the best one, so it gets tried.
// Pure (no imports): the plugin keeps one Limits per server process.
// Written to packages/core/src/plugin/infiniteoc-wf-pool.ts by mods/workflows.

export type Limits = Map<string, { cap: number; wins: number; until: number; ms?: number }>

/** After a throttling error, new steps on that model wait this long; more errors in the window do not cut again. */
export const PAUSE_MS = 3000
/** An exhausted quota or balance does not come back in seconds: the model is skipped this long. */
export const QUOTA_PAUSE_MS = 5 * 60_000

const entry = (limits: Limits, model: string) => {
  let found = limits.get(model)
  if (!found) limits.set(model, (found = { cap: Infinity, wins: 0, until: 0 }))
  return found
}

/** Steps the model may still start now: unlimited until it was throttled, none while it pauses. */
export function room(limits: Limits, model: string, running: number, now: number) {
  const found = limits.get(model)
  if (!found) return Infinity
  if (now < found.until) return 0
  return Math.max(0, found.cap - running)
}

/**
 * Where a new step should go: the member expected to finish it first. A member with a known width
 * (`slots`, or its learned limit) finishes `width` steps at a time: (batches ahead + 1) × its average time;
 * one without works in parallel but slows with load: (running + 1) × its average time. A full member can win (its queue
 * drains before a slow member would finish): then `ready` is false and the step waits for it. Members
 * paused after a throttling error are skipped; `blocked` marks members with no room for other reasons.
 * Pool order breaks ties. A member not measured yet counts as fast as the best one, so it gets tried.
 */
export function choose(
  pool: readonly string[],
  running: (model: string) => number,
  limits: Limits,
  now: number,
  slots: (model: string) => number = () => Infinity,
  blocked: (model: string) => boolean = () => false,
): { model: string; ready: boolean } | undefined {
  const known = pool.map((model) => limits.get(model)?.ms).filter((ms): ms is number => ms !== undefined)
  const optimistic = known.length ? Math.min(...known) : 1
  let best: { model: string; ready: boolean } | undefined
  let soonest = Infinity
  for (const model of pool) {
    const found = limits.get(model)
    if (found && now < found.until) continue
    const count = running(model)
    const width = Math.max(1, Math.min(slots(model), found?.cap ?? Infinity))
    // A known width (Claude Code slots, a learned limit) works in batches; otherwise every running step
    // adds to the provider's load, which spreads steps over the members before any of them throttles.
    const eta = (Number.isFinite(width) ? Math.floor(count / width) + 1 : count + 1) * (found?.ms ?? optimistic)
    if (eta >= soonest) continue
    best = { model, ready: count < width && !blocked(model) }
    soonest = eta
  }
  return best
}

/** The member to start a step on right now, or undefined when the best place for it is busy. */
export function pick(pool: readonly string[], running: (model: string) => number, limits: Limits, now: number): string | undefined {
  const choice = choose(pool, running, limits, now)
  return choice?.ready ? choice.model : undefined
}

/** A throttling error while `running` steps used the model: halve what it held and pause it (briefly, or long for a quota). */
export function limited(limits: Limits, model: string, running: number, now: number, pause = PAUSE_MS) {
  const found = entry(limits, model)
  if (now < found.until && pause <= PAUSE_MS) return
  found.cap = Math.max(1, Math.floor(Math.min(found.cap, Math.max(1, running)) / 2))
  found.wins = 0
  found.until = Math.max(found.until, now + pause)
}

/** A step on the model completed in `ms`: learn its speed; every `cap` successes raise its cap by one, up to max. */
export function succeeded(limits: Limits, model: string, ms: number, max: number) {
  const found = entry(limits, model)
  found.ms = found.ms === undefined ? ms : Math.round(found.ms * 0.7 + ms * 0.3)
  if (found.cap === Infinity || ++found.wins < found.cap) return
  found.cap = Math.min(max, found.cap + 1)
  found.wins = 0
}

/** Waits before retrying a rate-limited request: 5 s, doubling to RATE_MAX_MS; with 10 retries about 7 minutes. */
export const RATE_BASE_MS = 5000
export const RATE_MAX_MS = 60_000

/**
 * The wait before retry `attempt` (2 is the first retry) after a rate limit: never shorter than the
 * `proposed` delay (it carries the provider's retry-after), spread ±20% so parallel steps do not retry in step.
 */
export function rateLimitDelay(attempt: number, proposed = 0, jitter = Math.random()) {
  const backoff = Math.min(RATE_MAX_MS, RATE_BASE_MS * 2 ** Math.max(0, attempt - 2))
  return Math.round(Math.max(proposed, backoff * (0.8 + 0.4 * jitter)))
}

/** Errors that mean the provider is out of capacity: they cut the model's limit and move pooled steps. */
export const throttled = (error: { status?: number; type?: string; message?: string }) =>
  error.status === 429 ||
  (error.status !== undefined && error.status >= 500) ||
  exhausted(error) ||
  /rate.?limit|too many requests|overload|unavailable|capacity/i.test(`${error.type ?? ""} ${error.message ?? ""}`)

/** A request-rate limit (429, "rate limit exceeded"): usually counted per account, not per model. */
export const rateLimit = (error: { status?: number; type?: string; message?: string }) =>
  error.status === 429 || /rate.?limit|too many requests/i.test(`${error.type ?? ""} ${error.message ?? ""}`)

/** An exhausted quota, balance or credit (seen: agentrouter 403 "pre-consume quota failed"). */
export const exhausted = (error: { status?: number; type?: string; message?: string }) =>
  error.status === 402 || /quota|insufficient (balance|credit|funds)|credit balance|billing/i.test(`${error.type ?? ""} ${error.message ?? ""}`)
