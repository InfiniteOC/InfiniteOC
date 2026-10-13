# infinicode

**InfiniCode** is one more effort level, offered for every model next to its own levels
(low/medium/high/xhigh/max, a thinking toggle or thinking budgets), and also for models that
have none. Selecting it:

- runs the model at its **strongest effort**: the request carries exactly what the model's
  strongest variant sends (`effort: "max"`, `reasoningEffort: "xhigh"`, the largest thinking
  budget, the thinking toggle on…). A model without effort controls keeps its defaults.
- turns **workflows on** (mods/workflows), and gives back your own setting when you leave.
- **fades the theme to red** (crimson and scarlet on warm dark-red neutrals) in 0.7 s, and back to
  your theme when you leave. The InfiniteOC wordmark and the `InfiniCode` effort label turn red
  with it. With Animations off (or `options.reducedMotion`) the switch is instant.

## Using it

| How | What happens |
| --- | --- |
| `ctrl+t` (Variant cycle) | default → the model's levels → **InfiniCode** → default |
| `/variants` (also `/effort`, `/thinking`) | InfiniCode is the last entry: "strongest effort · workflows on · red theme" |
| `/infinicode` (command palette: "Toggle InfiniCode") | on; again: off, back to the effort the model had before |

The prompt footer shows `InfiniCode` where the effort is shown (`InfiniteOC · Claude Opus 4.7
Anthropic · InfiniCode`), in the theme's interactive red instead of the warning yellow of the
other levels. A toast says what it did: `On · max effort · workflows on · red theme`, and on leaving
`Off · workflows back to off`.

Leaving through `ctrl+t` goes on to *default*, like upstream's cycle after its last level; the
picker sets what you pick; `/infinicode` restores the previous level.

## State: per model, and it persists

InfiniCode is a real variant, so it behaves like every effort level in upstream:

