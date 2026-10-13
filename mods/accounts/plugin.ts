// InfiniteOC accounts server plugin: opt-in automatic switch to the provider's next stored account
// when a request hits a rate limit or quota. Written to packages/core/src/plugin/infiniteoc-accounts.ts
// by mods/accounts next to infiniteoc-accounts-lib.ts (the pure helpers; see accounts-lib.ts).
import { define } from "@opencode/plugin/effect/plugin"
import { TuiEvent } from "@opencode/schema/tui-event"
import { Effect } from "effect"
import { Bus } from "../bus.js"
import { Credential } from "../credential.js"
import { Integration } from "../integration.js"
import { Provider } from "../provider.js"
import * as lib from "./infiniteoc-accounts-lib.js"

export const Plugin = define({
  id: "infiniteoc.accounts",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    const providers = yield* Provider.Service
    const tried = new Map<string, lib.Tried>()

    // Runs before prov-kit's model fallback (plugin order in internal.ts); a rotated event tells it to stand down.
    yield* ctx.session.hook("retry", (event) =>
      Effect.gen(function* () {
        if (!lib.isAccountLimit(event.error) || !lib.fallbackEnabled(lib.readSettings())) return
        const provider = yield* providers.get(event.model.providerID)
        const integrationID = Integration.ID.make(provider?.integrationID ?? event.model.providerID)
        // Environment-variable connections are not stored accounts; there is nothing to rotate.
        const active = yield* integrations.connection.active(integrationID)
        if (active?.type !== "credential") return
        const stored = yield* credentials.list(integrationID)
        if (stored.length < 2) return
        const ids = lib.track(tried, event.sessionID, active.id, Date.now())
        const next = lib.nextAccount(stored, active.id, ids)
        if (!next) return
        // Upstream resolves the active credential when the model loads for the next attempt.
        yield* credentials.activate(next.id)
        ids.add(next.id)
        ;(event as { accountRotated?: boolean }).accountRotated = true
        event.decision = { retry: true, delay: 500 }
        const from = stored.find((item) => item.id === active.id)?.label
        yield* bus
          .publish(TuiEvent.ToastShow, {
            title: "Account switched",
            message: lib.fallbackMessage(provider?.name ?? integrationID, from, next.label, lib.kindOf(event.error)),
            variant: "warning",
            duration: 8000,
          })
          .pipe(Effect.asVoid)
        yield* Effect.logInfo("InfiniteOC account fallback", { integrationID, credentialID: next.id })
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("InfiniteOC account fallback failed", { cause }))),
    )
  }),
})
