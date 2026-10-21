const core = "packages/core/src"

// Startup builds every catalog provider's models (over 9,000 from ~230 providers), then indexes and
// deep-freezes them, although only connected providers' models are ever read (the model service lists
// available providers only). Measured: a one-provider catalog reaches the first request ~340 ms sooner.
// Here a provider's model list is built on first read and its index on first access; every provider
// still has exactly the models it had.

// models-dev.ts: the helper, and normalize builds each provider's models lazily.
export const HELPER = [`export type Snapshot = {
  readonly info: Provider.Info
  readonly models: readonly Model.Info[]
  readonly environment: readonly string[]
}
`, `export type Snapshot = {
  readonly info: Provider.Info
  readonly models: readonly Model.Info[]
  readonly environment: readonly string[]
}

// InfiniteOC lazy-catalog: a provider's models are built the first time something reads them.
export function lazyModels<T extends object>(target: T, build: () => readonly Model.Info[]): T & { readonly models: readonly Model.Info[] } {
  let models: readonly Model.Info[] | undefined
  return Object.defineProperty(target, "models", { enumerable: true, configurable: true, get: () => (models ??= build()) }) as T & {
    readonly models: readonly Model.Info[]
  }
}
`]
export const NORMALIZE_OPEN = [`    const models: Model.Info[] = []
    for (const model of Object.values(item.models)) {`, `    const build = () => {
    const models: Model.Info[] = []
    for (const model of Object.values(item.models)) {`]
export const NORMALIZE_CLOSE = [`    providers.push({ info, models, environment: [...item.env] })`, `    return models
    }
    providers.push(lazyModels({ info, environment: [...item.env] }, build))`]

// plugin/models-dev.ts: the filtered snapshot and the provider registration stay lazy.
export const SNAPSHOTS = [`    .map((provider) => ({
      ...provider,
      models: provider.models.filter(`, `    .map((provider) =>
      ModelsDev.lazyModels({ info: provider.info, environment: provider.environment }, () => provider.models.filter(`]
export const SNAPSHOTS_CLOSE = [`          ),
      ),
    }))
  prepared.set(data, result)`, `          ),
      )),
    )
  prepared.set(data, result)`]
export const REGISTER = [`        providers.add({
          info: { ...provider.info, integrationID: Integration.ID.make(provider.info.id) },
          models: provider.models,
        })`, `        providers.add(registration(provider))`]
// One lazy registration per snapshot provider, so every Location gets the same definition and so shares its index.
export const REGISTRATION = [`const prepared = new WeakMap<readonly ModelsDev.Snapshot[], readonly ModelsDev.Snapshot[]>()`, `const prepared = new WeakMap<readonly ModelsDev.Snapshot[], readonly ModelsDev.Snapshot[]>()

// InfiniteOC lazy-catalog: one lazy registration per snapshot provider, so every Location shares its index.
const makeRegistration = (provider: ModelsDev.Snapshot) =>
  ModelsDev.lazyModels({ info: { ...provider.info, integrationID: Integration.ID.make(provider.info.id) } }, () => provider.models)
const registrations = new WeakMap<ModelsDev.Snapshot, ReturnType<typeof makeRegistration>>()
function registration(provider: ModelsDev.Snapshot) {
  const known = registrations.get(provider)
  if (known) return known
  const made = makeRegistration(provider)
  registrations.set(provider, made)
  return made
}`]

// plugin/host.ts: copy property descriptors instead of spreading, so a lazy models list stays lazy.
export const HOST = [`            add: (definition) =>
              editor.add({
                ...definition,
                sourceConnection:
                  definition.sourceConnection?.type === "credential"
                    ? { ...definition.sourceConnection, id: Credential.ID.make(definition.sourceConnection.id) }
                    : definition.sourceConnection,
              }),`, `            add: (definition) =>
              // InfiniteOC lazy-catalog: descriptors, not a spread, so a lazy models list is not built here.
              editor.add(
                Object.defineProperties({} as typeof definition, {
                  ...Object.getOwnPropertyDescriptors(definition),
                  sourceConnection: {
                    enumerable: true,
                    configurable: true,
                    writable: true,
                    value:
                      definition.sourceConnection?.type === "credential"
                        ? { ...definition.sourceConnection, id: Credential.ID.make(definition.sourceConnection.id) }
                        : definition.sourceConnection,
                  },
                }) as any,
              ),`]

