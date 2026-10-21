# InfiniteOC bundled source mod

Targets the local OpenCode v2.0.21 split-package source tree. Exported module:
`{ id: "infiniteoc", version: "1.0.0", async setup(api) }`.
The host first copies source to `.runtime/opencode`, then supplies `api.root`,
`api.patch(relativePath, transform)`, `api.write(relativePath, content)`, and
`api.options.reducedMotion`. Enable this mod through the host's bundled-mod loader;
this is not an upstream OpenCode runtime plugin.

## Exact source changes

Paths are under `packages/tui/src/` unless they start with `cli/` or `core/`
(`packages/cli/src/`, `packages/core/src/`).

| Target | Change |
| --- | --- |
| `theme/assets/v2/infiniteoc.json` | New v2 theme derived from the source's exact OpenCode token tree: plum backgrounds, purple interaction colors, pink accents, both light and dark palettes. Semantic error, success, diff colors remain; warning remains yellow. Dark categorical colors start with purple, so the agent color and `/stats` follow the theme. |
| `theme/index.ts`, `context/theme.tsx` | Registers `infiniteoc` alongside, not instead of, the built-in themes and makes it the initial/default theme; a stock `opencode` selection aliases to it. Other explicit themes and light/dark mode remain intact. |
| `logo.ts`, `component/logo.tsx` | Block-letter InfiniteOC wordmark, shared with the exit screen, drawn in a horizontal theme gradient (interactive to accent hue). Once per process the first home screen plays a diagonal wipe-in and one glint (about 1.6s), then stays still; an idle home never animates. One line from 44 columns, stacked below that, only `oc` under 30 columns; hidden below 12 rows like upstream. |
| `config/index.tsx` | The Animations setting defaults to `!options.reducedMotion`. |
| `ui/toast.tsx` | Toast text sweeps in with upstream `FadeInText` (200ms). Every new toast animates, and a replacement no longer inherits the previous toast's title or click action. |
| `ui/dialog.tsx` | The dialog backdrop dims in over 120ms, once per open. |
| `app.tsx`, `routes/session/index.tsx`, `feature-plugins/system/stats.tsx` | Terminal title `InfiniteOC`; reply footers show the agent's name instead of `Build`; `/stats` header reads `infiniteoc / stats`. |
| `util/presentation.ts`, `mini/splash.ts` | Resume hints read `infiniteoc -s ID` and `infiniteoc mini -s ID`. |
| `component/prompt/index.tsx`, `component/dialog-agent.tsx`, `mini/footer.command.tsx` | Prompt and agent pickers display the agent name rather than its internal ID. |
| `cli/services/updater.ts`, `cli/commands/handlers/uninstall.ts` | On the `infiniteoc` channel the binary never checks for updates, and `upgrade` and `uninstall` fail with an explanation. OpenCode's uninstaller would delete the data, config and sessions shared with stock OpenCode. |
| `core/plugin/agent.ts` | Built-in primary agent is displayed as InfiniteOC (stable `build` ID). Adds the `reviewer` (read-only: `edit`, `question`, `subagent` denied) and `researcher` (read, search, web, skills only) subagents, and gives `general` an implementation-worker description. |
| `core/plugin/plan.ts` | Hides the separate Plan primary from the selector; retains its ID, read-only permissions, and session/tool hooks for legacy sessions. |
| `core/config/plugin/agent.ts` | After configuration, restores the InfiniteOC display name, re-hides Plan, and makes Build the default when it exists. It no longer touches `system`. |
| `core/infiniteoc/guidance.ts` (new), `core/session/context.ts` | Per-agent guidance from [workflow.mjs](workflow.mjs) (build, general, explore, reviewer, researcher) is added to each session's instructions as the `infiniteoc/guidance` block. Upstream's base system prompt and its model-tuned prompts stay in place. Mods append guidance at the `// infiniteoc:guidance-extensions` marker (see `mods/deep-deliberation`). |
| `core/config/plugin/skill.ts` | Registers the directory in `INFINITEOC_SKILLS` (the launcher sets it to the bundled `skills/`) as a skill source. Most bundled skills are unlisted (`opencode/autoinvoke: false`) but load by ID; `auto-route` searches them. |
| `core/plugin/infiniteoc-goal.ts` (new, from [goal.ts](goal.ts)), `core/plugin/internal.ts` | `/goal <what done means>` keeps the agent working until the goal is done and verified; `/goal stop` ends it, Esc only pauses the turn (the goal auto-resumes on your next message, or immediately via `/goal resume`). After each run the plugin reads the transcript: no marker sends a continuation (max 50), `GOAL COMPLETE` sends one verification pass (re-run checks, reviewer subagent), and `GOAL VERIFIED` or an error ends the goal with a toast and a note, while an interrupt (Esc) or `GOAL BLOCKED` pauses it with a transcript note instead (no toast; the footer shows the paused goal). The transcript's `[InfiniteOC goal ...]` messages record what happened; a small per-session record (`core/plugin/infiniteoc-goal-store.ts`, from [goal-store.ts](goal-store.ts), in `$XDG_DATA_HOME/infiniteoc/goals/<session>.json`) keeps the goal, its counters and the plan, because a compaction hides the start message from the session context and the goal used to end silently there. While a goal is active, every step's system prompt carries a block with the goal and the rules (it stays byte-identical for the goal's lifetime, so the provider's prompt cache survives; the turn and the recorded plan with the next step marked travel in the continuation prompts and `goal_progress` replies instead): keep working, never end a turn with a summary, a "Next: ..." list or a question about going on, and use `goal_progress` instead of progress reports. `goal_progress {plan?, done?, note?}` (visible only while a goal is active) stores the plan and answers with it and "do this now, without ending your turn: <next step>"; being a tool call, it keeps the run going instead of ending the turn. A reply that ends by announcing work (`Next:`/`Remaining:` lists and headings, "I'll now implement ...", "Shall I continue?") gets a continuation that quotes it and says to do it now. Verified with a scripted model: every request carries the block and the tool, the plan reaches the prompt, and a "Next:" stop is sent back and finished. No permission changes. A turn that would get a continuation while background work it started is still running (a workflow from mods/workflows, an upstream background subagent) is held instead of re-prompted, so the agent does not wake every turn just to check on it: the work's completion notice (or the user) starts the next run and the goal goes on from there. A hold adds no control message and costs no goal turn. A held goal also resumes when a workflow step messages the idle agent (or a step finishes with `notify: "each"`), 5 s after the work ended without waking the session (a cancel), and after 5 minutes without progress, with a note saying why; a finished step restarts that 5-minute clock. `/goal stop` ends a hold; `verify` passes are never held. Workflows report to the shared registry `core/infiniteoc/background.ts` (new, from [background.ts](background.ts)). |
| `core/plugin/infiniteoc-frontend.ts` (new, from [frontend.ts](frontend.ts)), `core/plugin/internal.ts` | Frontend gate: an `edit`, `write` or `patch` call on a UI file (HTML, CSS/SCSS/Less, JSX/TSX, Vue, Svelte, Astro, MDX and common templates) is refused until the session's context contains the bundled `frontend-design` skill, with a message telling the model to load it and retry. It applies to every agent, subagent and model; it fails open if the transcript cannot be read. A prompt that clearly asks for web UI work (web app, website, landing page, HTML/CSS, React/Vue/Svelte, dashboard, UI) gets the bundled skill attached when the session has not loaded it, so the first UI write is not refused and written twice. The build, general and reviewer guidance also require the skill for UI work. |
| `core/plugin/infiniteoc-ponytail.ts` (new, from [ponytail.ts](ponytail.ts) with `skills/ponytail/SKILL.md` inlined), `core/plugin/internal.ts` | Ponytail: `/ponytail auto|lite|full|ultra|off` (saved in `$XDG_CONFIG_HOME/opencode/.ponytail-active`, default `off` unless `PONYTAIL_DEFAULT_MODE` overrides it) and the `/ponytail-*` skill commands. A context hook inserts the level's ruleset just before the turn's user message, without persisting it, when the mode is fixed or when `auto` detects a coding turn. Explore, researcher, reviewer, title and compaction never get it; "stop ponytail" or "normal mode" as a whole message turns it off for the session. |
| `tui/component/prompt/goal-word.ts`, `tui/feature-plugins/prompt/goal.tsx` (new, from [tui/](tui/)), `prompt/index.tsx`, `plugin/builtins.ts`, `routes/session/index.tsx` | `/goal` typed at the start of the prompt shows a moving purple-to-pink gradient through its own non-virtual extmarks (static when animations are off). A builtin footer plugin shows `goal 3/50 · <goal>` while a goal is active, read from the transcript. Goal start messages are displayed as `/goal <text>`. |
| `core/tool/plugin/subagent.ts`, `core/plugin/agent.ts` | `explore` defaults to `Model.small` of the parent's provider at the lowest reasoning variant, unless the call or config sets a model or `INFINITEOC_FAST_EXPLORE=0`. Step caps: explore 30, researcher 30, reviewer 60. |
| `core/config/plugin/instruction.ts`, `core/instructions/builtins.ts` | `CLAUDE.md` is loaded (and watched) like `AGENTS.md` in directories without an `AGENTS.md`. The environment block adds `OS: <type> <release> (<arch>), shell <SHELL>`. |
| `component/dialog-config.tsx` and three new component files | `installSettings` adds InfiniteOC Settings to `/settings`; see [settings/README.md](settings/README.md). |

