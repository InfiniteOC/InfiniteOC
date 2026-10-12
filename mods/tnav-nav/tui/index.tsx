/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { usePromptRef } from "../../context/prompt"
import { Match, Switch } from "solid-js"
import { ChangesPanel } from "./changes"
import { FindDialog } from "./find"
import { BookmarkList, MarkPicker, stepMark, useBookmarks } from "./marks"
import { Minimap, useMinimapPref } from "./minimap"
import { SplitPanel, SplitPicker, useSplit } from "./split"
import { TitleRow, useTitleEdit } from "./title"
import { exportTranscript } from "./transcript"
import { TreeDialog } from "./tree"
import { detect } from "./voice"
import { VoiceDialog } from "./voice-dialog"

function Commands(props: { context: Plugin.Context }) {
  const context = props.context
  const marks = useBookmarks()
  const minimap = useMinimapPref()
  const title = useTitleEdit()
  const prompt = usePromptRef()
  const sessionID = () => {
    const route = context.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }
  const inSession = () => sessionID() !== undefined
  const split = useSplit()
  const insert = (text: string) => {
    const current = prompt.current?.current
    if (current && text) prompt.current?.set({ ...current, text: `${current.text}${current.text && !current.text.endsWith(" ") ? " " : ""}${text} ` })
    prompt.current?.focus()
  }
  const failed = (title: string) => (error: unknown) =>
    context.ui.toast.show({ variant: "error", title, message: error instanceof Error ? error.message : String(error) })
  const togglePanel = (name: string) => {
    context.ui.dialog.clear()
    if (context.ui.panel.current()?.name === name) context.ui.panel.close()
    else if (!context.ui.panel.open(name)) context.ui.toast.show({ variant: "warning", message: "Open a session first." })
  }
  const openSplit = (target: string) => {
    split.set(target)
    context.ui.panel.open("split")
  }

  const show = (render: () => any) => context.ui.dialog.show(render)
  const step = (direction: 1 | -1) => () => {
    const id = sessionID()
    if (!id) return
    context.ui.dialog.clear()
    if (!stepMark(context, id, marks, direction)) context.ui.toast.show({ variant: "info", message: "No bookmarks in this session. Run /mark to add some." })
  }
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        // Dialogs render outside the prompt context, so they hand text over through this command.
        id: "tnav.insert",
        title: "Insert text in prompt",
        run: (input) => insert(input ?? ""),
      },
      {
        id: "tnav.find",
        title: "Find text in all sessions",
        description: "Full-text search across stored sessions",
        group: "Session",
        slash: { name: "find", arguments: true },
        palette: true,
        run: (input) => show(() => <FindDialog context={context} initial={input?.trim() || undefined} />),
      },
      {
        id: "tnav.tree",
        title: "Session tree (forks and branches)",
        group: "Session",
        slash: { name: "tree", aliases: ["branches"] },
        palette: true,
        run: () => show(() => <TreeDialog context={context} sessionID={sessionID()} />),
      },
      {
        id: "tnav.mark",
        title: "Bookmark messages",
        group: "Session",
        slash: { name: "mark" },
        palette: true,
        enabled: inSession,
        run: () => show(() => <MarkPicker context={context} sessionID={sessionID()!} />),
      },
      {
        id: "tnav.bookmarks",
        title: "Show bookmarks",
        group: "Session",
        slash: { name: "bookmarks", aliases: ["marks"] },
        palette: true,
        run: () => show(() => <BookmarkList context={context} sessionID={sessionID()} />),
      },
      { id: "tnav.bookmark.next", title: "Next bookmark", group: "Session", slash: { name: "mark-next" }, palette: true, enabled: inSession, bind: "alt+]", run: step(1) },
      { id: "tnav.bookmark.prev", title: "Previous bookmark", group: "Session", slash: { name: "mark-prev" }, palette: true, enabled: inSession, bind: "alt+[", run: step(-1) },
      {
        id: "tnav.minimap",
        title: "Toggle session minimap",
        description: "Strip of turns, edits and errors above the prompt",
        group: "Session",
        slash: { name: "minimap" },
        palette: true,
        run: () => {
          context.ui.dialog.clear()
          void minimap.toggle()
        },
      },
      {
        id: "tnav.changes",
        title: "Toggle live changes panel",
        description: "Files changed in this session with their diffs, updated as edits land",
        group: "Session",
        slash: { name: "changes", aliases: ["livediff"] },
        palette: true,
        enabled: inSession,
        run: () => togglePanel("changes"),
      },
      {
        id: "tnav.split",
        title: "Split view: show another session beside this one",
        group: "Session",
        slash: { name: "split" },
        palette: true,
        enabled: inSession,
        run: () => {
          if (context.ui.panel.current()?.name === "split") return togglePanel("split")
          const main = sessionID()!
          show(() => <SplitPicker context={context} sessionID={main} onPick={openSplit} />)
        },
      },
      {
        id: "tnav.transcript",
        title: "Export transcript with diffs (Markdown or HTML)",
        group: "Session",
        slash: { name: "transcript", arguments: true },
        palette: true,
        enabled: inSession,
        run: (input) => {
          context.ui.dialog.clear()
          exportTranscript(context, sessionID()!, input).catch(failed("/transcript failed"))
        },
      },
      {
        id: "tnav.voice",
        title: "Voice input (local whisper)",
        group: "Prompt",
        slash: { name: "voice" },
        palette: true,
        run: () => {
          const setup = detect()
          if (!setup.ok) return void context.ui.dialog.alert({ title: "Voice input unavailable", message: setup.message })
          show(() => <VoiceDialog setup={setup} onText={insert} />)
        },
      },
      {
        id: "tnav.title",
        title: "Edit session title inline",
        group: "Session",
        slash: { name: "title" },
        palette: true,
        enabled: inSession,
        run: () => {
          context.ui.dialog.clear()
          title.start(sessionID()!)
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "infiniteoc.tnav",
  setup(context) {
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
    context.ui.slot({
      append: "session.panel",
      render: (input) => (
        <Switch>
          <Match when={input.name === "changes"}>
            <ChangesPanel context={context} input={input} />
          </Match>
          <Match when={input.name === "split"}>
            <SplitPanel context={context} input={input} />
          </Match>
        </Switch>
      ),
    })
    context.ui.slot({
      append: "session.composer.top",
      render: (input) => (
        <>
          <TitleRow sessionID={input.sessionID} />
          <Minimap context={context} sessionID={input.sessionID} />
        </>
      ),
    })
  },
})
