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

`chooseEffort` maps the prompt to a tier:

- `low` — greeting, lookup, or a short one-line edit (`fix`, `rename`, `show`, ...);
- `medium` — the default;
- `high` — a long prompt, a code fence, a stack trace, ≥6 lines, ≥3 questions, or a hard signal
  (`debug`, `why is`, `root cause`, `design`, `refactor`, `review`, `migrate`, `security`, ...).

The tier then picks the id named after it when the model offers one, else the closest rank (ties
toward the cheaper variant), an on/off model is off for low and on otherwise, and custom ids without
a rank fall back to position. A model with no effort controls is left alone (no `auto` variant).

## Checking

- `node --test mods/effort/test.mjs` — pure choice/heuristic/rewrite cases and ordered application
  over disposable fixtures (anchors fail closed on a second application or a changed upstream).
- `node skills/infiniteoc-mod-development/scripts/check-mod.mjs mods/effort/index.mjs .` — full
  ordered application against pristine upstream with all enabled mods.
- `node bin/infiniteoc.mjs feature enable effort`, restart, then pick `auto` with `ctrl+t` (it keeps
  the id as its label; only InfiniCode's own name is prettified).

Rollback: `node bin/infiniteoc.mjs feature disable effort`, restart.
