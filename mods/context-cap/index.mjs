// Automatic compaction starts near the model's window (85% of it), so on 1M-token models it never starts: stored
// sessions grew past 440k tokens, each step resending all of it. A cap compacts at min(that point, the cap).
// Replayed over the stored sessions (10,082 steps): 200k processes 21% fewer context tokens for 17 compactions.
export const DEFAULT_CAP = 200_000
// Below this, a compaction's own summary and kept tail (~47k tokens measured) leave little room to work.
const MIN_CAP = 64_000

/** The cap from options.contextCap: a token count, or false/0 for none. */
export function capFrom(options = {}) {
  const value = options?.contextCap ?? DEFAULT_CAP
  if (value === false || value === 0) return undefined
  if (!Number.isInteger(value) || value < MIN_CAP) throw new Error(`context-cap: options.contextCap must be false, 0 or an integer >= ${MIN_CAP}`)
  return value
}

export const CEILING = ["packages/core/src/session/compaction.ts", `const calculateCeiling = (limit: SessionContext.Loaded["model"]["limit"], buffer: Settings["buffer"]) => {
  // With no window at all, only a provider rejection can limit the request.
  const window = inputWindow(limit)
  if (window <= 0) return Number.POSITIVE_INFINITY
  const tokens = typeof buffer === "string" ? Math.round((window * Number.parseFloat(buffer)) / 100) : buffer
  // A buffer that leaves no room, such as one set for a larger model, is ignored.
  if (tokens !== undefined && tokens < window) return window - tokens
  return window - Math.max(Math.floor(window * RESERVE_SHARE), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0)
}`]

export const ceiling = (cap) => [CEILING[0], CEILING[1], `// InfiniteOC context-cap: automatic compaction starts at ${cap.toLocaleString("en-US")} tokens at the latest.
const CONTEXT_CAP = ${cap}
const calculateCeiling = (limit: SessionContext.Loaded["model"]["limit"], buffer: Settings["buffer"]) =>
  Math.min(windowCeiling(limit, buffer), CONTEXT_CAP)
const windowCeiling = (limit: SessionContext.Loaded["model"]["limit"], buffer: Settings["buffer"]) => {
  // With no window at all, only a provider rejection can limit the request.
  const window = inputWindow(limit)
  if (window <= 0) return Number.POSITIVE_INFINITY
  const tokens = typeof buffer === "string" ? Math.round((window * Number.parseFloat(buffer)) / 100) : buffer
  // A buffer that leaves no room, such as one set for a larger model, is ignored.
  if (tokens !== undefined && tokens < window) return window - tokens
  return window - Math.max(Math.floor(window * RESERVE_SHARE), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0)
}`]

export default {
  id: "context-cap",
  version: "1.0.0",
  async setup(api) {
    const cap = capFrom(api.options)
    if (cap) await api.patchExact(...ceiling(cap))
  },
}
