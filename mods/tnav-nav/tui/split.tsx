/** @jsxImportSource @opentui/solid */
import { createMemo, createResource, For, Match, onMount, Show, Switch } from "solid-js"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { useStorage } from "../../context/storage"
import { DialogSelect } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { oneLine } from "./logic"

// The session shown beside the main one. Kept in memory: a split is a view, not part of any session.
export function useSplit() {
  const [state, update] = useStorage().memory("tnav-split", { initial: { target: "" } })
  return { target: () => state.target, set: (sessionID: string) => update((draft) => void (draft.target = sessionID)) }
}

/** Trades places: the split session becomes the main view and the current one moves into the panel. */
function swapSplit(context: Plugin.Context, split: ReturnType<typeof useSplit>) {
  const route = context.ui.router.current()
  const target = split.target()
  if (route.type !== "session" || !target) return
  split.set(route.sessionID)
  if (!context.ui.tabs.focus(target)) context.ui.router.navigate({ type: "session", sessionID: target })
  // The panel belongs to one session view, so it is reopened once the other session is on screen.
  setTimeout(() => context.ui.panel.open("split"), 80)
}

/** Pick the session to show beside the current one. */
export function SplitPicker(props: { context: Plugin.Context; sessionID: string; onPick: (sessionID: string) => void }) {
  const [sessions] = createResource(async () => {
    const result: any = await props.context.client.session.list({ limit: 100, order: "desc", parentID: null })
    return (Array.isArray(result) ? result : result.data) as { id: string; title?: string; time: { updated: number } }[]
  })
  const options = createMemo(() =>
    (sessions() ?? [])
      .filter((session) => session.id !== props.sessionID)
      .map((session) => ({
        title: session.title || session.id,
        value: session.id,
        footer: Locale.time(session.time.updated),
        onSelect: (ctx: { clear(): void }) => {
          ctx.clear()
          props.onPick(session.id)
        },
      })),
  )
  return <DialogSelect title="Show beside this session" options={options()} emptyView={<text>{sessions.loading ? "Loading sessions..." : "No other sessions."}</text>} />
}

/** Read-only live view of another session. Swap (s) trades places with the main session. */
export function SplitPanel(props: { context: Plugin.Context; input: PanelInput }) {
  const theme = props.context.theme
  const split = useSplit()
  const id = () => split.target()
  const session = () => props.context.data.session.get(id())
  const messages = () => props.context.data.session.message.list(id())
  const running = () => props.context.data.session.status(id()) === "running"
  let scroll: ScrollBoxRenderable | undefined
  onMount(() => void props.context.data.session.message.sync(id()).catch(() => undefined))
  type Row = { id: string; kind: "user" | "assistant" | "tool" | "error"; text: string }
  const rows = createMemo<Row[]>(() =>
    messages().flatMap((message): Row[] => {
      if (message.type === "user") return [{ id: message.id, kind: "user" as const, text: message.text }]
      if (message.type === "shell") return [{ id: message.id, kind: "tool" as const, text: `$ ${message.command}` }]
      if (message.type !== "assistant") return []
      return message.content.flatMap((part, index): Row[] => {
        if (part.type === "text" && part.text.trim()) return [{ id: `${message.id}:${index}`, kind: "assistant" as const, text: part.text }]
        if (part.type !== "tool") return []
        const input = part.state.input as Record<string, unknown> | string | undefined
        const target = typeof input === "object" && input ? String(input.path ?? input.filePath ?? input.command ?? input.pattern ?? "") : ""
        return [{ id: `${message.id}:${index}`, kind: part.state.status === "error" ? ("error" as const) : ("tool" as const), text: `${part.name} ${oneLine(target).slice(0, 80)}` }]
      })
    }),
  )

  props.context.keymap.layer(() => ({
    mode: "global",
    enabled: () => props.input.focused,
    priority: 2,
    commands: [
      { bind: "up,k", title: "Scroll split up", group: "Split", run: () => void scroll?.scrollBy(-1) },
      { bind: "down,j", title: "Scroll split down", group: "Split", run: () => void scroll?.scrollBy(1) },
      { bind: "pageup,b", title: "Page split up", group: "Split", run: () => void scroll?.scrollBy(-Math.max(1, (scroll?.viewport.height ?? 10) - 2)) },
      { bind: "pagedown,space", title: "Page split down", group: "Split", run: () => void scroll?.scrollBy(Math.max(1, (scroll?.viewport.height ?? 10) - 2)) },
      { bind: "s", title: "Swap split and main session", group: "Split", run: () => swapSplit(props.context, split) },
      { bind: "f", title: "Toggle fullscreen split", group: "Split", run: props.input.toggleFullscreen },
      { bind: "escape,q", title: "Close split", group: "Split", run: props.input.close },
    ],
  }))

  return (
    <box flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} gap={1}>
      <box flexShrink={0} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
          {session()?.title || id()} <span style={{ fg: running() ? theme.text.feedback.warning.base : theme.text.muted }}>{running() ? "running" : "idle"}</span>
        </text>
        <text fg={theme.text.muted} onMouseUp={props.input.close}>
          esc
        </text>
      </box>
      <scrollbox ref={(value: ScrollBoxRenderable) => (scroll = value)} flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom">
        <box gap={1}>
          <Show when={rows().length > 0} fallback={<text fg={theme.text.muted}>No messages yet.</text>}>
            <For each={rows()}>
              {(row) => (
                <Switch>
                  <Match when={row.kind === "user"}>
                    <box border={["left"]} borderColor={theme.text.action.primary.base} paddingLeft={1}>
                      <text fg={theme.text.base}>{row.text}</text>
                    </box>
                  </Match>
                  <Match when={row.kind === "assistant"}>
                    <text fg={theme.text.base} wrapMode="word">
                      {row.text}
                    </text>
                  </Match>
                  <Match when={true}>
                    <text fg={row.kind === "error" ? theme.text.feedback.error.base : theme.text.muted} wrapMode="none">
                      {row.text}
                    </text>
                  </Match>
                </Switch>
              )}
            </For>
          </Show>
        </box>
      </scrollbox>
      <text fg={theme.text.muted} flexShrink={0}>
        read-only  s swap  j/k scroll  f fullscreen  q close
      </text>
    </box>
  )
}
