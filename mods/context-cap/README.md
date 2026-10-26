# context-cap — compact before the context gets huge

Automatic compaction starts at about 85% of the model's window. On models with a 1M-token window it never
started: stored sessions grew past 440k tokens, and every step resent all of it. With this mod automatic
compaction starts at `min(upstream's point, cap)`, 200,000 tokens by default.

- `session/compaction.ts`: `calculateCeiling` returns at most the cap. A smaller window, or a `compaction.buffer`
  that compacts sooner, still wins. A model whose window is unknown, which upstream never compacts
  automatically, compacts at the cap too.

Replayed over this machine's stored sessions (10,082 steps), where each compaction costs one uncached request
of the whole context and leaves the measured median of ~47k tokens:

| cap | context tokens processed | estimated input cost | compactions |
|---|---|---|---|
| none (upstream) | 1,039M | 150.5M | 0 |
| 300,000 | −11% | −10% | 4 |
| **200,000** (default) | −21% | −15% | 17 |
| 150,000 | −34% | −23% | 53 |
| 100,000 | −46% | −27% | 128 |

The default is 200k: below 150k, compactions (which keep a summary instead of the full history) climb faster
than the saving. Set it in `infiniteoc.json` and rebuild: `"options": { "contextCap": 150000 }`, or `false` for
none (minimum 64,000). `/compact` still works at any size.

Checked in the built CLI against a recording mock provider, with the cap set to 64,000: five large reads, the
fifth request crossed the cap, the next request was the compaction summary, and the session went on from a
55 KB request.

`infiniteoctx` paging was replayed with tighter settings too and left as it is: keeping 8 steps instead of 15
pages only 1.5% more, and smaller batches (15k) page 4.6% more for twice the cache-breaking batches.

```sh
node --test mods/context-cap/test.mjs
node bin/infiniteoc.mjs feature check context-cap
```

Rollback: `node bin/infiniteoc.mjs feature disable context-cap`, restart.
