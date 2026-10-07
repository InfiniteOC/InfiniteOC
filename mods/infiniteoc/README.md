# InfiniteOC bundled source mod

Targets the local OpenCode v2.0.21 split-package source tree. Exported module:
`{ id: "infiniteoc", version: "1.0.0", async setup(api) }`.
The host first copies source to `.runtime/opencode`, then supplies `api.root`,
`api.patch(relativePath, transform)`, `api.write(relativePath, content)`, and
`api.options.reducedMotion`. Enable this mod through the host's bundled-mod loader;
this is not an upstream OpenCode runtime plugin.

## Exact source changes

| Target | Change |
| --- | --- |
| `packages/tui/src/theme/assets/v2/infiniteoc.json` | New v2 theme derived from the source's exact OpenCode token tree: plum backgrounds, purple interaction colors, pink accents, both light and dark palettes. Semantic error, success, diff colors remain; warning remains yellow. |
| `packages/tui/src/theme/index.ts` | Registers `infiniteoc` alongside, not instead of, existing built-in themes. |
| `packages/tui/src/context/theme.tsx` | Initial/default theme becomes `infiniteoc`; stock `opencode` selection aliases to `infiniteoc`. Other explicit themes and light/dark mode remain intact. |
| `packages/tui/src/component/logo.tsx` | Responsive InfiniteOC ASCII logo with per-character purple/pink sinusoidal gradient, 10fps animation, lifecycle timer cleanup. Compact text on narrow terminals; hidden below 12 rows, matching upstream height behavior. |
| `packages/core/src/plugin/agent.ts` | Server-side built-in primary agent is displayed as InfiniteOC and receives a unified reasoning/planning/implementation instruction. Existing `build` ID is deliberately retained for session/config compatibility. |
| `packages/core/src/plugin/plan.ts` | Hides the separate Plan primary from the selector; retains its ID, read-only permissions, and session/tool hooks for legacy sessions. |
| `packages/core/src/config/plugin/agent.ts` | After configuration, restores InfiniteOC display name, appends unified workflow guidance to the custom build prompt without replacing it, re-hides Plan, and maps a configured Plan default to Build when Build exists. |

The inspected revision registers Build in the agent plugin and a separate Plan
primary in the plan plugin. Plan is now hidden, not removed. General and Explore
remain subagents; title, summary, and compaction remain hidden internal agents.
User-defined agents and permission rules remain stored. When Build exists,
InfiniteOC becomes the default and sole visible primary, hiding Quick and any
other primary choices without deleting them. Subagents remain available.
A disabled Build agent is not recreated. Prompt and agent pickers display the
agent name rather than its internal ID; `build` remains the internal identifier.
The primary agent's system instruction respects requested read-only/planning work;
this is conversational guidance, **not a replacement for permission enforcement**.

No permission rules, tools, approval handlers, sandbox logic, or config permission
merging are changed. Custom Build prompts are preserved as the base, with the
unified workflow appended once after config. The mod never writes upstream, user config, or external assets;
all writes go through the supplied source-worktree API.

`reducedMotion: true` generates a static gradient with no interval. Changing that
option requires reapplying the mod/rebuilding. Animation is presentation-only.
Patches use checked unique anchors and throw on source drift rather than silently
patching unrelated code; rerunning on compatible patched source is supported.

## Verification and suggested integration checks

Run `node --test mods/infiniteoc/test.mjs` from the repository root for source
anchor, idempotence, reduced-motion, theme palette, and permission-rule invariance
checks against the local upstream checkout (all transformations stay in memory).
Then build/typecheck the patched worktree's TUI/core using its own Bun scripts.
Launch with a fresh TUI config to confirm the default purple/pink theme; select
another theme to confirm the user override survives restart. Check wide/narrow
terminals, light/dark mode, and repeated home-screen mounting for timer cleanup.
Inspect the agent endpoint/UI: InfiniteOC must be the visible built-in primary,
with stable `build` ID and unchanged subagents. Exercise a denied command,
approval-required external-directory access, and `.env` reads: restrictions must
remain identical to unmodified source. No interactive runtime/build verification
is claimed by the source-only tests.