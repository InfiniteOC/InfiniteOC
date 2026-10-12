/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { jumpTo } from "./jump"
import { openSession } from "./marks"
import { matchesTerms, oneLine, searchEntries, searchTerms, snippet, toEntry, type Entry, type Message } from "./logic"

type Indexed = { updated: number; title: string; entries: Entry[] }
type Value = { sessionID: string; messageID?: string }

// Text of every message per session, kept for the life of the TUI and refreshed when a session changes.
const index = new Map<string, Indexed>()
const CONCURRENCY = 4
const MAX_TEXT = 20_000

const unwrap = <T,>(value: any): T => (value && !Array.isArray(value) && "data" in value ? value.data : value)

/** Fetches any session that is new or changed since it was indexed. Calls `tick` after each one. */
async function refreshIndex(context: Plugin.Context, tick: (done: number, total: number) => void, alive: () => boolean) {
  const listed = unwrap<any[]>(await context.client.session.list({ limit: 200, order: "desc", parentID: null }))
  const stale = listed.filter((session) => index.get(session.id)?.updated !== session.time.updated)
  tick(0, stale.length)
  let done = 0
  const queue = [...stale]
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let session = queue.shift(); session && alive(); session = queue.shift()) {
        try {
          const exported = unwrap<{ messages: Message[] }>(await context.client.session.export({ sessionID: session.id }))
          const entries = exported.messages.flatMap((message) => {
            const entry = toEntry(message)
            return entry ? [{ ...entry, text: entry.text.slice(0, MAX_TEXT) }] : []
          })
          index.set(session.id, { updated: session.time.updated, title: session.title ?? "", entries })
        } catch {
          // A session that cannot be exported is skipped, not fatal.
        }
        tick(++done, stale.length)
      }
    }),
  )
  for (const id of [...index.keys()]) if (!listed.some((session) => session.id === id)) index.delete(id)
  return listed
}

export function FindDialog(props: { context: Plugin.Context; initial?: string }) {
  const dialog = useDialog()
  const [query, setQuery] = createSignal(props.initial ?? "")
  const [progress, setProgress] = createSignal({ done: 0, total: 0, finished: false })
  const [version, setVersion] = createSignal(0)
  let ref: DialogSelectRef<Value> | undefined
  let alive = true
  onCleanup(() => (alive = false))

  onMount(() => {
    dialog.setSize("xlarge")
    if (props.initial) setTimeout(() => ref?.setFilter(props.initial!), 5)
    refreshIndex(
      props.context,
      (done, total) => {
        setProgress({ done, total, finished: false })
        setVersion((value) => value + 1)
      },
      () => alive,
    )
      .then(() => {
        setProgress((value) => ({ ...value, finished: true }))
        setVersion((value) => value + 1)
      })
      .catch(() => setProgress((value) => ({ ...value, finished: true })))
  })

  const options = createMemo((): DialogSelectOption<Value>[] => {
    version()
    const terms = searchTerms(query())
    if (!terms.length) return []
    return [...index.entries()]
      .toSorted((a, b) => b[1].updated - a[1].updated)
      .flatMap(([sessionID, entry]) => {
        const open = (messageID?: string) => (ctx: { clear(): void }) => {
          ctx.clear()
          openSession(props.context, sessionID)
          if (messageID) jumpTo(sessionID, messageID)
        }
        const title = entry.title || sessionID
        const results: DialogSelectOption<Value>[] = []
        if (matchesTerms(title, terms))
          results.push({ title, value: { sessionID }, description: "title match", footer: Locale.time(entry.updated), onSelect: open() })
        for (const hit of searchEntries(entry.entries, query()))
          results.push({
            title: snippet(hit.snippet, terms, 80),
            value: { sessionID, messageID: hit.messageID },
            description: `${hit.role === "user" ? "you" : hit.role} in ${oneLine(title).slice(0, 40)}`,
            footer: Locale.time(entry.updated),
            onSelect: open(hit.messageID),
          })
        return results
      })
      .slice(0, 80)
  })

  const muted = () => props.context.theme.text.muted
  const status = () => {
    const state = progress()
    if (state.finished) return `${index.size} sessions searched`
    return state.total ? `Indexing sessions ${state.done}/${state.total}...` : "Loading sessions..."
  }

  return (
    <DialogSelect
      ref={(value) => (ref = value)}
      title="Find in sessions"
      placeholder="Search message text in all sessions"
      options={options()}
      skipFilter
      onFilter={setQuery}
      emptyView={<text fg={muted()}>{status()}</text>}
      noMatchView={<text fg={muted()}>{progress().finished ? `No matches. ${status()}` : status()}</text>}
      footer={<text fg={muted()}>{status()}</text>}
    />
  )
}
