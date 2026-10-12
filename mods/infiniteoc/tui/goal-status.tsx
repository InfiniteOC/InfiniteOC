// InfiniteOC: shows the active /goal under the prompt ("goal 3/20 · make the tests pass").
// Copied to packages/tui/src/feature-plugins/prompt/goal.tsx by mods/infiniteoc and registered as a
// builtin. State comes from the goal plugin's control messages in the transcript.
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, Show } from "solid-js"
import { ShimmerText } from "../../component/shimmer-text"
import { useConfig } from "../../config"
import { useTheme } from "../../context/theme"

type Message = { type: string; text?: string; description?: string }

export function goalState(messages: ReadonlyArray<Message>) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if ((message.type !== "user" && message.type !== "synthetic") || !message.text?.startsWith("[InfiniteOC goal")) continue
    if (/^\[InfiniteOC goal: (stopped|finished)\]/.test(message.text)) return undefined
    const goal = /^Goal: (.*)$/m.exec(message.text)?.[1]?.trim()
    if (!goal) return undefined
    const continuation = /Continuation (\d+) of (\d+)/.exec(message.text)
    const step = message.text.startsWith("[InfiniteOC goal: verify]") ? "verify" : continuation ? `${continuation[1]}/${continuation[2]}` : "on"
    return { goal, step }
  }
  return undefined
}

export default Plugin.define({
  id: "infiniteoc.prompt.goal",
  setup(context) {
    context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => {
        const theme = useTheme()
        const config = useConfig().data
        const state = createMemo(() => (props.sessionID ? goalState(context.data.session.message.list(props.sessionID)) : undefined))
        const label = () => {
          const value = state()
          if (!value) return ""
          const goal = value.goal.length > 32 ? `${value.goal.slice(0, 31)}…` : value.goal
          return `goal ${value.step} · ${goal}`
        }
        return (
          <Show when={state()}>
            <box flexShrink={1} paddingLeft={1}>
              <Show when={config.animations ?? true} fallback={<text fg={theme.hue.accent[300]} wrapMode="none">{label()}</text>}>
                <ShimmerText fg={theme.hue.interactive[400]} shimmer={theme.hue.accent[200]} wrapMode="none">
                  {label()}
                </ShimmerText>
              </Show>
            </box>
          </Show>
        )
      },
    })
  },
})
