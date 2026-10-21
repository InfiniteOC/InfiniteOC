# fast-boot — less repeated work at startup and on every step

Profiling the server process (`run` against a scripted mock model) showed most
of the startup gap and a large share of each step going to work repeated on
unchanged inputs. This mod removes the repeats and does not change behavior.

Measured with interleaved runs of the same build with and without this mod
(mock model, this checkout):

| | without | with |
|---|---|---|
| time to first model request (16 runs each, median / mean) | 1549 / 1556 ms | 1442 / 1438 ms |
| gap between steps (30-step run, median) | 67 ms | 56 ms |
| wall time of a 30-step run (median) | 3.93 s | 3.38 s |

## Changes

- **`models-dev.ts`: decode the catalog once per launch.** The models.dev cache
  is about 7 MB of JSON with over 9,000 models. Upstream read and decoded it
  twice per launch: once to populate providers, and again in the boot-time
  refresh, which needs only the entry's age and digest. The service now
  remembers the age and digest of the entry it last read or wrote, and the
  refresh loop starts after populate. Startup needs the catalog anyway, so this
  adds no work. If populate fails, the refresh loop still runs. The cache
  format, TTL, fetch and Refreshed events are unchanged. If another process
  refreshes the cache, this one may fetch once more than before, and it then
  picks up the newer catalog instead of keeping its older in-memory copy.
- **`tool/runtime.ts`: convert each Effect tool schema once.** Converting an
  input schema to JSON Schema is costly. Upstream repeated it for every tool on
  each registration, each tool-state fold, each step's tool snapshot and each
  call's input repair. Effect schemas are immutable, so each is now converted
  once per direction. Standard Schema vendors (Zod and others) are still asked
  every time, as upstream does, because a vendor's converter need not be pure.
  Every caller still gets its own copy, so a hook that edits a schema cannot
  change the next request. A failed conversion is not cached, so registration
  still reports it.
- **`integration.ts`: reuse unchanged integration entries.** Every provider
  snapshot (several per step) lists all ~230 integrations. Each list validated
  every entry through `Info.make` and sorted them with `localeCompare`. An entry
  is reused while its state entry, connections and statuses are unchanged, and
  credentials, env and statuses are still read on every call. The sort uses one
  `Intl.Collator`, which gives the same order as `localeCompare` with no
  arguments.
- **`util/wildcard.ts`: compile each permission pattern once.** Permission
  checks match the same few patterns against every tool call, and against
  every skill when the skill catalog is built on each step. Each check used to
  compile a new RegExp. Compiled patterns are now kept, up to 1,000. The flags
  never include `g` or `y`, so a shared RegExp keeps no state between tests.

## Verification

- `mods/fast-boot/test.mjs` checks the anchors against the pinned upstream. It
  also checks that the cached wildcard matches the original on a pattern ×
  input grid, that entries are reused only while their inputs are unchanged,
  and that schema copies are independent.
- Upstream's own tests on the patched tree give the same results as on the
  unpatched tree: models, model plugin, integration, permission, provider,
  tool registry, tool schema, tool execute, Code Mode, input repair and shell
  scan, over 400 tests in total. The few failures in those suites occur without
  this mod too: other mods add effort variants and `required: []`, which those
  tests do not expect.

Rollback: remove `./mods/fast-boot/index.mjs` from `infiniteoc.json` and rebuild.
