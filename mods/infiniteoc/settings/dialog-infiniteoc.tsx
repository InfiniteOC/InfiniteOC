import { Match, Switch, createSignal, onMount } from "solid-js"
import { useKeyboard, usePaste } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { FadeInText } from "./fade-in-text"
import { Spinner } from "./spinner"
import { loadSettings, saveSettings, saveProvider, deleteProvider, validateProvider, validateTraffic } from "./settings-store"

type Traffic = { mode: string; proxyURL: string; socksHost: string; socksPort: number; noProxy: string }
type Settings = { traffic: Traffic; providers: Record<string, { protocol: string; models: string[] }>; updates?: { mode?: string } }

// One save at a time across every settings view: provider save, traffic save and delete all
// read-modify-write the same files, and a double Enter must not race past the duplicate-ID check.
const [saving, setSaving] = createSignal(false)
// Only the store's own errors (plain Error, no code) carry static, input-free text; fs errors may embed paths.
const reason = (e: unknown) => e instanceof Error && e.constructor === Error && !("code" in e) ? e.message : "Could not write configuration; check file permissions."
// Valid stand-ins for fields not entered yet, so validateProvider rejects a bad field at its own step.
const sample = { protocol: "anthropic", id: "provider", baseURL: "https://example.com", models: "model" }

// Feedback stays inside the dialog: toasts render under its backdrop.
function Status(props: { busy?: boolean; error?: string; notice?: string }) {
  const theme = useTheme().surface("dialog")
  return <Switch>
    <Match when={props.busy}><Spinner color={theme.text.muted}>Saving…</Spinner></Match>
    <Match when={props.error}><FadeInText fg={theme.text.feedback.error.base} backdrop={theme.background.base}>{props.error}</FadeInText></Match>
    <Match when={props.notice}><FadeInText fg={theme.text.feedback.success.base} backdrop={theme.background.base}>{props.notice}</FadeInText></Match>
  </Switch>
}

// OpenTUI 0.5.14 Input/Textarea has no password option. Capture input without
// putting the value in any renderable, selection buffer, placeholder or title.
// Exported for mods/connectors (connector tokens use the same masked input).
export function SecretPrompt(props: { busy: boolean; error: string; onConfirm: (value: string) => void; onCancel: () => void; title?: string; note?: string }) {
  const theme = useTheme().surface("dialog")
  let secret = ""
  const [length, setLength] = createSignal(0)
  const update = (value: string) => { secret = value; setLength(Array.from(secret).length) }
  const back = () => { if (props.busy) return; update(""); props.onCancel() }
  // The keymap sees keys before useKeyboard; without this layer the dialog-level Esc closes everything.
  Keymap.createLayer(() => ({ mode: "modal", priority: 1, commands: [{ bind: "escape", title: "Back", group: "Dialog", run: back }] }))
  usePaste((event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!props.busy) update(secret + new TextDecoder().decode(event.bytes).replace(/[\r\n\0]/g, ""))
  })
  useKeyboard((event) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.eventType === "release" || props.busy) return
    if (event.name === "return") { const value = secret; update(""); if (value) props.onConfirm(value); return }
    if (event.name === "backspace") { update(Array.from(secret).slice(0, -1).join("")); return }
    if (event.ctrl && event.name === "u") { update(""); return }
    if (!event.ctrl && !event.meta && event.sequence && !/[\x00-\x1f\x7f]/.test(event.sequence)) update(secret + event.sequence)
  })
  return <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
    <box flexDirection="row" justifyContent="space-between">
      <text attributes={TextAttributes.BOLD} fg={theme.text.base}>{props.title ?? "Add provider · 5/5 API key"}</text>
      <text fg={theme.text.muted} onMouseUp={back}>esc</text>
    </box>
    <text fg={theme.text.muted}>{props.note ?? "Masked. Stored in a local mode-600 key file, never in settings metadata."}</text>
    <text fg={theme.text.base} selectable={false}>{length() ? "•".repeat(Math.min(length(), 48)) : "Type or paste key"}</text>
    <Status busy={props.busy} error={props.error} />
    <text fg={theme.text.muted}>enter save · esc back · backspace delete · ctrl+u clear</text>
  </box>
}