The inspected revision registers Build in the agent plugin and a separate Plan
primary in the plan plugin. Plan is now hidden, not removed. General and Explore
remain subagents; title, summary, and compaction remain hidden internal agents.
User-defined agents and permission rules remain stored. When Build exists,
InfiniteOC becomes the default and sole visible primary, hiding Quick and any
other primary choices without deleting them. Subagents remain available.
A disabled Build agent is not recreated. `build` remains the internal identifier.
The guidance respects requested read-only/planning work; it is conversational
guidance, **not a replacement for permission enforcement**. An agent `system` prompt
replaces upstream's base prompt, so InfiniteOC adds guidance as an instruction block
instead. A custom Build `system` you configure is left exactly as you wrote it.

No permission rules, tools, approval handlers, sandbox logic, or config permission
merging are changed for existing agents. The mod never writes upstream, user config, or external assets;
all writes go through the supplied source-worktree API.

`reducedMotion: true` makes Animations default to off: the logo intro, toast and
dialog fades, spinners and tab pulses. It is applied at build time, so changing it
requires a rebuild; an Animations choice made in the TUI (`/settings` or the
palette's "Disable animations") still wins. Animation is presentation-only.
Patches use checked unique anchors and throw on source drift rather than silently
patching unrelated code; rerunning on compatible patched source is supported.

## Verification and suggested integration checks

Run `node --test mods/infiniteoc/test.mjs` from the repository root for source
anchor, idempotence, reduced-motion, wordmark, toast, pinned-build, theme palette,
and permission-rule invariance checks against the local upstream checkout (all
transformations stay in memory). Then build/typecheck the patched worktree's
TUI/core using its own Bun scripts. Launch with a fresh TUI config to confirm the
default purple/pink theme; select another theme to confirm the user override
survives restart. Check wide/narrow/short terminals, light/dark mode, an intro that
plays once per process (and not with Animations off), and replacing toasts.
Inspect the agent endpoint/UI: InfiniteOC must be the visible built-in primary,
with stable `build` ID and unchanged subagents. Exercise a denied command,
approval-required external-directory access, and `.env` reads: restrictions must
remain identical to unmodified source. No interactive runtime/build verification
is claimed by the source-only tests.