- It is remembered **per model** (upstream's `model.json` variant preference) and per session
  (the session's model reference records `#infinicode` once you send a prompt). It **survives a
  restart**: InfiniCode sessions and models come back in InfiniCode, red, with workflows on.
- The theme and workflows follow **the effort that is shown**: switching to a model or session at
  another level leaves InfiniCode (fade back, workflows restored); switching to one in InfiniCode
  enters it again. It is not a global mode that forces every model to its maximum.
- The effort a model had before InfiniCode (for `/infinicode` off) is kept in the TUI's durable
  plugin storage (`plugin.infiniteoc.infinicode.previous`).
- Workflows: entering saves your explicit `workflows.enabled` (`true`, `false` or unset) once, as
  `infinicode.workflowsBefore` in the InfiniteOC settings file (`$INFINITEOC_SETTINGS_FILE`, else
  `~/.config/infiniteoc/settings.json`), and sets `workflows.enabled: true`. Leaving puts the saved
  value back (unset stays unset, so the build default applies again) and removes the entry. If you
  turned workflows off yourself while InfiniCode was on, leaving keeps your choice. A TUI that
  stopped while InfiniCode was on and starts at another level restores the value at startup.

Workflows are one global flag: with two TUIs open, the last one to enter or leave InfiniCode decides.

## Without the workflows mod

InfiniCode still sets the strongest effort and the red theme. It detects at build time whether
mods/workflows is enabled **before** it (`feature enable` appends, so enable workflows first); if
not, it never writes the flag and the toast says `workflows unavailable (workflows mod disabled)`.

## How the strongest effort is chosen

`variant.ts`, per model, from upstream's own variant list (packages/core/src/variant.ts and any
`variants` in your provider config), so no provider is hardcoded:

1. Rank each variant by its id and by the effort values its overlays send (`effort`,
   `reasoningEffort`, `reasoning_effort`, `thinkingLevel`, `maxReasoningEffort`):
   none < minimal < low < medium = thinking < high < xhigh < max.
2. On equal rank, the larger thinking budget wins (`budgetTokens`, `thinkingBudget`, `budget_tokens`,
   `tokenBudget`, `reasoning_budget`, `max_tokens`; `-1` = dynamic counts as unlimited).
3. Still equal (or unknown custom names without either): the later one, as upstream lists levels
   ascending.

So Anthropic adaptive models get `max`, OpenAI Responses `xhigh`, chat-completions providers
`high`, Gemini `high` (levels) or `max` (budgets), DeepSeek/Moonshot/Z.ai `max`, toggle-only models
`thinking`. A variant you configure with the id `infinicode` is used as is.

## The red theme

`infinicode.json` is generated at build time from the InfiniteOC theme (from upstream's stock v2
theme when mods/infiniteoc is disabled) with three hues replaced per mode: `gray` (red-tinted
neutrals: background, text, borders), `crimson` (interactive) and `scarlet` (accent), plus border,
scrollbar and categorical colors. Semantic colors (error, warning, success, diff, syntax roles) are
unchanged; note that errors are red on a red theme. Tests require at least 12:1 contrast for text,
4.5:1 for muted text, links and accents, in dark and light mode.

The fade blends the **resolved** themes token by token in OKLab (`blend.ts`), from whichever theme
is active (any built-in, custom or system theme) to the red one, using upstream's
`createAnimatable` + `tween` (ui/animation.ts, the same machinery the dialog fade uses). The first
and last frames are the real themes. Your theme choice and config are never changed: `/themes` still
shows and saves your theme, though while InfiniCode is on its preview is covered by the red.

## How it hooks into upstream (v2.0.21)

| File | Change |
| --- | --- |
| `packages/core/src/infiniteoc/infinicode-variant.ts` | `variant.ts` (pure) |
| `packages/core/src/model.ts` | The merged catalog entry (`… satisfies Info` in `Model.snapshot`) gets `variants: withInfinicode(model.variants ?? [])`; the server's model list, the TUI catalog, the session runner and the subagent tool all read this snapshot, so `#infinicode` resolves like any variant (`ModelResolver.withVariant`) |
| `packages/tui/src/theme/assets/v2/infinicode.json` | The red document |
| `packages/tui/src/theme/infinicode-blend.ts`, `theme/infinicode.ts` | Pure blend; the active signal and the animated tokens accessor |
| `packages/tui/src/context/theme.tsx` | `const tokens = () => selected().theme` → `createInfinicodeTokens(…)` with the Animations / `reducedMotion` default |
| `packages/tui/src/feature-plugins/system/infiniteoc-infinicode.tsx` | Builtin plugin, listed after `DiffViewer,` in `plugin/builtins.ts`: `/infinicode`, and the watcher on `context.ui.model.current()` that sets the theme signal and enters/leaves workflows |
| `packages/tui/src/infiniteoc-features/infinicode-{variant,store,build}.ts` | Shared variant logic, the settings-file store, `workflowsAvailable` |
| `packages/tui/src/component/prompt/metadata.tsx` | Label `InfiniCode` and its color |
| `packages/tui/src/component/dialog-variant.tsx` | Picker title and description |

Order: after mods/infiniteoc (theme source) and mods/workflows (availability). Every patch requires
one exact anchor and fails closed.

## Permissions and safety

Nothing here changes permission rules, approvals, agents, providers, credentials or sessions. The
plugin only calls upstream's variant setter and writes `workflows.enabled` plus its own
`infinicode` key in the settings file (atomic rename, mode 0600, refusing a file that is not strict
JSON, every other key kept). Workflows themselves keep all their own checks (mods/workflows/README.md).

## Limits

- **Cost**: the strongest effort is the slowest and most expensive level, and workflows may start
  extra subagents on a stronger model (mods/workflows `strong` tier). That is the point of the mode;
  it is never on unless you pick it.
- Subagents inherit the session's model reference, so they also run at InfiniCode unless they use
  their own model (explore's fast model keeps its minimal level).
- **Disabling the mod**: turn InfiniCode off first. Afterwards the TUI drops the unknown variant
  (back to default), but a session whose stored model still says `#infinicode` fails a background
  continuation until you send it a prompt, and a saved `infinicode.workflowsBefore` is not restored
  (set Workflows in `/settings`).
- `infiniteoc mini` lists the raw id `infinicode` and has no red theme or workflows switch.
- During the 0.7 s fade, hue-step lookups (`theme.increase/decrease`) return their input, and colors
  from a system theme's terminal palette blend by their RGB value.

## Verification

`node --test mods/infinicode/test.mjs`: injection with and without native variants, the strongest
variant per protocol shape (Anthropic adaptive and budgets, OpenAI Responses and chat, Gemini levels,
budgets and toggle, DeepSeek-style, toggle-only, custom config), entering and restoring workflows
(file mode, other keys, non-JSON refusal, agreement with `mods/workflows/flag.mjs`), OKLab
interpolation, reduced motion, the resolved-theme blend (state colors, surfaces), the red theme's
structure and contrast, and the mod applied after every enabled mod onto pristine upstream (anchors,
imports, fail-closed). Not compiled or run here: rebuild, then follow the checklist in the root
VERIFICATION.md.
