// Resolves the "auto" effort for one Session step. Written to
// packages/core/src/infiniteoc/auto-effort.ts by mods/effort; the session context calls it before
// resolving the model, so the chosen variant drives both the runtime overlay and the recorded ref.
import { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import { SessionHistory } from "../session/history.js"
import { SessionSchema } from "../session/schema.js"
import { AUTO, autoDecision, turnSignals, variantFor, type AutoDecision } from "./effort-lib.js"

type DatabaseService = Database.Interface["db"]
type AvailableModels = () => Effect.Effect<ReadonlyArray<Model.Info>>

/** The variant "auto" last chose per session and why, so request hooks can tell auto's picks from the user's. */
export const lastAuto = new Map<string, AutoDecision & { readonly variant: string }>()

/**
 * The session with its "auto" variant replaced by the concrete variant for the newest turn: its
 * message, attachments and agent, plus the previous turn's message, effort and failures. All of it is
 * fixed once the turn starts, so every step of a turn gets the same effort. Any other selection, or a
 * model without candidates, passes through untouched.
 */
export const autoEffort = (session: SessionSchema.Info, available: AvailableModels, db: DatabaseService) =>
  Effect.gen(function* () {
    const selection = session.model
    if (!selection || selection.variant !== AUTO) {
      lastAuto.delete(session.id)
      return session
    }
    const models = yield* available()
    const model = models.find((item) => item.providerID === selection.providerID && item.id === selection.id)
    if (!model?.variants || model.variants.length === 0) return session
    const turn = yield* SessionHistory.latestTurn(db, session.id)
    const decision = autoDecision(turn ? turnSignals(turn.latest, turn.previous, turn.between, session) : undefined)
    const chosen = variantFor(
      model.variants.map((variant) => variant.id),
      decision.tier,
    )
    if (chosen === undefined) return session
    lastAuto.set(session.id, { ...decision, variant: chosen })
    return { ...session, model: { ...selection, variant: Model.VariantID.make(chosen) } }
  })
