export const reaGuidance = `[REA reverse engineering]
Use REA only for shipped binary/package, decompilation, runtime evidence; else normal repo tools. With REA MCP tools use connected server's actual schemas; don't run doctor/setup every time. If absent/stale: \`npx -y rea-agents@4.0.1 doctor --client opencode --json\` read-only, then \`setup --client opencode --dry-run --json\`, show paths/backups/changes, obtain approval, apply with \`--yes\`; never auto-apply, never add --install-hopper, never install Node/npm/Java/Ghidra. JS/ASAR fallback: \`npx -y rea-agents@4.0.1 analyze-javascript-application /absolute/path --json\`. Route: ASAR/JS->analyze_javascript_application; native exe/lib/archive->open_binary; APK->inspect_android_package; .NET->inspect_managed_artifact; page->list_browser_targets. Separate observations/inferences/unknowns, cite Evidence IDs, never claim static analysis ran it. Load skill reverse-engineer-anything.`;

// mods/infiniteoc writes packages/core/src/infiniteoc/guidance.ts with this extension marker.
const marker = "// infiniteoc:guidance-extensions";

export const REA_PACKAGE = "rea-agents@4.0.1";

export default {
  id: "rea",
  version: "1.0.0",
  async setup(api) {
    const { readFile } = await import("node:fs/promises");
    await api.patch("packages/core/src/infiniteoc/guidance.ts", (source) => {
      if (typeof source !== "string") throw new Error("rea: invalid source");
      if (source.includes("[REA reverse engineering]"))
        throw new Error("rea: already applied; refusing to duplicate");
      if (source.split(marker).length !== 2)
        throw new Error("rea: expected one source anchor: InfiniteOC guidance marker");
      return source.replace(
        marker,
        () => `infiniteocGuidance.build.push(${JSON.stringify(reaGuidance)})\n${marker}`,
      );
    });
    api.tui.command({
      id: "status",
      title: "REA status and setup",
      slash: "rea",
      category: "Mods",
      source: await readFile(new URL("./command.tsx", import.meta.url), "utf8"),
    });
  },
};
