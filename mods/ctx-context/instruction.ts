// InfiniteOC ctx as a session instruction source. Written to packages/core/src/plugin/infiniteoc-ctx-instruction.ts
// by mods/ctx-context and listed in session/context.ts next to upstream's instruction sources.
// Upstream keeps the first value of each source in the system prompt and appends later changes to the
// history as short update messages, so saving a memory, installing a dependency or editing a pinned file
// no longer rewrites the prompt prefix (which made the provider re-read the whole conversation uncached).
import { Effect, Schema } from "effect"
import path from "path"
import { Instructions } from "../instructions/index.js"
import * as K from "./infiniteoc-ctx-knowledge.js"
import * as Store from "./infiniteoc-ctx-store.js"

let libraryCache: { root: string; at: number; text: string | undefined } | undefined
const libraries = (root: string) => {
  if (libraryCache?.root === root && Date.now() - libraryCache.at < 30_000) return libraryCache.text
  libraryCache = { root, at: Date.now(), text: K.libraries(root) }
  return libraryCache.text
}

let machine: string | undefined

const PINS = "The user pinned these files; their current content follows and is updated when a file changes (/unpin removes one)."
const PIN = "pin:"

/** Section key to text; pins are one key each. Every section is optional and read independently. */
export type Sections = Record<string, string>

const attempt = <A>(read: () => A | undefined) => {
  try {
    return read()
  } catch {
    return undefined
  }
}

export function contextSections(root: string, sessionID: string): Sections {
  const newest = (items: string[], limit: number) => {
    let used = 0
    const kept = items.toReversed().filter((item) => (used += item.length + 3) <= limit).toReversed()
    return kept.map((item) => `- ${item}`).join("\n")
  }
  const sections: Sections = {}
  const set = (key: string, text: string | undefined) => {
    if (text) sections[key] = text
  }
  set("machine", attempt(() => (machine ??= K.machineProfile(path.join(Store.dataRoot(), "machine.json")))))
  set("libraries", attempt(() => libraries(root)))
  set("glossary", attempt(() => {
    const glossary = Store.listItems(Store.glossaryFile(root))
    return glossary.length ? `Project glossary (terms as this project defines them; the user manages it with /glossary):\n${newest(glossary, 4000)}` : undefined
  }))
  set("memory", attempt(() => {
    const memory = Store.listItems(Store.memoryFile(root))
    return memory.length ? `Project memory (facts earlier sessions saved with the memory tool; the user edits it with /memory). Treat as hints and verify against the code before relying on them:\n${newest(memory, 8000)}` : undefined
  }))
  set("repos", attempt(() => {
    const repos = (Store.readConfig(root).repos ?? []).map((repo) => Store.resolveIn(root, repo))
    return repos.length ? `Linked read-only repositories (use the linked_repo tool to list, read or grep them; never edit them):\n${repos.map((repo) => `- ${path.basename(repo)}: ${repo}`).join("\n")}` : undefined
  }))
  for (const [label, block] of attempt(() => Store.pinBlocks(sessionID, root)) ?? []) sections[`${PIN}${label}`] = block
  return sections
}

const ORDER = ["machine", "libraries", "glossary", "memory", "repos"]
const TITLES: Record<string, string> = { machine: "Installed tools", libraries: "Dependency versions", glossary: "Project glossary", memory: "Project memory", repos: "Linked repositories" }
const pinKeys = (sections: Sections) => Object.keys(sections).filter((key) => key.startsWith(PIN))

export function renderInitial(sections: Sections) {
  const pins = pinKeys(sections)
  return [...ORDER.flatMap((key) => (sections[key] ? [sections[key]] : [])), ...(pins.length ? [[PINS, ...pins.map((key) => sections[key])].join("\n")] : [])].join("\n\n")
}

/** Only the sections that changed; each replaces its earlier version. */
export function renderChanged(previous: Sections, current: Sections) {
  const parts: string[] = []
  for (const key of ORDER) {
    if (previous[key] === current[key]) continue
    parts.push(current[key] ?? `${TITLES[key]}: now empty.`)
  }
  const pins: string[] = []
  for (const key of pinKeys(current)) if (previous[key] !== current[key]) pins.push(current[key])
  for (const key of pinKeys(previous)) if (!(key in current)) pins.push(`<pinned path="${key.slice(PIN.length)}">(unpinned)</pinned>`)
  if (pins.length) parts.push([PINS, ...pins].join("\n"))
  if (!parts.length) parts.push("Project context refreshed; nothing relevant changed.")
  return `[InfiniteOC project context update: these sections replace their earlier versions]\n\n${parts.join("\n\n")}`
}

/** The text last read for each session, so /context can attribute its size. */
export const lastRendered = new Map<string, string>()

export const make = (directory: string, sessionID: string) => {
  const root = Store.projectRoot(directory)
  return Instructions.make({
    key: Instructions.Key.make("infiniteoc/ctx"),
    codec: Schema.toCodecJson(Schema.Record(Schema.String, Schema.String)),
    // Never unavailable: that would block a new session. A failing section is just left out.
    read: Effect.sync(() => {
      const sections = contextSections(root, sessionID)
      if (!Object.keys(sections).length) {
        lastRendered.delete(sessionID)
        return Instructions.removed
      }
      lastRendered.set(sessionID, renderInitial(sections))
      return sections
    }),
    render: {
      initial: renderInitial,
      changed: renderChanged,
      removed: () => "[InfiniteOC project context update] Memory, glossary, pins and dependency notes no longer apply.",
    },
  })
}
