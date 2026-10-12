/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { Spinner } from "../../component/spinner"
import { useDialog } from "../../ui/dialog"
import { startRecording, type Recording, type Setup } from "./voice"

type State = "starting" | "recording" | "transcribing" | "failed"

/** Records until Enter, transcribes locally, and hands the text to `onText`. Esc cancels and discards the audio. */
export function VoiceDialog(props: { setup: Extract<Setup, { ok: true }>; onText: (text: string) => void }) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const [state, setState] = createSignal<State>("starting")
  const [message, setMessage] = createSignal("")
  const [seconds, setSeconds] = createSignal(0)
  let recording: Recording | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    dialog.setSize("medium")
    startRecording(props.setup).then(
      (value) => {
        recording = value
        setState("recording")
        timer = setInterval(() => setSeconds((value) => value + 1), 1000)
      },
      (error) => {
        setMessage(error instanceof Error ? error.message : String(error))
        setState("failed")
      },
    )
  })
  onCleanup(() => {
    if (timer) clearInterval(timer)
    if (state() === "recording") recording?.cancel()
  })

  const stop = () => {
    if (state() !== "recording" || !recording) return
    const active = recording
    clearInterval(timer)
    setState("transcribing")
    active.stop().then(
      (text) => {
        dialog.clear()
        if (text) props.onText(text)
      },
      (error) => {
        setMessage(error instanceof Error ? error.message : String(error))
        setState("failed")
      },
    )
  }
  Keymap.createLayer(() => ({
    mode: "modal",
    priority: 1,
    enabled: state() === "recording",
    commands: [{ bind: "return", title: "Stop recording and transcribe", group: "Dialog", run: stop }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
          Voice input
        </text>
        <text fg={theme.text.muted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={state() === "failed"}>
        <text fg={theme.text.feedback.error.base}>{message()}</text>
      </Show>
      <Show when={state() === "starting" || state() === "transcribing"}>
        <Spinner color={theme.text.muted}>{state() === "starting" ? "Starting microphone..." : "Transcribing locally..."}</Spinner>
      </Show>
      <Show when={state() === "recording"}>
        <text fg={theme.text.feedback.error.base}>{`Recording ${seconds()}s`}</text>
        <text fg={theme.text.muted}>Speak now. Enter stops and inserts the text into the prompt; Esc discards.</text>
      </Show>
    </box>
  )
}
