/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup, onMount, Show, type ParentProps } from "solid-js"
import type { InputRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { Keymap } from "../../context/keymap"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { usePromptRef } from "../../context/prompt"
import { useStorage } from "../../context/storage"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"

// Which session title is being edited, and how many sidebars currently show a session's title.
function useTitleState() {
  return useStorage().memory("tnav-title", { initial: { editing: "", sidebars: {} as Record<string, number> } })
}

export function useTitleEdit() {
  const [state, update] = useTitleState()
  return {
    editing: () => state.editing,
    start: (sessionID: string) => update((draft) => void (draft.editing = sessionID)),
    stop: () => update((draft) => void (draft.editing = "")),
    sidebar: (sessionID: string) => (state.sidebars[sessionID] ?? 0) > 0,
  }
}

function TitleInput(props: { sessionID: string }) {
  const data = useData()
  const client = useClient()
  const toast = useToast()
  const theme = useTheme()
  const prompt = usePromptRef()
  const edit = useTitleEdit()
  const [target, setTarget] = createSignal<InputRenderable>()
  const title = () => data.session.get(props.sessionID)?.title ?? ""
  const done = () => {
    edit.stop()
    prompt.current?.focus()
  }
  const save = (value: string) => {
    const next = value.trim()
    if (!next || next === title()) return done()
    void client.api.session
      .update({ sessionID: props.sessionID, title: next })
      .then(done)
      .catch((error) => toast.show({ variant: "error", message: `Failed to rename session: ${errorMessage(error)}` }))
  }
  Keymap.createLayer(() => ({
    target,
    priority: 5,
    enabled: target() !== undefined,
    commands: [{ bind: "escape", title: "Cancel title edit", group: "Session", run: done }],
  }))
  onMount(() =>
    setTimeout(() => {
      const input = target()
      if (!input || input.isDestroyed) return
      input.focus()
    }, 1),
  )
  return (
    <input
      ref={(value: InputRenderable) => setTarget(value)}
      value={title()}
      onSubmit={save as any}
      focusedBackgroundColor={theme.background.formfield.focused}
      textColor={theme.text.formfield.base}
      focusedTextColor={theme.text.formfield.focused}
      cursorColor={theme.text.formfield.focused}
      placeholder="Session title"
      placeholderColor={theme.text.muted}
    />
  )
}

/** Wraps the sidebar title: click it to edit in place. Enter saves, Esc cancels. */
export function InlineTitle(props: ParentProps<{ sessionID: string }>) {
  const renderer = useRenderer()
  const theme = useTheme()
  const [, update] = useTitleState()
  const edit = useTitleEdit()
  const [hover, setHover] = createSignal(false)
  onMount(() => update((draft) => void (draft.sidebars[props.sessionID] = (draft.sidebars[props.sessionID] ?? 0) + 1)))
  onCleanup(() => update((draft) => void (draft.sidebars[props.sessionID] = Math.max(0, (draft.sidebars[props.sessionID] ?? 1) - 1))))
  return (
    <Show
      when={edit.editing() === props.sessionID}
      fallback={
        <box
          backgroundColor={hover() ? theme.decrease(theme.background.raised.base) : undefined}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={() => {
            if (renderer.getSelection()?.getSelectedText()) return
            edit.start(props.sessionID)
          }}
        >
          {props.children}
        </box>
      }
    >
      <TitleInput sessionID={props.sessionID} />
      <text fg={theme.text.muted}>enter save  esc cancel</text>
    </Show>
  )
}

/** Fallback editor above the prompt, shown only when the sidebar (and its title) is hidden. */
export function TitleRow(props: { sessionID: string }) {
  const theme = useTheme()
  const edit = useTitleEdit()
  return (
    <Show when={edit.editing() === props.sessionID && !edit.sidebar(props.sessionID)}>
      <box flexShrink={0} flexDirection="row" paddingLeft={2} paddingRight={2} gap={1}>
        <text fg={theme.text.muted}>Title</text>
        <box flexGrow={1}>
          <TitleInput sessionID={props.sessionID} />
        </box>
        <text fg={theme.text.muted}>enter save  esc cancel</text>
      </box>
    </Show>
  )
}
