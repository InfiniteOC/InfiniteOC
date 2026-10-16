import { readFile } from "node:fs/promises"

// Anchor checks fail closed on incompatible upstream revisions.
function replace(source, before, after) {
  if (source.includes(after)) return source
  if (source.split(before).length !== 2) throw new Error(`ctx-context: expected one source anchor: ${before}`)
  return source.replace(before, after)
}

const file = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")

export const guidance = `[Project context]
memory: durable facts (build/test cmds, gotchas, prefs; one line each, never secrets) seen every session. Start unfamiliar repos with repo_map {path?,query?}; trace_lookup on pasted stack first; type_lookup for installed APIs, not memory. log_tail, sql_peek, openapi_lookup, linked_repo read logs/SQLite/OpenAPI/siblings from .infiniteoc/context.json (read-only). Deps, glossary, memory, pins already in context (later changes arrive as "[InfiniteOC project context update]" messages that replace the earlier version); use glossary meanings. @https://url in prompt attaches page. Manage: /memory, /glossary, /pin, /unpin, /pins, /context.`

// Always keeps decisions, paths and open TODOs word for word when a session is compacted.
export const compactionRules = `- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Keep every decision (with its reason), every file path the work touches or depends on, every command that was needed, and every open TODO or unfinished step verbatim. Never paraphrase or merge them. List each open TODO as its own item under Next Move, in the user's words where they gave them. If the summary must be shorter, drop narrative and explanation first, never these.`

export default {
  id: "ctx-context",
  version: "1.0.0",
  async setup(api) {
    const store = await file("store.ts")
    await api.write("packages/core/src/plugin/infiniteoc-ctx-store.ts", store)
    await api.write("packages/core/src/plugin/infiniteoc-ctx-knowledge.ts", await file("knowledge.ts"))
    await api.write("packages/core/src/plugin/infiniteoc-ctx-instruction.ts", await file("instruction.ts"))
    await api.write("packages/core/src/plugin/infiniteoc-ctx.ts", await file("plugin.ts"))
    // Memory, glossary, pins and dependency versions are an instruction source, after upstream's own
    // (most to least shared): the first value sits in the system prompt, changes are appended to the
    // history, so the cached prompt prefix survives them.
    await api.patch("packages/core/src/session/context.ts", (source) => {
      source = replace(source, 'import { SessionStore } from "./store.js"\n', 'import { SessionStore } from "./store.js"\nimport * as InfiniteocCtxInstruction from "../plugin/infiniteoc-ctx-instruction.js"\n')
      return replace(source, "          loaded.builtins,\n          loaded.entries,\n", "          loaded.builtins,\n          InfiniteocCtxInstruction.make(location.directory, sessionID),\n          loaded.entries,\n")
    })
    // Inserted before an upstream line that stays intact, so mods patching the same list still find it.
    await api.patch("packages/core/src/plugin/internal.ts", (source) => {
      source = replace(source, 'import { WarmingPlugin } from "./warming.js"', 'import * as InfiniteocCtx from "./infiniteoc-ctx.js"\nimport { WarmingPlugin } from "./warming.js"')
      return replace(source, "  WarmingPlugin.Plugin,\n", "  InfiniteocCtx.Plugin,\n  WarmingPlugin.Plugin,\n")
    })
    // Smarter compaction: decisions, paths and open TODOs survive verbatim.
    await api.patch("packages/core/src/session/compaction.ts", (source) => {
      source = replace(source, "- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.", compactionRules)
      return replace(source, "Include at most 15, most important first.", "Include at most 30, most important first.")
    })
    // Per-folder rules: upstream loads a subdirectory's AGENTS.md when the agent reads there; CLAUDE.md
    // counts too, except where the same directory has an AGENTS.md.
    await api.patch("packages/core/src/tool/plugin/read.ts", (source) => {
      source = replace(source, "                  targets: [FILENAME],\n", '                  targets: [FILENAME, "CLAUDE.md"],\n')
      return replace(
        source,
        "                if (candidates.length === 0) return\n                yield* sessionInstructions.load({ sessionID: context.sessionID, paths: candidates })",
        `                const nearby = candidates.filter((file) => !file.endsWith("/CLAUDE.md") || !candidates.includes(join(dirname(file), FILENAME)))
                if (nearby.length === 0) return
                yield* sessionInstructions.load({ sessionID: context.sessionID, paths: nearby })`,
      )
    })
    await api.patch("packages/core/src/infiniteoc/guidance.ts", (source) => {
      const marker = "// infiniteoc:guidance-extensions"
      if (source.split(marker).length !== 2) throw new Error("ctx-context: expected one source anchor: InfiniteOC guidance marker")
      if (source.includes("[Project context]")) return source
      return source.replace(marker, () => `infiniteocGuidance.build.push(${JSON.stringify(guidance)})\n${marker}`)
    })
    await api.write("packages/tui/src/infiniteoc-features/ctx-store.ts", store)
    for (const [id, title, slash] of [
      ["context", "Show what fills the context window", "context"],
      ["memory", "Project memory and glossary", "memory"],
      ["pins", "Pinned files", "pins"],
    ])
      api.tui.command({ id, title, slash, category: "Context", source: await file(`tui/${id}.tsx`) })
  },
}
