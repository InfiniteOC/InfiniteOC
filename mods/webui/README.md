# webui

Build-side part of `infiniteoc serve` / `infiniteoc web`. The commands, the bind and password policy and the
startup auth check live in the launcher (`src/serve.mjs`); see [LAUNCHER.md](../../LAUNCHER.md#serve-and-web).

- **Server password out of tools' reach**: upstream's `serve` deletes `OPENCODE_PASSWORD` /
  `OPENCODE_SERVER_PASSWORD` from its own environment only in `--stdio` mode. In InfiniteOC builds
  (`OPENCODE_CHANNEL=infiniteoc`) it does so in every mode, right after reading it, so the agent's shell commands
  cannot read the password of a server other machines may reach (`packages/cli/src/server-process.ts`).
- **Web UI branding** (only visible when `"options": {"webUi": true}` builds the web UI in):
  - `packages/ui/src/theme/themes/infiniteoc.json`: an "InfiniteOC" theme with the TUI theme's purple
    (`#c084fc` dark / `#9333ea` light) and pink (`#f472b6` / `#db2777`). Upstream finds it by itself
    (`import.meta.glob("./themes/*.json")`).
  - It is the default when no theme is stored: `defaultTheme="infiniteoc"` on the app's `ThemeProvider`
    (`packages/app/src/app.tsx`) and the same fallback in `packages/app/public/oc-theme-preload.js`, which runs before
    the app and would otherwise flash `oc-2`.
  - Its name in the theme picker before the file loads (`packages/ui/src/theme/context.tsx`) and the page title
    (`packages/app/index.html`).

Any upstream theme can still be chosen in the web UI's settings. Nothing else is restyled. Every change is an
`api.patchExact` with a unique anchor in pinned v2.0.21, so an upstream change fails the build instead of being
skipped.

Tests: `node --test mods/webui/test.mjs test/serve.test.mjs`. They check the anchors against `.upstream`, apply the
mod through the real loader in a disposable tree, and run `serve`/`web` through the real launcher against a fake
server binary. Not covered: a real build with the web UI and a browser session (see the caveats in the PR notes).
