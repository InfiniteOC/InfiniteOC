// InfiniThink: thinking in proportion to the problem. One constant guidance block for every agent,
// replacing [Deep deliberation] (three approaches before any substantive action, "outranks speed"),
// which spent reasoning on decisions that did not need it. Constant text keeps the cached prompt
// prefix stable; how much the model may think stays with the effort (mods/effort).
export const infinithink = `[InfiniThink]
Think in proportion to the problem, then act.
- Size it first: a lookup, a setting or a one-line change needs no plan; a cross-cutting change or a failure you cannot explain does.
- Weigh alternatives only when a choice is costly to reverse or the first attempt failed; otherwise take the clear fit and go.
- Do not reason about what one tool call can tell you: read, search or run it.
- Between tool calls, think only about what the last result changed.
- Stop deliberating once the next action is clear: do not re-derive settled facts, re-check what already passed, or draft the reply twice.
- After two failed hypotheses, collect evidence that tells them apart instead of theorizing further.
- When the user asks for depth (think hard, a design, a hard bug), give it: proportion cuts waste, not care.
Thinking less never means verifying less; the verification rules still apply. This grants no tool access and changes no permission.`

// mods/infiniteoc writes packages/core/src/infiniteoc/guidance.ts with this extension marker.
const MARKER = "// infiniteoc:guidance-extensions"
const TARGET = "packages/core/src/infiniteoc/guidance.ts"

/** Drops mods/deep-deliberation's block (if that mod ran first) and gives every agent InfiniThink. */
export function guidanceSource(source) {
  if (typeof source !== "string") throw new Error("infinithink: invalid source")
  if (source.includes("[InfiniThink]")) throw new Error("infinithink: already applied; refusing to duplicate")
  if (source.split(MARKER).length !== 2) throw new Error("infinithink: expected one source anchor: InfiniteOC guidance marker")
  const lines = source.split("\n")
  const deliberation = lines.filter((line) => /^infiniteocGuidance\.\w+\.push\(".*\[Deep deliberation\]/.test(line))
  if (deliberation.length > 1) throw new Error("infinithink: expected at most one [Deep deliberation] block")
  return lines
    .filter((line) => !deliberation.includes(line))
    .join("\n")
    .replace(MARKER, () => `for (const entries of Object.values(infiniteocGuidance)) entries.push(${JSON.stringify(infinithink)})\n${MARKER}`)
}

export default {
  id: "infinithink",
  version: "1.0.0",
  async setup(api) {
    await api.patch(TARGET, guidanceSource)
  },
}
