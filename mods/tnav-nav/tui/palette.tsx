/** @jsxImportSource @opentui/solid */
import { createResource } from "solid-js"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { Keymap } from "../../context/keymap"
import { useLocation } from "../../context/location"
import { useRoute } from "../../context/route"
import { useSessionTabs } from "../../context/session-tabs"
import type { DialogSelectOption } from "../../ui/dialog-select"
import type { DialogContext } from "../../ui/dialog"
import { createDebouncedSignal } from "../../util/signal"
import { Locale } from "../../util/locale"

const unwrap = (value: any): any[] => (Array.isArray(value) ? value : (value?.data ?? []))

/**
 * Extra command-palette results shown while a filter is typed: sessions (title search), project files
 * and a hand-off to full-text /find. Commands and settings are already in the upstream palette.
 */
export function paletteExtras() {
  const client = useClient()
  const data = useData()
  const route = useRoute()
  const tabs = useSessionTabs()
  const location = useLocation()
  const commands = Keymap.useCommands()
  const [query, setQuery] = createDebouncedSignal("", 150)
  const [remote] = createResource(
    () => query().trim() || undefined,
    async (text) => {
      const directory = (location.ref ?? data.location.default())?.directory
      const [sessions, files] = await Promise.all([
        client.api.session.list({ search: text, limit: 8, order: "desc", parentID: null }).then(unwrap, () => []),
        text.length >= 2 ? client.api.file.find({ query: text, limit: 8, type: "file", location: { directory } }).then(unwrap, () => []) : [],
      ])
      return { text, sessions, files }
    },
  )
  const open = (sessionID: string) => (dialog: DialogContext) => {
    dialog.clear()
    if (tabs.enabled()) tabs.select(sessionID)
    else route.navigate({ type: "session", sessionID })
  }
  return {
    setFilter: setQuery,
    options(filter: string): DialogSelectOption<string>[] {
      const text = filter.trim()
      if (!text) return []
      const needle = text.toLowerCase()
      const known = new Map<string, any>()
      for (const session of data.session.list()) if (!session.parentID && (session.title ?? "").toLowerCase().includes(needle)) known.set(session.id, session)
      const fetched = remote.latest?.text === text ? remote.latest : undefined
      for (const session of fetched?.sessions ?? []) known.set(session.id, session)
      const sessions = [...known.values()]
        .toSorted((a, b) => b.time.updated - a.time.updated)
        .slice(0, 8)
        .map((session) => ({
          title: session.title || session.id,
          description: "Open session",
          category: "Sessions",
          searchText: `${text} ${session.title ?? ""}`,
          searchFooter: `Session ${Locale.time(session.time.updated)}`,
          footer: Locale.time(session.time.updated),
          value: `tnav:session:${session.id}`,
          onSelect: open(session.id),
        }))
      const files = (fetched?.files ?? []).map((file: any) => ({
        title: file.path,
        description: "Insert file reference in prompt",
        category: "Files",
        searchText: `${text} ${file.path}`,
        searchFooter: "File",
        value: `tnav:file:${file.path}`,
        onSelect: (dialog: DialogContext) => {
          dialog.clear()
          commands().find((command) => command.id === "tnav.insert")?.run(`@${file.path}`)
        },
      }))
      const find = {
        title: `Search message text for "${text}"`,
        description: "Full-text search across all sessions",
        category: "Search",
        searchText: text,
        searchFooter: "Full-text",
        value: "tnav:find",
        onSelect: (dialog: DialogContext) => {
          dialog.clear()
          commands().find((command) => command.id === "tnav.find")?.run(text)
        },
      }
      return [...sessions, ...files, ...(text.length >= 3 ? [find] : [])]
    },
  }
}