// provider.ts: a read-only map that builds the shared frozen index on first access.
export const LAZY_INDEX = [`const definitions = new WeakMap<readonly Model.Info[], Map<ID, ReadonlyMap<Model.ID, Model.Info>>>()`, `const definitions = new WeakMap<readonly Model.Info[], Map<ID, ReadonlyMap<Model.ID, Model.Info>>>()

// InfiniteOC lazy-catalog: a provider's index is built on first access; most catalog providers are never
// read. Reads go to the shared frozen index; writes throw, as they do on that index.
class LazyIndex extends Map<Model.ID, Model.Info> {
  #source: (() => ReadonlyMap<Model.ID, Model.Info>) | ReadonlyMap<Model.ID, Model.Info>
  constructor(source: () => ReadonlyMap<Model.ID, Model.Info>) {
    super()
    this.#source = source
    Object.freeze(this)
  }
  #map(): ReadonlyMap<Model.ID, Model.Info> {
    if (typeof this.#source === "function") this.#source = this.#source()
    return this.#source
  }
  override get size() {
    return this.#map().size
  }
  override get(key: Model.ID) {
    return this.#map().get(key)
  }
  override has(key: Model.ID) {
    return this.#map().has(key)
  }
  override keys() {
    return this.#map().keys() as MapIterator<Model.ID>
  }
  override values() {
    return this.#map().values() as MapIterator<Model.Info>
  }
  override entries() {
    return this.#map().entries() as MapIterator<[Model.ID, Model.Info]>
  }
  override [Symbol.iterator]() {
    return this.#map()[Symbol.iterator]() as MapIterator<[Model.ID, Model.Info]>
  }
  override forEach(callback: (value: Model.Info, key: Model.ID, map: Map<Model.ID, Model.Info>) => void, thisArg?: unknown) {
    this.#map().forEach((value, key) => callback.call(thisArg, value, key, this))
  }
  override set(): this {
    throw new TypeError("This object has been frozen and should not be mutated")
  }
  override delete(): boolean {
    throw new TypeError("This object has been frozen and should not be mutated")
  }
  override clear(): void {
    throw new TypeError("This object has been frozen and should not be mutated")
  }
}

// A plain models array is indexed at once, as upstream does. A lazily built one (a getter) gets one LazyIndex per
// getter and provider, so Locations that register the same definition share it.
const lazyIndexes = new WeakMap<object, Map<ID, LazyIndex>>()
function lazyIndex(providerID: ID, definition: { readonly models: readonly Model.Info[] }): ReadonlyMap<Model.ID, Model.Info> {
  const read = Object.getOwnPropertyDescriptor(definition, "models")?.get
  if (!read) return index(providerID, definition.models)
  const byProvider = lazyIndexes.get(read) ?? new Map<ID, LazyIndex>()
  lazyIndexes.set(read, byProvider)
  const known = byProvider.get(providerID)
  if (known) return known
  const made = new LazyIndex(() => index(providerID, read.call(definition) as readonly Model.Info[]))
  byProvider.set(providerID, made)
  return made
}`]
export const ADD = [`              models: index(definition.info.id, definition.models),`, `              models: lazyIndex(definition.info.id, definition),`]

export const patches = [
  [`${core}/models-dev.ts`, ...HELPER],
  [`${core}/models-dev.ts`, ...NORMALIZE_OPEN],
  [`${core}/models-dev.ts`, ...NORMALIZE_CLOSE],
  [`${core}/plugin/models-dev.ts`, ...SNAPSHOTS],
  [`${core}/plugin/models-dev.ts`, ...SNAPSHOTS_CLOSE],
  [`${core}/plugin/models-dev.ts`, ...REGISTRATION],
  [`${core}/plugin/models-dev.ts`, ...REGISTER],
  [`${core}/plugin/host.ts`, ...HOST],
  [`${core}/provider.ts`, ...LAZY_INDEX],
  [`${core}/provider.ts`, ...ADD],
]

export default {
  id: "lazy-catalog",
  version: "0.1.0",
  async setup(api) {
    for (const [file, before, after] of patches) await api.patchExact(file, before, after)
  },
}
