// Resolves the "auto" effort for one Session step. Written to
// packages/core/src/infiniteoc/auto-effort.ts by mods/effort; the session context calls it before
// resolving the model, so the chosen variant drives both the runtime overlay and the recorded ref.
import { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import { SessionHistory } from "../session/history.js"
import { SessionSchema } from "../session/schema.js"
import { AUTO, chooseEffort } from "./effort-lib.js"

type DatabaseService = Database.Interface["db"]
type AvailableModels = () => Effect.Effect<ReadonlyArray<Model.Info>>

/**
 * The session with its "auto" variant replaced by the concrete variant for the newest user message.
 * Any other selection, or a model without candidates, passes through untouched.
 */
export const autoEffort = (session: SessionSchema.Info, available: AvailableModels, db: DatabaseService) =>
  Effect.gen(function* () {
    const selection = session.model
    if (!selection || selection.variant !== AUTO) return session
    const models = yield* available()
    const model = models.find((item) => item.providerID === selection.providerID && item.id === selection.id)
    if (!model?.variants || model.variants.length === 0) return session
    const message = yield* SessionHistory.latestUserMessage(db, session.id)
    const chosen = chooseEffort(
      model.variants.map((variant) => variant.id),
      message?.text,
    )
    if (chosen === undefined) return session
    return { ...session, model: { ...selection, variant: Model.VariantID.make(chosen) } }
  })
