/** @jsxImportSource @opentui/solid */
import { createMemo, onMount } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import { useStorage } from "../../context/storage"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { jumpTo, lastJumped } from "./jump"
import { oneLine, stepBookmark } from "./logic"

type Mark = { id: string; text: string; at: number }

export function useBookmarks() {
  const [state, update] = useStorage().store("tnav-bookmarks", { initial: { marks: {} as Record<string, Mark[]> } })
  return {
    list: (sessionID: string): readonly Mark[] => state.marks[sessionID] ?? [],
    has: (sessionID: string, messageID: string) => (state.marks[sessionID] ?? []).some((mark) => mark.id === messageID),
    sessions: () => Object.keys(state.marks).filter((id) => state.marks[id]?.length),
    toggle(sessionID: string, messageID: string, text: string) {
      return update((draft) => {
        const list = draft.marks[sessionID] ?? []
        const next = list.some((mark) => mark.id === messageID)
          ? list.filter((mark) => mark.id !== messageID)
          : [...list, { id: messageID, text: oneLine(text).slice(0, 120), at: Date.now() }]
        if (next.length) draft.marks[sessionID] = next
        else delete draft.marks[sessionID]
      })
    },
  }
}

export function openSession(context: Plugin.Context, sessionID: string) {
  if (!context.ui.tabs.focus(sessionID)) context.ui.router.navigate({ type: "session", sessionID })
}

/** Pick any user message of the session; Enter toggles its bookmark and the list stays open. */
export function MarkPicker(props: { context: Plugin.Context; sessionID: string }) {
  const dialog = useDialog()
  const marks = useBookmarks()
  onMount(() => dialog.setSize("large"))
  const options = createMemo((): DialogSelectOption<string>[] =>
    props.context.data.session.message
      .list(props.sessionID)
      .flatMap((message) => (message.type === "user" ? [message] : []))
      .toReversed()
      .map((message) => ({
        title: `${marks.has(props.sessionID, message.id) ? "* " : "  "}${oneLine(message.text)}`,
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: () => void marks.toggle(props.sessionID, message.id, message.text),
      })),
  )
  return (
    <DialogSelect
      title="Bookmark messages (enter toggles, esc closes)"
      options={options()}
      onMove={(option) => jumpTo(props.sessionID, option.value)}
    />
  )
}

/** Bookmarks of the current session first, then every other session that has some. */
export function BookmarkList(props: { context: Plugin.Context; sessionID?: string }) {
  const dialog = useDialog()
  const marks = useBookmarks()
  onMount(() => dialog.setSize("large"))
  const options = createMemo((): DialogSelectOption<{ sessionID: string; id: string }>[] =>
    marks
      .sessions()
      .toSorted((a, b) => (a === props.sessionID ? -1 : b === props.sessionID ? 1 : 0))
      .flatMap((sessionID) => {
        const session = props.context.data.session.get(sessionID)
        const label = sessionID === props.sessionID ? "This session" : (session?.title ?? sessionID)
        return marks.list(sessionID).map((mark) => ({
          title: mark.text || "(empty message)",
          value: { sessionID, id: mark.id },
          category: label,
          footer: Locale.time(mark.at),
          onSelect: (ctx) => {
            ctx.clear()
            if (sessionID !== props.sessionID) openSession(props.context, sessionID)
            jumpTo(sessionID, mark.id)
          },
        }))
      }),
  )
  return (
    <DialogSelect
      title="Bookmarks"
      options={options()}
      emptyView={<text>No bookmarks yet. Click a message and choose Bookmark, or run /mark.</text>}
    />
  )
}

/** Jump to the next or previous bookmark of a session, wrapping around. Returns false if there are none. */
export function stepMark(context: Plugin.Context, sessionID: string, marks: ReturnType<typeof useBookmarks>, direction: 1 | -1) {
  const ids = new Set(marks.list(sessionID).map((mark) => mark.id))
  const order = context.data.session.message.list(sessionID).map((message) => message.id)
  const target = stepBookmark(order, ids, lastJumped(sessionID), direction)
  if (!target) return false
  jumpTo(sessionID, target)
  return true
}
