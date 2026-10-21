# lazy-catalog — build a provider's models when something reads them

At startup OpenCode builds every catalog provider's models (over 9,000 from about 230 providers), then
indexes and deep-freezes them. Only connected providers' models are ever read: the model service and the
model list read available providers only. With a one-provider catalog the first model request came about
340 ms sooner, so most of that work was for providers nobody had connected.

- `models-dev.ts`: `normalize` sets each provider's `models` as a getter that builds the list once, on first
  read (`lazyModels`).
- `plugin/models-dev.ts`: the filtered snapshot and the provider registration keep it lazy. There is one
  registration per snapshot provider, so every Location gets the same definition.
- `plugin/host.ts`: the `add` wrapper copies property descriptors instead of spreading, which would read
  `models`.
- `provider.ts`: a definition whose `models` is a getter gets a `LazyIndex`: a frozen, read-only `Map` that
  builds the shared frozen index on first access. Writes throw, as on that index. There is one per getter
  and provider, so Locations share it. A plain `models` array is indexed at once, exactly as upstream does.

Every provider still has exactly the models it had. Checks:

- Upstream's own tests for providers, models, the models plugin, model plugins, integrations and the tool
  registry (436 tests in 36 files) give the same results with and without this mod.
- `opencode models` lists the same models with no keys (185) and with three env-key providers connected
  (581).
- Time to first model request (mock model, 14 interleaved runs each): 1,590 → 1,377 ms median
  (mean 1,616 → 1,373 ms).

Rollback: remove `./mods/lazy-catalog/index.mjs` from `infiniteoc.json` and rebuild.
