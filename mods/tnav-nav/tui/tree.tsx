/** @jsxImportSource @opentui/solid */
import { createMemo, createResource, onMount } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import { DialogFork } from "../../routes/session/dialog-fork"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { forkTree, oneLine, type SessionLike } from "./logic"
import { openSession } from "./marks"

const FORK = "tnav:fork"

/** Fork tree of the current conversation (or every forked conversation from home). */
export function TreeDialog(props: { context: Plugin.Context; sessionID?: string }) {
  const dialog = useDialog()
  onMount(() => dialog.setSize("large"))
  const [sessions] = createResource(async () => {
    const result: any = await props.context.client.session.list({ limit: 500, order: "desc", parentID: null })
    return (Array.isArray(result) ? result : result.data) as SessionLike[]
  })
  const options = createMemo((): DialogSelectOption<string>[] => {
    const rows = forkTree(sessions() ?? [], props.sessionID)
    const fork: DialogSelectOption<string>[] = props.sessionID
      ? [
          {
            title: "Fork this session from a message...",
            value: FORK,
            description: "choose a point in the conversation to branch from",
            onSelect: (ctx) => ctx.replace(() => <DialogFork sessionID={props.sessionID!} />),
          },
        ]
      : []
    return [
      ...fork,
      ...rows.map(({ session, prefix }) => {
        const parent = session.fork ? props.context.data.session.message.get(session.fork.sessionID, session.fork.boundary.messageID) : undefined
        const at = parent && "text" in parent && typeof parent.text === "string" ? ` ${session.fork!.boundary.type} "${oneLine(parent.text).slice(0, 40)}"` : ""
        return {
          title: `${prefix}${session.title || session.id}${session.id === props.sessionID ? "  (this session)" : ""}`,
          value: session.id,
          description: session.fork ? `fork${at}` : "root",
          footer: Locale.time(session.time.updated),
          onSelect: (ctx) => {
            ctx.clear()
            openSession(props.context, session.id)
          },
        } satisfies DialogSelectOption<string>
      }),
    ]
  })
  return (
    <DialogSelect
      title="Session tree"
      options={options()}
      current={props.sessionID}
      emptyView={<text fg={props.context.theme.text.muted}>{sessions.loading ? "Loading sessions..." : "No forked sessions yet. Run /fork or use the first row to branch one."}</text>}
    />
  )
}
