import { readFile } from "node:fs/promises"

// Build-side support for `infiniteoc serve` / `infiniteoc web` (the launcher side is src/serve.mjs).
// Branding for the web UI (built in only with options.webUi): a theme file upstream discovers by itself
// (import.meta.glob of themes/*.json), the default theme, its display name and the page title. The user can still
// pick any upstream theme in the web UI's settings.
export const patches = [
  // Upstream drops the server password from its environment only for --stdio; in a foreground `serve` the agent's
  // shell would inherit it. It has been read into a variable just above, so nothing else needs it.
  ["packages/cli/src/server-process.ts", '      if (options.mode === "stdio") {\n        delete process.env.OPENCODE_PASSWORD', '      if (options.mode === "stdio" || OPENCODE_CHANNEL === "infiniteoc") {\n        delete process.env.OPENCODE_PASSWORD'],
  // No theme stored yet: the app starts in InfiniteOC's theme instead of oc-2.
  ["packages/app/src/app.tsx", "      <ThemeProvider\n        onThemeApplied={", '      <ThemeProvider\n        defaultTheme="infiniteoc"\n        onThemeApplied={'],
  // The pre-render script must agree, or every load flashes oc-2 before the app applies the theme.
  ["packages/app/public/oc-theme-preload.js", 'var themeId = localStorage.getItem(key) || "oc-2"', 'var themeId = localStorage.getItem(key) || "infiniteoc"'],
  // Shown in the theme picker before the theme file has loaded.
  ["packages/ui/src/theme/context.tsx", '  "oc-2": "OpenCode",\n', '  "oc-2": "OpenCode",\n  infiniteoc: "InfiniteOC",\n'],
  ["packages/app/index.html", "<title>OpenCode</title>", "<title>InfiniteOC</title>"],
]

export default {
  id: "webui",
  version: "1.0.0",
  async setup(api) {
    await api.write("packages/ui/src/theme/themes/infiniteoc.json", await readFile(new URL("./theme.json", import.meta.url), "utf8"))
    for (const [file, before, after] of patches) await api.patchExact(file, before, after)
  },
}
