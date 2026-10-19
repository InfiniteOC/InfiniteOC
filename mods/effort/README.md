# effort

Two related changes to model effort, both driven by one pure module
(`effort-lib.ts`, written to `packages/core/src/infiniteoc/effort-lib.ts`):

## 1. Realistic efforts (low effort stops overthinking)

The harness guidance (mods/infiniteoc's `[InfiniteOC unified workflow]` plus the blocks other mods
append) is effort-independent, so a model on `low` is still told to deliberate, plan, spawn
workflows and run full quality-tool batteries. A server plugin
(`plugin.ts` → `packages/core/src/plugin/infiniteoc-effort.ts`) rewrites the request's system parts
per request: at the `none`/`minimal`/`low` tier the main workflow entry becomes a lean contract
(act, smallest working change, one cheap check, 1-3 sentence reply, no subagents/workflows) and
`[Deep deliberation]` and `[Quality tools]` are dropped. Everything else — safety, permissions,
autonomy, tool awareness, project and environment context — is kept byte-for-byte.

`medium` and above are unchanged for now, so this cannot regress the default behavior.

## 2. `auto` effort

Every model whose variants are computed by `Variant.resolve` — models.dev and configured providers,
i.e. the normal catalog path — also offers an `auto` variant. The wrap is applied inside `resolve`
(`packages/core/src/variant.ts`) before `mods/infinicode` appends its own variant to the list, so
InfiniCode stays last and the two mods are order-independent. `auto` is resolved
per Step from the newest user message, before the model is resolved
(`packages/core/src/infiniteoc/auto-effort.ts` called from `SessionContext.resolveModel`), so the
chosen variant drives the runtime overlay and the recorded message ref. The session's own selection
stays `auto`.

A provider that hand-rolls its own variant list instead of calling `Variant.resolve` (the GitHub
Copilot, ChatGPT and Modal plugins) gets no `auto`; its models keep their native efforts.

`autoDecision` scores the whole turn, not just its wording. Everything it reads is fixed when the
turn starts (`SessionHistory.latestTurn`: the newest user message, the one before it and the
assistant messages between), so every step of a turn runs at the same effort:

- explicit cues win: "ultrathink" / "think harder" / "max effort" → `max`; "quickly", "briefly",
  "tl;dr" lower the score; "carefully", "thoroughly", "edge cases", "make sure" raise it;
- greetings and thanks → `low`; a go-ahead ("yes", "continue", "do it", "try again") keeps the
  previous turn's effort instead of dropping to low (one step more after a turn with ≥2 failures);
- a complaint about the last attempt ("still not working", "same error") gets at least one step more
  than that attempt ran at;
- otherwise points add up: hard-work words (`debug`, `why does`, `root cause`, `design`, `refactor`,
  `migrate`, `security`, `race condition`, ...), a stack trace or error, a code block, a long prompt,
  three or more list items (several tasks), several questions or file paths, an image, three or more
  attachments, failed tool calls in the previous turn, the plan agent; a short lookup or one-line edit
  subtracts. ≤0 is `low`, 1-2 `medium`, 3-9 `high`, ≥10 `max`;
- sticky downward: a turn one point under the previous turn's tier keeps it (each switch can cost the
  prompt cache; upgrades are never held back);
- a subagent session (its prompt is the parent's detailed brief) is capped at `high`.

On the stored sessions this picks low for 18% of prompts, medium 69%, high 14% and never max without
being asked. The tier then picks the id named after it when the model offers one (`max` without a `max` id → `xhigh`),
else the closest rank (ties toward the cheaper variant); an on/off model is off for low and on
otherwise, and custom ids without a rank fall back to position. A model with no effort controls is left
alone (no `auto` variant).

A low effort that auto picked gets the lean contract as a trailing note ("[Low effort for this turn]",
with auto's reasons) instead of the system rewrite in section 1: auto can change tier every turn, and a
changed system prompt makes the provider re-read the whole conversation uncached.

## Checking

- `node --test mods/effort/test.mjs` — pure choice/heuristic/rewrite cases and ordered application
  over disposable fixtures (anchors fail closed on a second application or a changed upstream).
- `node skills/infiniteoc-mod-development/scripts/check-mod.mjs mods/effort/index.mjs .` — full
  ordered application against pristine upstream with all enabled mods.
- `node bin/infiniteoc.mjs feature enable effort`, restart, then pick `auto` with `ctrl+t` (it keeps
  the id as its label; only InfiniCode's own name is prettified).

Rollback: `node bin/infiniteoc.mjs feature disable effort`, restart.
