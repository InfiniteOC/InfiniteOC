import { readFile } from "node:fs/promises"

// Strict single-anchor replace: every patch inserts around its anchor, so a second application or an
// incompatible upstream fails closed instead of being skipped.
export function replace(source, before, after, label = before) {
  if (typeof source !== "string" || source.split(before).length !== 2)
    throw new Error(`effort: expected one source anchor: ${label}`)
  if (source.includes(after)) throw new Error(`effort: already applied: ${label}`)
  return source.replace(before, () => after)
}

const file = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")
const CORE = "packages/core/src"

/** The newest turn as the automatic effort sees it: that user message, the one before, the assistant messages between. */
export function historySource(source) {
  return replace(
    source,
    '\nexport * as SessionHistory from "./history.js"\n',
    `
/**
 * The newest user message (the current ask, after any compaction), the user message before it, and
 * up to the last 50 assistant messages between the two: everything the automatic effort reads.
 */
export const latestTurn = Effect.fn("SessionHistory.latestTurn")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const users = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(2)
    .all()
    .pipe(Effect.orDie)
  const [newest, before] = users
  if (!newest) return undefined
  const user = (row: typeof newest | undefined) =>
    row
      ? decodeMessageRow(row).pipe(
          Effect.map((message) => (message.type === "user" ? message : undefined)),
          Effect.orElseSucceed(() => undefined),
        )
      : Effect.succeed(undefined)
  const latest = yield* user(newest)
  if (!latest) return undefined
  const previous = yield* user(before)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gte(SessionMessageTable.seq, (before?.seq ?? -1) + 1),
        sql\`\${SessionMessageTable.seq} < \${newest.seq}\`,
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(50)
    .all()
    .pipe(Effect.orDie)
  const between = yield* Effect.forEach(rows.toReversed(), (row) => decodeMessageRow(row).pipe(Effect.orElseSucceed(() => undefined)))
  return { latest, previous, between: between.filter((message) => message?.type === "assistant") }
})

export * as SessionHistory from "./history.js"
`,
    "history module tail",
  )
}

// Every model whose variants are computed here (models.dev and configured providers) also offers
// "auto". mods/infinicode appends its own variant to this list afterwards, so InfiniCode stays last.
export function variantSource(source) {
  source = replace(
    source,
    'import { Model } from "./model.js"\n',
    'import { Model } from "./model.js"\nimport { withAutoEffort } from "./infiniteoc/effort-lib.js"\n',
    "variant.ts import",
  )
  return replace(
    source,
    "  return variants.filter((variant, index) => variants.findIndex((other) => other.id === variant.id) === index)\n",
    "  return withAutoEffort(variants.filter((variant, index) => variants.findIndex((other) => other.id === variant.id) === index))\n",
    "variant.ts resolve return",
  )
}

// "auto" is resolved to a concrete variant before the model is resolved, so the runtime overlay and
// the recorded message ref both see the real tier.
export function contextSource(source) {
  source = replace(
    source,
    'import { Model } from "../model.js"\n',
    'import { Model } from "../model.js"\nimport { autoEffort } from "../infiniteoc/auto-effort.js"\n',
    "context.ts import",
  )
  return replace(
    source,
    "    const resolveModel = (session: SessionSchema.Info) => models.resolve(session, model.available)\n",
    '    // mods/effort: an "auto" selection resolves to a concrete variant from the newest user message.\n    const resolveModel = (session: SessionSchema.Info) =>\n      autoEffort(session, model.available, db).pipe(Effect.flatMap((chosen) => models.resolve(chosen, model.available)))\n',
    "context.ts resolveModel",
  )
}

export function internalSource(source) {
  source = replace(
    source,
    'import { PlanPlugin } from "./plan.js"\n',
    'import { PlanPlugin } from "./plan.js"\nimport * as InfiniteocEffort from "./infiniteoc-effort.js"\n',
    "internal.ts import",
  )
  return replace(
    source,
    "  PlanPlugin.Plugin,\n",
    "  PlanPlugin.Plugin,\n  InfiniteocEffort.Plugin,\n",
    "internal.ts plugin list",
  )
}

export default {
  id: "effort",
  version: "1.0.0",
  async setup(api) {
    await api.write(`${CORE}/infiniteoc/effort-lib.ts`, await file("effort-lib.ts"))
    await api.write(`${CORE}/infiniteoc/auto-effort.ts`, await file("auto-effort.ts"))
    await api.write(`${CORE}/plugin/infiniteoc-effort.ts`, await file("plugin.ts"))
    await api.patch(`${CORE}/variant.ts`, variantSource)
    await api.patch(`${CORE}/session/history.ts`, historySource)
    await api.patch(`${CORE}/session/context.ts`, contextSource)
    await api.patch(`${CORE}/plugin/internal.ts`, internalSource)
  },
}
