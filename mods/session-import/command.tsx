import type { FeatureContext } from "./api"
import { listAntigravitySessions, listClaudeSessions } from "./session-import-lib.mjs"

// /import: browse foreign harness sessions found on this machine and show the
// exact command that continues one in InfiniteOC. Read-only: nothing is
// imported, converted or sent anywhere from here.
export async function run(ctx: FeatureContext) {
  const claude = listClaudeSessions().map((s) => ({ ...s, harness: "claude" as const }))
  const antigravity = listAntigravitySessions().map((s) => ({ ...s, harness: "antigravity" as const }))
  const all = [...claude, ...antigravity]
  if (!all.length) {
    ctx.toast.show({
      variant: "info",
      title: "No foreign sessions",
      message: "No Claude Code sessions (~/.claude/projects) or Antigravity transcripts (~/.gemini/antigravity-cli/brain) on this machine.",
    })
    return
  }
  const picked = await ctx.ui.select({
    title: `Import a session (${all.length} found)`,
    options: [
      ...all.slice(0, 30).map((s) => ({
        title: `${s.harness}: ${(s.title ?? s.id).slice(0, 50)}`,
        value: `${s.harness}:${s.id}`,
        description: `${s.userTurns}u/${s.assistantTurns}a turns`,
      })),
      { title: "Close", value: "close" },
    ],
  })
  if (!picked || picked === "close") return
  const [harness, ...rest] = picked.split(":")
  const id = rest.join(":")
  ctx.ui.set({ size: "large" })
  await ctx.ui.alert({
    title: `Continue ${harness} session ${id.slice(0, 8)}… here`,
    message: [
      "1. In a terminal: infiniteoc serve   (note its backend URL and password)",
      `2. node mods/session-import/import.mjs --import ${id} --from ${harness} --upstream http://127.0.0.1:4096`,
      "   (password via IOC_IMPORT_PASSWORD or OPENCODE_PASSWORD; --dir overrides the session directory)",
      "3. Open the TUI on that backend and pick the imported session in /sessions.",
      "",
      "History imports as ordinary messages (assistant turns marked with their origin); tool calls arrive as short summaries, images are omitted.",
    ].join("\n"),
  })
}
