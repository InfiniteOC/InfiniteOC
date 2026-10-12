# ctx-context

What goes into the model's context. Must come after `infiniteoc` in `infiniteoc.json` (it extends the guidance).

State lives under `$XDG_DATA_HOME/infiniteoc/ctx` (never in the repo): per-project memory.md and glossary.md, per-session pins, caches.
Per-project config (committable) is `.infiniteoc/context.json`:
`{"sqlite": "app.db", "openapi": "api.json", "docs": ["docs"], "logs": {"dev": "dev.log"}, "repos": ["../sibling"]}`

- Tools: memory, repo_map, trace_lookup, type_lookup, log_tail, sql_peek (read-only), openapi_lookup (JSON; YAML under Bun), linked_repo (read-only).
- Commands: /context, /memory (memory + glossary browser), /pins, /pin <file>, /unpin <file|all>, /glossary add|remove|list.
- Every turn: machine tool versions, dependency versions, glossary, memory, linked repos, pinned files.
- @https://url in a prompt attaches the page (up to 3, 200 KB each).
- Compaction keeps decisions, paths and open TODOs verbatim; subfolder CLAUDE.md is loaded like AGENTS.md on read.