export function DialogInfiniteOC(props: { notice?: string }) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const [state, setState] = createSignal<Settings>()
  const [failure, setFailure] = createSignal("")
  const [error, setError] = createSignal("")
  const home = (notice?: string) => dialog.replace(() => <DialogInfiniteOC notice={notice} />)
  // Large on every step (replace() resets to medium): medium clips one-line rows and their safety notes.
  onMount(() => { dialog.setSize("large"); void loadSettings().then(setState, (e) => setFailure(reason(e))) })
  const providers = (): Settings["providers"] => state()?.providers ?? {}
  const summary = (id: string) => {
    const count = providers()[id]?.models?.length ?? 0
    return `${providers()[id]?.protocol ?? "unknown"} · ${count} model${count === 1 ? "" : "s"}`
  }

  // A step's next() may throw or return a save; either failure keeps the step open with the reason inline.
  async function run(next: () => unknown) {
    if (saving()) return
    setError("")
    try {
      const pending = next()
      if (pending instanceof Promise) { setSaving(true); await pending }
    } catch (e) { setError(reason(e)) } finally { setSaving(false) }
  }
  function prompt(title: string, value: string, description: string, next: (value: string) => unknown) {
    dialog.replace(() => <DialogPrompt size="large" title={title} value={value} busy={saving()} busyText="Saving…" onCancel={() => home()}
      description={() => <box gap={1}><text fg={theme.text.muted}>{description}</text><Status error={error()} /></box>}
      onConfirm={(input) => void run(() => next(input.trim()))} />)
  }
  function choose(title: string, options: DialogSelectOption<string>[], next: (value: string) => unknown, current?: string) {
    dialog.replace(() => {
      // DialogSelect reads footer twice: inline JSX would build a second, never-mounted Status whose
      // spinner ticks forever. Its Esc ignores locked, and leaving mid-save would hide the save's result.
      const footer = <Status busy={saving()} error={error()} />
      return <DialogSelect title={title} options={options} current={current} locked={saving()} onCancel={() => { if (!saving()) home() }}
        footer={footer} onSelect={(option) => void run(() => next(option.value))} />
    }, undefined, { size: "large" })
  }
  async function saveTraffic(traffic: Traffic) {
    const current = await loadSettings()
    await saveSettings({ ...current, traffic: validateTraffic(traffic) })
    home("Traffic saved · restart InfiniteOC to apply")
  }
  // The launcher reads this when it starts (src/updater.mjs); unknown values mean "auto".
  function updates() {
    const labels: Record<string, string> = { auto: "Install updates at launch after a 5 second countdown (s skips)", ask: "Ask at launch before installing", off: "Never check; run infiniteoc update yourself" }
    choose("InfiniteOC updates", Object.entries(labels).map(([value, description]) => ({ title: value, value, description })), async (mode) => {
      const current = await loadSettings()
      await saveSettings({ ...current, updates: { mode } })
      home(`Updates: ${mode} · applies at the next launch`)
    }, state()?.updates?.mode ?? "auto")
  }
  function traffic() {
    const draft = { ...state()!.traffic }
    const bypass = () => prompt("No-proxy hosts (comma-separated)", draft.noProxy, "Local control traffic is always bypassed. Subprocesses may ignore proxies; Tor does not guarantee anonymity.", (noProxy) => saveTraffic({ ...draft, noProxy }))
    choose("Traffic routing — restart required; not all-process anonymity", [
      { title: "Inherit environment", value: "inherit", description: "Keep current proxy environment" },
      { title: "Direct", value: "direct", description: "Disable launcher-managed proxy routing" },
      { title: "Proxy", value: "proxy", description: "HTTP(S) or SOCKS5 proxy" },
      { title: "Tor", value: "tor", description: "Requires running SOCKS listener; default 127.0.0.1:9050" },
    ], (mode) => {
      draft.mode = mode
      if (mode === "inherit" || mode === "direct") return saveTraffic(draft)
      if (mode === "proxy") {
        // Credentials may be present in an existing URL: never prefill/display it.
        prompt("Proxy URL", "", "Enter http://, https://, socks5:// or socks5h:// URL. Prefer a credential-free local proxy.", (proxyURL) => {
          validateTraffic({ ...draft, proxyURL })
          draft.proxyURL = proxyURL
          bypass()
        })
        return
      }
      prompt("Tor SOCKS host", draft.socksHost, "Tor must already be running. Routing applies to supported network clients, not every tool/process.", (socksHost) => {
        validateTraffic({ ...draft, socksHost })
        draft.socksHost = socksHost
        prompt("Tor SOCKS port", String(draft.socksPort), "Default 9050 (Tor Browser may use 9150).", (socksPort) => {
          draft.socksPort = validateTraffic({ ...draft, socksPort }).socksPort
          bypass()
        })
      })
    }, draft.mode)
  }
  function provider() {
    const draft: Record<string, string> = {}
    const set = (field: string, value: string) => { validateProvider({ ...sample, ...draft, [field]: value }); draft[field] = value }
    const finish = async (apiKey: string) => {
      const result = await saveProvider({ ...draft, apiKey })
      // Store only non-secret identification. Provider configuration is stock
      // opencode.json; existing settings/config entries remain untouched.
      const current = await loadSettings()
      await saveSettings({ ...current, providers: { ...current.providers, [result.id]: { protocol: result.protocol, models: result.models } } })
      home("Provider added · restart InfiniteOC, then choose its model")
    }
    const key = () => choose("Add provider · 5/5 API key", [
      { title: "Environment variable (recommended)", value: "env", description: "Key stays outside configuration" },
      { title: "Enter key (masked)", value: "key", description: "Local mode-600 key file" },
      { title: "No key", value: "none", description: "For unauthenticated local endpoints" },
    ], (mode) => {
      if (mode === "none") return finish("")
      if (mode === "key") { dialog.replace(() => <SecretPrompt busy={saving()} error={error()} onCancel={() => home()} onConfirm={(value) => void run(() => finish(value))} />, undefined, { size: "large" }); return }
      prompt("Add provider · 5/5 API key", "", "Environment variable NAME only, e.g. MY_PROVIDER_API_KEY. Export it before restarting InfiniteOC.", (name) => finish(`{env:${name}}`))
    })
    const models = () => prompt("Add provider · 4/5 Model IDs", "", "Comma or space-separated exact API model IDs. Provider discovery is not automatic.", (value) => { set("models", value); key() })
    const baseURL = () => prompt("Add provider · 3/5 Base URL", "", "HTTP(S) API root, including /v1 if needed. No credentials or query parameters.", (value) => { set("baseURL", value); models() })
    const id = () => prompt("Add provider · 2/5 Provider ID", "", "Letters, digits, hyphens, underscores. Existing provider IDs are not overwritten.", (value) => { set("id", value); baseURL() })
    choose("Add provider · 1/5 Protocol", [
      { title: "Anthropic messages", value: "anthropic" },
      { title: "OpenAI chat completions", value: "openai-completions" },
      { title: "OpenAI responses", value: "openai-responses" },
      { title: "Google Gemini (custom base URL, key optional)", value: "gemini" },
    ], (value) => { set("protocol", value); id() })
  }
  function removeProvider() {
    choose("Delete custom provider", Object.keys(providers()).map((id) => ({ title: id, value: id, footer: summary(id) })), (id) =>
      prompt(`Delete provider "${id}"? Type DELETE to confirm`, "", "Removes it from OpenCode config and InfiniteOC metadata, including its local key file. Restart to apply.", (confirm) => {
        if (confirm !== "DELETE") throw new Error("Type DELETE exactly to confirm")
        return deleteProvider(id).then(() => home("Provider deleted · restart InfiniteOC to apply"))
      }))
  }
  const options = (): DialogSelectOption<string>[] => {
    const current = state()
    if (!current) return [failure() ? { title: "Close", value: "close" } : { title: "Loading settings…", value: "loading" }]
    const t = current.traffic
    const ids = Object.keys(current.providers)
    return [
      // URL.host never includes userinfo, so proxy credentials stay hidden.
      { title: "Traffic", value: "traffic", description: "Proxy or Tor routing", footer: t.mode === "tor" ? `tor · ${t.socksHost}:${t.socksPort}` : t.mode === "proxy" ? `proxy · ${new URL(t.proxyURL).host}` : t.mode },
      { title: "Providers", value: "provider", description: "Add a custom Anthropic or OpenAI endpoint", footer: `${ids.length} custom`, details: ids.map((id) => `${id} · ${summary(id)}`) },
      ...(ids.length ? [{ title: "Delete provider", value: "remove", description: "Remove its config entry and key file" }] : []),
      { title: "Updates", value: "updates", description: "How InfiniteOC updates itself from its git remote", footer: current.updates?.mode ?? "auto" },
      { title: "Close", value: "close" },
    ]
  }
  const footer = <Status error={failure()} notice={props.notice} />
  return <DialogSelect title="InfiniteOC Settings" options={options()} footer={footer} onSelect={(option) => {
    if (option.value === "traffic") traffic()
    if (option.value === "provider") provider()
    if (option.value === "remove") removeProvider()
    if (option.value === "updates") updates()
    if (option.value === "close") dialog.clear()
  }} />
}
