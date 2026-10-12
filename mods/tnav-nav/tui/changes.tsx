/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { PatchDiff } from "../../component/patch-diff"
import { useThemes } from "../../context/theme"
import { filetype } from "../../util/filetype"
import { sessionChanges } from "./diffs"

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "patch", "multiedit"])

/** Side pane listing the files this session changed, with the diff of the selected file. Refreshes as edits land. */
export function ChangesPanel(props: { context: Plugin.Context; input: PanelInput }) {
  const themes = useThemes()
  const theme = () => themes.current
  const sessionID = () => props.input.sessionID
  const [selected, setSelected] = createSignal(0)
  let scroll: ScrollBoxRenderable | undefined

  // Changes whenever an edit tool finishes or the run state flips, which is when the diff can have moved.
  const signature = createMemo(() => {
    const done = props.context.data.session.message
      .list(sessionID())
      .flatMap((message) =>
        message.type === "assistant"
          ? message.content.flatMap((part) => (part.type === "tool" && EDIT_TOOLS.has(part.name) && part.state.status === "completed" ? [part.id] : []))
          : [],
      )
    return `${sessionID()}:${done.join(",")}:${props.context.data.session.status(sessionID())}`
  })
  const [diff] = createResource(signature, () => sessionChanges(props.context.client, sessionID()))
  const files = () => diff.latest ?? []
  const total = createMemo(() => files().reduce((sum, file) => ({ add: sum.add + file.additions, del: sum.del + file.deletions }), { add: 0, del: 0 }))
  const current = () => files()[Math.min(selected(), files().length - 1)]
  createEffect(() => {
    current()
    scroll?.scrollTo(0)
  })

  const move = (delta: number) => setSelected((value) => Math.max(0, Math.min(files().length - 1, value + delta)))
  props.context.keymap.layer(() => ({
    mode: "global",
    enabled: () => props.input.focused,
    priority: 2,
    commands: [
      { bind: "up,k", title: "Previous changed file", group: "Changes", run: () => move(-1) },
      { bind: "down,j", title: "Next changed file", group: "Changes", run: () => move(1) },
      { bind: "pagedown,space", title: "Scroll diff down", group: "Changes", run: () => void scroll?.scrollBy(Math.max(1, (scroll?.viewport.height ?? 10) - 2)) },
      { bind: "pageup,b", title: "Scroll diff up", group: "Changes", run: () => void scroll?.scrollBy(-Math.max(1, (scroll?.viewport.height ?? 10) - 2)) },
      { bind: "f", title: "Toggle fullscreen changes", group: "Changes", run: props.input.toggleFullscreen },
      { bind: "escape,q", title: "Close changes", group: "Changes", run: props.input.close },
    ],
  }))

  return (
    <box flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} gap={1}>
      <box flexShrink={0} flexDirection="row" justifyContent="space-between">
        <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
          Changes{" "}
          <span style={{ fg: theme().text.muted }}>
            {files().length} files{" "}
          </span>
          <span style={{ fg: theme().diff.highlight.added }}>+{total().add}</span> <span style={{ fg: theme().diff.highlight.removed }}>-{total().del}</span>
        </text>
        <text fg={theme().text.muted} onMouseUp={props.input.close}>
          esc
        </text>
      </box>
      <Show when={files().length > 0} fallback={<text fg={theme().text.muted}>{diff.loading ? "Loading changes..." : "No file changes in this session yet."}</text>}>
        <scrollbox flexShrink={0} height={Math.min(files().length, 8)}>
          <For each={files()}>
            {(file, index) => (
              <box
                flexDirection="row"
                gap={1}
                backgroundColor={index() === selected() ? theme().background.raised.high : undefined}
                onMouseUp={() => setSelected(index())}
              >
                <text fg={file.status === "added" ? theme().diff.highlight.added : file.status === "deleted" ? theme().diff.highlight.removed : theme().text.muted} flexShrink={0}>
                  {file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M"}
                </text>
                <text fg={index() === selected() ? theme().text.base : theme().text.muted} flexGrow={1} minWidth={0} wrapMode="none">
                  {file.file}
                </text>
                <text fg={theme().diff.highlight.added} flexShrink={0}>+{file.additions}</text>
                <text fg={theme().diff.highlight.removed} flexShrink={0}>-{file.deletions}</text>
              </box>
            )}
          </For>
        </scrollbox>
        <scrollbox ref={(value: ScrollBoxRenderable) => (scroll = value)} flexGrow={1} minHeight={0}>
          <Show when={current()?.patch} fallback={<text fg={theme().text.muted}>No textual diff for this file.</text>}>
            {(patch) => (
              <PatchDiff
                diff={patch()}
                scroll={() => scroll}
                hunkFg={theme().diff.text.hunkHeader}
                view="unified"
                filetype={filetype(current()!.file)}
                syntaxStyle={themes.currentSyntax()}
                showLineNumbers={true}
                width="100%"
                wrapMode="char"
                fg={theme().text.base}
                addedBg={theme().diff.background.added}
                removedBg={theme().diff.background.removed}
                contextBg={theme().diff.background.context}
                addedSignColor={theme().diff.highlight.added}
                removedSignColor={theme().diff.highlight.removed}
                lineNumberFg={theme().diff.lineNumber.text}
                lineNumberBg={theme().diff.background.context}
                addedLineNumberBg={theme().diff.lineNumber.background.added}
                removedLineNumberBg={theme().diff.lineNumber.background.removed}
              />
            )}
          </Show>
        </scrollbox>
      </Show>
      <text fg={theme().text.muted} flexShrink={0}>
        j/k file  space/b scroll  f fullscreen  q close
      </text>
    </box>
  )
}
