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
| `core/plugin/agent.ts` | Server-side built-in primary agent is displayed as InfiniteOC with a unified-agent description. Existing `build` ID is deliberately retained for session/config compatibility. |
| `core/plugin/plan.ts` | Hides the separate Plan primary from the selector; retains its ID, read-only permissions, and session/tool hooks for legacy sessions. |
| `core/config/plugin/agent.ts` | After configuration, restores InfiniteOC display name, appends unified workflow guidance to the custom build prompt without replacing it, re-hides Plan, and makes Build the default when it exists. |
| `component/dialog-config.tsx` and three new component files | `installSettings` adds InfiniteOC Settings to `/settings`; see [settings/README.md](settings/README.md). |

The inspected revision registers Build in the agent plugin and a separate Plan
primary in the plan plugin. Plan is now hidden, not removed. General and Explore
remain subagents; title, summary, and compaction remain hidden internal agents.
User-defined agents and permission rules remain stored. When Build exists,
InfiniteOC becomes the default and sole visible primary, hiding Quick and any
other primary choices without deleting them. Subagents remain available.
A disabled Build agent is not recreated. `build` remains the internal identifier.
The primary agent's system instruction respects requested read-only/planning work;
this is conversational guidance, **not a replacement for permission enforcement**.

No permission rules, tools, approval handlers, sandbox logic, or config permission
merging are changed. Custom Build prompts are preserved as the base, with the
unified workflow appended once after config. The mod never writes upstream, user config, or external assets;
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
