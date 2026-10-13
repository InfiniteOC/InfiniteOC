# tool-perf — faster edit/write internals, identical behavior

Three surgical patches to the model-facing file tools, each proven
behavior-identical by old-vs-new equivalence fuzzing (400 seeded cases across
all three match tiers × `replaceAll` on/off):

- `packages/core/src/tool/plugin/edit.ts` — `findLineOccurrences` normalizes
  each line once up front instead of per candidate window (was O(windows ×
  lines) normalizations of the same text).
- `packages/core/src/tool/plugin/edit.ts` — replacement assembly is one
  forward segment join, O(n), instead of re-slicing the whole file per match
  (was O(n·m) on `replaceAll` with m matches).
- `packages/core/src/tool/plugin/write.ts` — the post-write re-read moved
  inside the formatter branch that consumes it; unformatted writes skip one
  fs read. The formatter path still re-reads fresh, so BOM races behave
  exactly as before.

No messages, schemas, tool names, permission ordering, or outputs change.

## Deliberately not changed (verified)

- **edit's permission-first ordering.** `tool-edit.test.ts:344` ("denied edit
  does not disclose whether oldString matches") requires `permission.assert`
  to run even on doomed edits. Skipping the prompt on match failure would leak
  file-content information to denied callers and break that test. One spared
  prompt is not worth a security regression.
- **The provider transport.** `packages/ai/src/route/executor.ts:227-252`
  builds one shared `HttpClient` over `FetchHttpClient` (pooled keep-alive);
  connections are already reused and latency is server-side inference. No safe
  client-side change exists there.
- **read/grep/glob/shell.** Paged reads, ripgrep binary with timeout, and
  output spilling are already optimal; no safe win found. Looked, didn't touch.

## Tests

```sh
node --test mods/tool-perf/test.mjs
node bin/infiniteoc.mjs feature check tool-perf
```

Covers: patch-only-two-files registration, anchor uniqueness on the pinned
source, permission-order preservation, unchanged failure messages, the
equivalence fuzz (asserts every fallback tier was hit, so the proof is not
vacuous), and fail-closed apply (missing/duplicate/repeat anchors).

Enable with `node bin/infiniteoc.mjs feature enable tool-perf`, then rebuild
and restart; rollback with `feature disable tool-perf`.
