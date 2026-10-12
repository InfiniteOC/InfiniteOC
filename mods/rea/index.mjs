export const reaGuidance = `[REA reverse engineering]
Use REA only when a claim depends on a shipped binary/package, decompilation, or runtime evidence; for ordinary source-repo analysis use normal repo tools. If REA MCP tools (open_binary, analyze_javascript_application, binary_session) are present, use the connected server's actual tool list and schemas; do not run doctor/setup before every investigation. If tools are absent or stale, diagnose read-only with \`npx -y rea-agents@4.0.1 doctor --client opencode --json\`, then plan with \`setup --client opencode --dry-run --json\`, show exact paths/backups/changes, obtain approval, then apply with \`--yes\` and restart; never auto-apply, never add --install-hopper unless explicitly approved, never install Node/npm/Java/Ghidra. CLI fallback for JS/ASAR needs no engine: \`npx -y rea-agents@4.0.1 analyze-javascript-application /absolute/path --json\`. Route: ASAR/JS tree -> analyze_javascript_application; native exe/lib/archive -> open_binary then focused tools; APK -> inspect_android_package; .NET -> inspect_managed_artifact; browser page -> list_browser_targets. Distinguish observations/inferences/unknowns, cite Evidence IDs, never claim static analysis observed execution. Load skill reverse-engineer-anything when doing REA work.`;

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
