const core = "packages/core/src"

// Startup reads the models.dev catalog (about 7 MB of JSON, over 9,000 models) from the
// local cache. Upstream reads and decodes it twice per launch: once to populate providers
// and once more in the boot-time refresh, which only needs the entry's age and digest.
// The process now remembers the age and digest of the entry it last read or wrote, and
// the refresh loop starts after populate, so a launch decodes the catalog once.
export const KNOWN = [`      const loadFromCache = Effect.fnUntraced(function* () {
        const value = yield* kv.get(key)
        const cached = Schema.decodeUnknownOption(Cache)(value)
        if (Option.isSome(cached))
          return {
            catalog: cached.value.body as Record<string, SourceProvider>,
            updatedAt: cached.value.updatedAt,
            digest: cached.value.digest,
          }
        if (value !== undefined) yield* kv.remove(key)
      })`, `      // InfiniteOC fast-boot: age and digest of the cache entry this process last read or wrote.
      // The refresh check needs only these, so it does not decode the catalog a second time.
      let known: { readonly updatedAt: number; readonly digest?: string } | undefined
      const loadFromCache = Effect.fnUntraced(function* () {
        const value = yield* kv.get(key)
        const cached = Schema.decodeUnknownOption(Cache)(value)
        if (Option.isSome(cached)) {
          known = { updatedAt: cached.value.updatedAt, digest: cached.value.digest }
          return {
            catalog: cached.value.body as Record<string, SourceProvider>,
            updatedAt: cached.value.updatedAt,
            digest: cached.value.digest,
          }
        }
        if (value !== undefined) yield* kv.remove(key)
      })`]

export const WRITE = [`      const writeCache = Effect.fn("ModelsDev.writeCache")(function* (text: string, digest = bodyDigest(text)) {
        yield* kv.set(key, { updatedAt: Date.now(), digest, body: text }).pipe(`, `      const writeCache = Effect.fn("ModelsDev.writeCache")(function* (text: string, digest = bodyDigest(text)) {
        const entry = { updatedAt: Date.now(), digest }
        yield* kv.set(key, { ...entry, body: text }).pipe(
          Effect.tap(() => Effect.sync(() => (known = entry))),`]

export const REFRESH = [`              const stored = yield* loadFromCache()
              if (!force && stored && Date.now() - stored.updatedAt < Duration.toMillis(ttl)) return`, `              const stored = known ?? (yield* loadFromCache())
              if (!force && stored && Date.now() - stored.updatedAt < Duration.toMillis(ttl)) return`]

export const BOOT = [`        yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced(ttl)), Effect.ignore))`, `        // InfiniteOC fast-boot: populate first (startup needs the catalog anyway), so the first refresh
        // checks the age populate recorded instead of reading and decoding the catalog again.
        yield* Effect.forkScoped(
          cachedGet.pipe(
            Effect.ignoreCause,
            Effect.andThen(refresh().pipe(Effect.repeat(Schedule.spaced(ttl)))),
            Effect.ignore,
          ),
        )`]

// Converting a tool's input schema to JSON Schema is pure but costly, and upstream repeats it for
// every tool on each registration, each tool-state fold, each step's tool snapshot and each call's
// input repair. Each schema object is now converted once per direction. Callers still get their own
// copy, so a hook that edits a schema cannot change the next request.
export const CONVERTED = `// InfiniteOC fast-boot: one conversion per schema object and direction; every caller gets its own copy.
const conversions = { input: new WeakMap<object, unknown>(), output: new WeakMap<object, unknown>() }
const converted = (schema: object, io: "input" | "output", convert: () => JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  let json = conversions[io].get(schema)
  if (json === undefined) {
    json = convert()
    conversions[io].set(schema, json)
  }
  return copyJson(json) as JsonSchema.JsonSchema
}
const copyJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(copyJson)
  if (value === null || typeof value !== "object") return value
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(value)) copy[key] = copyJson((value as Record<string, unknown>)[key])
  return copy
}`

export const SCHEMAS = [`  if (isStandardSchema(schema)) return standardJsonSchema(schema, "input")
  if (!Schema.isSchema(schema)) return schema
  return emptyInputJsonSchema(schema) ?? toJsonSchema(schema)
}

const outputJsonSchema = (schema: Tool.ValueSchema<any>): JsonSchema.JsonSchema => {
  if (isStandardSchema(schema)) return standardJsonSchema(schema, "output")
  return Schema.isSchema(schema) ? toJsonSchema(schema) : schema
}`, `  if (isStandardSchema(schema)) return converted(schema, "input", () => standardJsonSchema(schema, "input"))
  if (!Schema.isSchema(schema)) return schema
  return converted(schema, "input", () => emptyInputJsonSchema(schema) ?? toJsonSchema(schema))
}

const outputJsonSchema = (schema: Tool.ValueSchema<any>): JsonSchema.JsonSchema => {
  if (isStandardSchema(schema)) return converted(schema, "output", () => standardJsonSchema(schema, "output"))
  return Schema.isSchema(schema) ? converted(schema, "output", () => toJsonSchema(schema)) : schema
}

${CONVERTED}`]

