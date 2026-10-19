// InfiniteOCTX store: which outputs each session paged, and their exact text for recall. Pure node
// module shared by the core plugin and the /octx command; mods/infiniteoctx writes it to
// packages/core/src/plugin/infiniteoctx-store.ts and packages/tui/src/infiniteoc-features/octx-store.ts.
// Everything lives under $XDG_DATA_HOME/infiniteoc/octx, never in the repository.
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const dataRoot = () => path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "infiniteoc", "octx")

const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "_"
export const sessionDir = (sessionID: string) => path.join(dataRoot(), safe(sessionID))
const stateFile = (sessionID: string) => path.join(sessionDir(sessionID), "state.json")
const outputFile = (sessionID: string, id: string) => path.join(sessionDir(sessionID), "outputs", `${createHash("sha256").update(id).digest("hex").slice(0, 32)}.txt`)

export type State = {
  /** Paged output ids, in the order they were paged. */
  readonly paged: readonly string[]
  /** Set from /octx: nothing is paged and everything paged before is sent in full again. */
  readonly off?: boolean
  /** Characters the paged outputs had, for /octx. */
  readonly chars?: number
}

function save(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, file)
}

export function readState(sessionID: string): State {
  try {
    const value = JSON.parse(readFileSync(stateFile(sessionID), "utf8"))
    return { paged: Array.isArray(value.paged) ? value.paged.filter((id: unknown) => typeof id === "string") : [], off: value.off === true, chars: typeof value.chars === "number" ? value.chars : 0 }
  } catch {
    return { paged: [] }
  }
}

export const writeState = (sessionID: string, state: State) => save(stateFile(sessionID), JSON.stringify(state))

/** Modification time of the session's state, so a long-lived reader notices /octx changes. */
export function stateVersion(sessionID: string) {
  try {
    return statSync(stateFile(sessionID)).mtimeMs
  } catch {
    return 0
  }
}

/** Keeps outputs before they are paged, so recall can always return them. */
export function saveOutputs(sessionID: string, outputs: ReadonlyArray<{ readonly id: string; readonly text: string }>) {
  for (const output of outputs) save(outputFile(sessionID, output.id), output.text)
}

export function readOutput(sessionID: string, id: string): string | undefined {
  try {
    return readFileSync(outputFile(sessionID, id), "utf8")
  } catch {
    return undefined
  }
}

/** Removes the stores of sessions untouched for `days` (their outputs are also in the session history). */
export function pruneOld(days = 30, now = Date.now()) {
  let entries: string[]
  try {
    entries = readdirSync(dataRoot())
  } catch {
    return 0
  }
  let removed = 0
  for (const name of entries) {
    const dir = path.join(dataRoot(), name)
    try {
      if (now - statSync(path.join(dir, "state.json")).mtimeMs < days * 86_400_000) continue
    } catch {
      // A directory without state is an interrupted first batch; it is old if the directory is.
      try {
        if (now - statSync(dir).mtimeMs < days * 86_400_000) continue
      } catch {
        continue
      }
    }
    rmSync(dir, { recursive: true, force: true })
    removed++
  }
  return removed
}

export function describe(state: State) {
  if (state.off) return "Paging is off for this session: every tool output is sent in full."
  if (state.paged.length === 0) return "Nothing is paged out yet. Old tool outputs leave the context in batches once a session gets long; the model gets them back word for word with recall."
  const chars = state.chars ?? 0
  return `${state.paged.length} old tool output${state.paged.length === 1 ? "" : "s"} paged out: about ${Math.round(chars / 4).toLocaleString("en-US")} tokens fewer in every request. The model gets any of them back word for word with recall.`
}
