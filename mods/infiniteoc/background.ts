// InfiniteOC background registry: the link between background work and the /goal loop.
// Written to packages/core/src/infiniteoc/background.ts by mods/infiniteoc. Background work that
// upstream does not track per session (mods/workflows runs) registers a source here and signals
// progress; the goal plugin asks it what is still running before it re-prompts a turn that ended.
// Plain module state, no imports: process-wide like the workflow runs it describes, and unit-tested.

export type Work = { readonly label: string }
/** wake: the agent should look now (a message for it, a cancel it did not ask for); progress: something moved. */
export type SignalKind = "wake" | "progress"
export type Signal = { readonly seq: number; readonly kind: SignalKind; readonly reason: string }

type Source = (sessionID: string) => ReadonlyArray<Work>
const sources = new Set<Source>()
const signals = new Map<string, Signal[]>()
const KEEP = 20
let seq = 0

/** Adds a source of running work; returns the function that removes it again. */
export function register(source: Source) {
  sources.add(source)
  return () => void sources.delete(source)
}

/** Work still running for the session, from every registered source; a failing source counts as none. */
export function running(sessionID: string): Work[] {
  return [...sources].flatMap((source) => {
    try {
      return [...source(sessionID)]
    } catch {
      return []
    }
  })
}

export function signal(sessionID: string, kind: SignalKind, reason: string) {
  const list = signals.get(sessionID) ?? []
  list.push({ seq: ++seq, kind, reason })
  signals.set(sessionID, list.slice(-KEEP))
}

/** The current sequence number; pass it to since() later to see what happened in between. */
export const cursor = () => seq

export const since = (sessionID: string, after: number): Signal[] => (signals.get(sessionID) ?? []).filter((item) => item.seq > after)

export function forget(sessionID: string) {
  signals.delete(sessionID)
}