// Every provider snapshot (several per step) lists all ~230 integrations, and each list validated every
// one through Info.make and sorted them with String#localeCompare. An Info is now reused while its state
// entry, connections and statuses are unchanged; credentials, env and statuses are still read on every
// call. The sort uses one Intl.Collator, which orders exactly as localeCompare with no arguments.
export const PROJECTED = [`    const project = (entry: Entry, connections: IntegrationConnection.Info[]): Info =>
      Info.make({
        id: entry.ref.id,
        name: entry.ref.name,
        ...(entry.ref.metadata === undefined ? {} : { metadata: entry.ref.metadata }),
        methods: entry.methods,
        connections: connections.map((connection) => {
          const status = statuses.get(statusKey(entry.ref.id, connection))
          return status ? { ...connection, status } : connection
        }),
      })
`, `    const project = (entry: Entry, connections: IntegrationConnection.Info[]): Info =>
      Info.make({
        id: entry.ref.id,
        name: entry.ref.name,
        ...(entry.ref.metadata === undefined ? {} : { metadata: entry.ref.metadata }),
        methods: entry.methods,
        connections: connections.map((connection) => {
          const status = statuses.get(statusKey(entry.ref.id, connection))
          return status ? { ...connection, status } : connection
        }),
      })

    // InfiniteOC fast-boot: reuse an entry's Info while its connections and their statuses are unchanged.
    const projections = new WeakMap<Entry, { key: string; statuses: unknown[]; info: Info }>()
    const projected = (entry: Entry, connections: IntegrationConnection.Info[]): Info => {
      const key = JSON.stringify(connections)
      const current = connections.map((connection) => statuses.get(statusKey(entry.ref.id, connection)))
      const cached = projections.get(entry)
      if (cached && cached.key === key && cached.statuses.every((status, index) => status === current[index]))
        return cached.info
      const info = project(entry, connections)
      projections.set(entry, { key, statuses: current, info })
      return info
    }
    const collator = new Intl.Collator()
`]

export const LIST = [`        return Array.from(state.get().integrations.values(), (entry) =>
          project(entry, resolveConnections(entry, saved.get(entry.ref.id) ?? [])),
        ).toSorted((a, b) => a.name.localeCompare(b.name))`, `        return Array.from(state.get().integrations.values(), (entry) =>
          projected(entry, resolveConnections(entry, saved.get(entry.ref.id) ?? [])),
        ).toSorted((a, b) => collator.compare(a.name, b.name))`]

// Permission checks match the same few patterns against every tool call, and against every skill when
// the skill catalog is built on each step; each check compiled a new RegExp. Compiled patterns are kept
// (up to 1,000). The flags never include "g" or "y", so a shared RegExp holds no state between tests.
export const WILDCARD = [`export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\\\", "/")
  let escaped = pattern
    .replaceAll("\\\\", "/")
    .replace(/[.+^\${}()|[\\]\\\\]/g, "\\\\$&")
    .replace(/\\*/g, ".*")
    .replace(/\\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}`, `// InfiniteOC fast-boot: compile each pattern once.
const compiled = new Map<string, RegExp>()

export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\\\", "/")
  let regex = compiled.get(pattern)
  if (!regex) {
    let escaped = pattern
      .replaceAll("\\\\", "/")
      .replace(/[.+^\${}()|[\\]\\\\]/g, "\\\\$&")
      .replace(/\\*/g, ".*")
      .replace(/\\?/g, ".")

    if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

    regex = new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s")
    if (compiled.size >= 1_000) compiled.clear()
    compiled.set(pattern, regex)
  }
  return regex.test(normalized)
}`]

export const patches = [
  [`${core}/models-dev.ts`, ...KNOWN],
  [`${core}/models-dev.ts`, ...WRITE],
  [`${core}/models-dev.ts`, ...REFRESH],
  [`${core}/models-dev.ts`, ...BOOT],
  [`${core}/tool/runtime.ts`, ...SCHEMAS],
  [`${core}/integration.ts`, ...PROJECTED],
  [`${core}/integration.ts`, ...LIST],
  [`${core}/util/wildcard.ts`, ...WILDCARD],
]

export default {
  id: "fast-boot",
  version: "1.0.0",
  async setup(api) {
    for (const [file, before, after] of patches) await api.patchExact(file, before, after)
  },
}
