// InfiniteOC /yolo: the runtime-only switch for upstream's auto-approve mode ("autoaccept"), shared by
// the permission context, the session route and the prompt indicator. Never persisted: every TUI
// start begins with it off.
import { createSignal } from "solid-js"

const [enabled, setEnabled] = createSignal(false)
let inherited = () => false

export const yoloEnabled = enabled

/** The permission context reports whether upstream auto-approve (--auto, session.permissions) is on without /yolo. */
export function yoloInherit(source: () => boolean) {
  inherited = source
}

// safe-guard's always-ask gates (protected paths, git push, recursive rm, reset --hard, ...) set one of
// these request messages; auto-approve leaves such requests to the user. Keep in sync with
// mods/safe-guard/safety.ts (mods/yolo/test.mjs checks it).
const SAFETY_GATE = /^Always confirmed by InfiniteOC safety: |^.+ is a protected path \(InfiniteOC safety settings\)\. Confirm to edit it\.$/

/** A pending request that must still be answered by the user while auto-approve is on. */
export const yoloAlwaysAsk = (request: { message?: string }) => SAFETY_GATE.test(request.message ?? "")

// Framework-free handle for the /yolo handler, which may be a live-reloaded bundle without solid-js.
;(globalThis as Record<symbol, unknown>)[Symbol.for("infiniteoc.yolo")] = {
  enabled: () => enabled(),
  inherited: () => inherited(),
  set: (value: boolean) => void setEnabled(value),
}
