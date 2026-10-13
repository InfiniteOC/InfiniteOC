// InfiniteOC workflows: progress of the open session's workflows in the sidebar (each step with its
// status and model) and a one-line summary in the prompt footer while one runs. Copied to
// packages/tui/src/feature-plugins/system/infiniteoc-workflows.tsx and registered as a builtin by
// mods/workflows. It only reads the workflow files the server writes; /workflows cancels.
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { Workflow } from "../../infiniteoc-features/workflows-dag"
import { listWorkflows } from "../../infiniteoc-features/workflows-store"

const ICON: Record<string, string> = { pending: "·", running: "◐", completed: "✓", failed: "✗", skipped: "↷", cancelled: "⊘", interrupted: "⊘" }
// Finished workflows stay in the sidebar for a while, so their results can be traced.
const RECENT_MS = 15 * 60 * 1000
const finished = (workflow: Workflow) => workflow.steps.filter((step) => !["pending", "running"].includes(workflow.state[step.id].status)).length
const short = (model?: string) => (model ? model.slice(model.indexOf("/") + 1).replace(/#.*/, "") : "default")

export default Plugin.define({
  id: "infiniteoc.workflows",
  setup(context) {
    const theme = context.theme
    const [all, setAll] = createSignal<Workflow[]>([])
    let timer: ReturnType<typeof setInterval> | undefined
    const refresh = () => {
      try {
        setAll(listWorkflows(undefined, 30))
      } catch {}
      // Poll only while a workflow runs; session events and workflow toasts refresh otherwise.
      const running = all().some((workflow) => workflow.status === "running")
      if (running && !timer) timer = setInterval(refresh, 1500)
      if (!running && timer) {
        clearInterval(timer)
        timer = undefined
      }
    }
    refresh()
    const dispose = [
      context.data.on("session.execution.started", refresh),
      context.data.on("session.execution.succeeded", refresh),
      context.data.on("session.execution.failed", refresh),
      context.data.listen(({ details }) => {
        if (details.type === "tui.toast.show" && details.data.title === "Workflow") refresh()
      }),
      () => timer && clearInterval(timer),
    ]

    /** Workflows started by this session's family root or this session, or that this session is a step of. */
    const related = (sessionID: string | undefined) => {
      if (!sessionID) return []
      const root = context.data.session.root(sessionID)
      const now = Date.now()
      return all().filter(
        (workflow) =>
          (workflow.parentSessionID === sessionID ||
            workflow.parentSessionID === root ||
            Object.values(workflow.state).some((state) => state.sessionID === sessionID)) &&
          (workflow.status === "running" || now - (workflow.endedAt ?? workflow.createdAt) < RECENT_MS),
      )
    }

    const color = (status: string) =>
      status === "completed"
        ? theme.text.feedback.success.base
        : status === "failed"
          ? theme.text.feedback.error.base
          : status === "running"
            ? theme.text.base
            : theme.text.muted

    context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        const list = createMemo(() => related(props.sessionID).slice(0, 3))
        return (
          <Show when={list().length > 0}>
            <box>
              <text fg={theme.text.base}>
                <b>Workflows</b>
              </text>
              <For each={list()}>
                {(workflow) => (
                  <box>
                    <text fg={color(workflow.status)} wrapMode="none">
                      {ICON[workflow.status] ?? "?"} {workflow.name} {finished(workflow)}/{workflow.steps.length}
                    </text>
                    <For each={workflow.steps}>
                      {(step) => (
                        <text fg={color(workflow.state[step.id].status)} wrapMode="none">
                          {"  "}
                          {ICON[workflow.state[step.id].status] ?? "?"} {step.id} · {short(workflow.state[step.id].model)}
                        </text>
                      )}
                    </For>
                  </box>
                )}
              </For>
              <text fg={theme.text.muted}>/workflows to inspect or cancel</text>
            </box>
          </Show>
        )
      },
    })

    context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => {
        const line = createMemo(() => {
          const running = related(props.sessionID).filter((workflow) => workflow.status === "running")
          if (running.length === 0) return
          const workflow = running[0]
          const active = workflow.steps
            .filter((step) => workflow.state[step.id].status === "running")
            .map((step) => `${step.id} ${short(workflow.state[step.id].model)}`)
          return `wf ${workflow.name} ${finished(workflow)}/${workflow.steps.length}${active.length ? ` · ${active.join(", ")}` : ""}${running.length > 1 ? ` · +${running.length - 1}` : ""}`
        })
        return (
          <Show when={line()}>
            {(text) => (
              <box flexShrink={0} paddingLeft={1}>
                <text fg={theme.text.muted} wrapMode="none">
                  {text()}
                </text>
              </box>
            )}
          </Show>
        )
      },
    })

    return () => dispose.reverse().forEach((cleanup) => cleanup && cleanup())
  },
})
