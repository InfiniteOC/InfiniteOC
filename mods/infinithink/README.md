# infinithink

Thinking in proportion to the problem. One constant `[InfiniThink]` guidance block for every agent
(build and the subagents), replacing `[Deep deliberation]` from mods/deep-deliberation, which asked for
three approaches, failure modes and a plan before any substantive action and "outranks speed
heuristics": reasoning spent on decisions that did not need it, on every agentic step.

The block tells the model to size the problem first, weigh alternatives only when a choice is costly
to reverse or the first attempt failed, use a tool call instead of reasoning about what it would show,
think between tool calls only about what the last result changed, stop once the next action is clear,
and switch to evidence after two failed hypotheses. Depth the user asks for is still given, and the
verification rules are untouched: thinking less never means checking less.

How much the model may think is the effort's job (mods/effort, including `auto`); InfiniThink is how
it spends that budget. The text is the same for every request, so it costs nothing in prompt-cache
terms. At low effort mods/effort still swaps the workflow for its lean contract; InfiniThink stays.

Order: after `infiniteoc` (it patches the guidance file that mod writes) and after
`deep-deliberation` when both are enabled.

```sh
node --test mods/infinithink/test.mjs
node bin/infiniteoc.mjs feature check infinithink
```

Rollback: `node bin/infiniteoc.mjs feature disable infinithink`, restart (deep deliberation comes back
if that mod is still enabled).
