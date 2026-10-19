# webui

Build-side part of `infiniteoc serve` / `infiniteoc web`, and InfiniteOC inside the web UI. The commands, the bind
and password policy and the startup auth check live in the launcher (`src/serve.mjs`); see
[LAUNCHER.md](../../LAUNCHER.md#serve-and-web). Listed **last** in `infiniteoc.json`: its web commands cover the
features of every mod applied before it.

- **Server password out of tools' reach**: upstream's `serve` deletes `OPENCODE_PASSWORD` /
  `OPENCODE_SERVER_PASSWORD` from its own environment only in `--stdio` mode. In InfiniteOC builds
  (`OPENCODE_CHANNEL=infiniteoc`) it does so in every mode, right after reading it (`packages/cli/src/server-process.ts`).
- **Theme**: `packages/ui/src/theme/themes/infiniteoc.json` (the TUI theme's purple `#c084fc`/`#9333ea` and pink
  `#f472b6`/`#db2777`) is the default when no theme is stored (`app.tsx`, `oc-theme-preload.js`), named in the picker
  before it loads; any upstream theme can still be chosen.
- **Logo**: the TUI's block-character wordmark (`mods/infiniteoc/wordmark.mjs`, shared with the TUI) converted to SVG
  cell for cell (`wordmark.mjs`: a terminal cell is 1×2, ▀/▄ are halves, shadow cells at 25%, purple→pink gradient).
  It replaces upstream's `Logo`, `Mark`, `Splash` (`packages/ui/src/components/logo.tsx`) and `Wordmark`, so the
  new-session screen, the empty side panel, the error page and the sign-in screen show InfiniteOC. Favicon, Apple
  touch icon and PWA icons (`icons/`, rendered from the "OC" mark) replace the "dev" channel icons the web build
  copies; the page title and the installed-app name are InfiniteOC. Settings › About keeps OpenCode's wordmark and
  credits: that page is upstream's attribution.
- **Server toasts**: InfiniteOC's server features report through `tui.toast.show` events (`/ponytail`, `/goal`,
  workflows, ...). Upstream's web app received them and showed nothing; they are now web toasts.
- **InfiniteOC commands** (palette and `/` in the composer, category InfiniteOC): `/context`, `/octx`, `/memory`
  (memory and glossary: browse, add, remove), `/pins` (pin, unpin), `/workflows` (steps, status, cancel), `/usage`,
  and `/yolo` (upstream's auto-accept toggle). Server commands (`/goal`, `/ponytail`, `/plan`, `/testfirst`,
  `/pin`, `/glossary`, ...) were already listed by upstream. The `auto` effort is in the variant picker.

## How the commands work

One RPC, `infiniteoc` (`run` and `features`, JSON strings in and out), registered by a generated server plugin
(`packages/core/src/plugin/infiniteoc-web.ts`). It serves `views.ts`: server-driven views (title, preformatted
text, selectable items, buttons, a text field) built from the same stores the TUI commands use (ctx-context's,
InfiniteOCTX's, the workflow store, prov-kit's usage). The browser side (`app/`) is one generic dialog that renders
a view and sends back the next action, plus `useInfiniteocWeb`, called once per session screen beside upstream's
command hooks. A feature appears only when its store is in the build, so disabling a mod never breaks the web
build. Session ids are checked before they reach a store; the actions only touch InfiniteOC's own state files.

Not in the web UI yet (TUI only): `/settings` (InfiniteOC settings), `/health`, `/import`, `/display`, `/rea`,
`/serve`, `/local`, `/envdiff`, `/clearall` (the web app has its own tabs) and the TUI's transcript map and status line.

Tests: `node --test mods/webui/test.mjs test/serve.test.mjs`: anchors against `.upstream`, application through the
real loader in a disposable tree, the glyph conversion, the generated sources, and every view against in-memory
stores. Verified in a real browser (headless Chromium) against an isolated server: sign-in, slash suggestions,
`/octx`, `/context`, `/memory` add, the `/ponytail` toast and the new-session wordmark.
