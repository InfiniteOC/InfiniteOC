# infiniteoctx

Context paging. Every request resends the whole conversation, and in long sessions old tool outputs
are most of it: on the stored sessions a request carried ~110k tokens of context on average, ~38% of
it tool outputs that the agent had long moved past. InfiniteOCTX takes old, bulky outputs out of the
request and leaves a stub with the tool name, size, first and last lines and a `recall` id; the
`recall` tool returns the output word for word. Nothing is summarized or lost, only paged.

Paging is batched and sticky, because every change to an earlier message makes the provider re-read
the rest of the conversation uncached:

- outputs of the newest 15 assistant steps, outputs under 1,500 characters and outputs of tools the
  agent acts on (skill, memory, question, todo, subagent, workflow, goal_progress, ...) always stay;
- the remaining ones are paged all at once, and only when that frees at least 25,000 tokens;
- once paged, an output stays paged for the session, so requests between batches are identical;
- compaction and side generations replay the session's paging, so their prefix matches the cache.

Replayed over the stored sessions with these settings: ~21% fewer context tokens per request
(194M of 927M), in 76 batches across all sessions. `recall` is only offered once something is paged,
so short sessions carry no extra tool definition.

`/octx` shows what the current session paged and turns paging off (or back on) for it. Settings in
`infiniteoc.json`: `"options": { "infiniteoctx": { "keepSteps": 15, "minChars": 1500, "batchTokens":
25000 } }`, or `"enabled": false`.

State and the exact outputs live under `$XDG_DATA_HOME/infiniteoc/octx/<session>/` (never in the
repository); stores untouched for 30 days are removed. The session history itself is never changed:
paging only shapes what is sent.

Order: listed with the other mods; it places itself after `infinitokensave` and before
`ctx-context`'s request snapshot regardless of list order.

```sh
node --test mods/infiniteoctx/test.mjs
node bin/infiniteoc.mjs feature check infiniteoctx
```

Rollback: `node bin/infiniteoc.mjs feature disable infiniteoctx`, restart.
