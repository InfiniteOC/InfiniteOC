# lean-context — smaller system prompt on every request

Every model request re-sends the system prompt, so its size costs tokens and
prefill time on each step. Measured with a scripted mock model (one `build`
request, this checkout):

| | before | after |
|---|---|---|
| skill catalog | 16,162 chars | ~3,300 chars |
| whole system prompt (with the workflows trim) | 41,894 chars | 24,141 chars |
| request body | 68.2 KB | 50.2 KB |

- `skill/instructions.ts`: one line per skill, `- id: first sentence` (capped at
  160 chars) instead of five XML lines with the full trigger text. Loading a
  skill still returns all of it, and the change diff still compares full
  descriptions.
- `codemode/catalog.ts`: inline budget 2,000 → 0 tokens. The catalog lists each
  namespace with its tool count (`rea (116 tools, none shown)`) plus the tools
  upstream pins; the rest are found with the upstream `search(...)` helper inside
  `execute`, as large MCP namespaces already were. Measured on this machine's
  config: the system prompt is 885 B smaller on every step and the catalog update
  sent when MCP servers connect 2.8 KB smaller.

Rollback: remove `./mods/lean-context/index.mjs` from `infiniteoc.json` and rebuild.
