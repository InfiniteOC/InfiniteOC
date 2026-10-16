# ctx-context

What goes into the model's context. Must come after `infiniteoc` in `infiniteoc.json` (it extends the guidance).

State lives under `$XDG_DATA_HOME/infiniteoc/ctx` (never in the repo): per-project memory.md and glossary.md, per-session pins, caches.
Per-project config (committable) is `.infiniteoc/context.json`:
`{"sqlite": "app.db", "openapi": "api.json", "docs": ["docs"], "logs": {"dev": "dev.log"}, "repos": ["../sibling"]}`

- Tools: memory, repo_map, trace_lookup, type_lookup, log_tail, sql_peek (read-only), openapi_lookup (JSON; YAML under Bun), linked_repo (read-only).
- Commands: /context, /memory (memory + glossary browser), /pins, /pin <file>, /unpin <file|all>, /glossary add|remove|list.
- In context: machine tool versions, dependency versions, glossary, memory, linked repos, pinned files. They are an upstream instruction source (`infiniteoc/ctx`, `core/plugin/infiniteoc-ctx-instruction.ts`, listed in `core/session/context.ts`): the first value sits in the system prompt and a later change (a saved memory, an `npm install`, an edited pin) is appended to the history as an `[InfiniteOC project context update]` message with only the changed sections. Rewriting the system prompt instead made the provider re-read the whole conversation uncached on the next request.
- Request slimming: tool images above 256 KB of base64 (upstream allows 5 MB) are re-encoded as JPEG, at the same size where that fits (a 1280x800 agent_display screenshot does), so screen coordinates stay valid; `media.image` in opencode.json overrides it. Only the newest 4 to 11 tool screenshots are resent; older ones become a note, 8 at a time, so the cached prefix moves once per 8 screenshots instead of with each one. Images the user attached are kept.
- @https://url in a prompt attaches the page (up to 3, 200 KB each).
- Compaction keeps decisions, paths and open TODOs verbatim; subfolder CLAUDE.md is loaded like AGENTS.md on read.
