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
- `codemode/catalog.ts`: inline budget 2,000 → 500 tokens. Rarely used
  `opencode.*` signatures are then found with the upstream `search(...)` helper
  inside `execute`, as upstream already does for larger catalogs.

Rollback: remove `./mods/lean-context/index.mjs` from `infiniteoc.json` and rebuild.
