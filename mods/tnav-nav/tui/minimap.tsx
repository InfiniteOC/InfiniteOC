/** @jsxImportSource @opentui/solid */
import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import { useStorage } from "../../context/storage"
import { jumpTo } from "./jump"
import { useBookmarks } from "./marks"
import { minimap, minimapCounts, type CellKind } from "./logic"

const GLYPH: Record<CellKind, string> = { user: "●", assistant: "·", edit: "+", error: "x", shell: "$" }

export function useMinimapPref() {
  const [prefs, update] = useStorage().store("tnav-prefs", { initial: { minimap: true } })
  return { enabled: () => prefs.minimap !== false, toggle: () => update((draft) => void (draft.minimap = !(draft.minimap !== false))) }
}

/** One-row strip above the prompt: a cell per turn, coloured by what happened. Click a cell to jump. */
export function Minimap(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const dimensions = useTerminalDimensions()
  const pref = useMinimapPref()
  const marks = useBookmarks()
  const messages = () => props.context.data.session.message.list(props.sessionID)
  const cells = createMemo(() =>
    minimap(messages(), new Set(marks.list(props.sessionID).map((mark) => mark.id)), Math.max(8, Math.min(100, dimensions().width - 44))),
  )
  const counts = createMemo(() => minimapCounts(messages()))
  const color = (kind: CellKind) =>
    kind === "user" ? theme.text.action.primary.base : kind === "edit" ? theme.text.feedback.success.base : kind === "error" ? theme.text.feedback.error.base : theme.text.muted
  return (
    <Show when={pref.enabled() && cells().length > 0}>
      <box flexShrink={0} height={1} flexDirection="row" paddingLeft={2} gap={0}>
        <text fg={theme.text.muted}>map </text>
        <For each={cells()}>
          {(cell) => (
            <text fg={cell.marked ? theme.hue.accent[300] : color(cell.kind)} onMouseUp={() => jumpTo(props.sessionID, cell.messageID)}>
              {cell.marked ? "◆" : GLYPH[cell.kind]}
            </text>
          )}
        </For>
        <text fg={theme.text.muted}>{`  ${counts().turns} turns  ${counts().edits} edits  ${counts().errors} errors`}</text>
      </box>
    </Show>
  )
}
