import { createSignal, onMount } from "solid-js"
import { useKeyboard, usePaste } from "@opentui/solid"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { loadSettings, saveSettings, saveProvider, deleteProvider, validateProvider, validateTraffic } from "./settings-store"

type Traffic = { mode: string; proxyURL: string; socksHost: string; socksPort: number; noProxy: string }
type Settings = { traffic: Traffic; providers: Record<string, { protocol: string; models: string[] }> }
type ProviderDraft = { id: string; protocol: string; baseURL: string; models: string; apiKey: string }

// OpenTUI 0.5.14 Input/Textarea has no password option. Capture input without
// putting the value in any renderable, selection buffer, placeholder or title.
function SecretPrompt(props: { onConfirm: (value: string) => void; onCancel: () => void }) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  let secret = ""
  const [length, setLength] = createSignal(0)
  const update = (value: string) => { secret = value; setLength(Array.from(secret).length) }
  onMount(() => dialog.setSize("medium"))
  usePaste((event) => {
    event.preventDefault()
    event.stopPropagation()
    update(secret + new TextDecoder().decode(event.bytes).replace(/[\r\n\0]/g, ""))
  })
  useKeyboard((event) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.eventType === "release") return
    if (event.name === "escape") { update(""); props.onCancel(); return }
    if (event.name === "return") { const value = secret; update(""); props.onConfirm(value); return }
    if (event.name === "backspace") { update(Array.from(secret).slice(0, -1).join("")); return }
    if (event.ctrl && event.name === "u") { update(""); return }
    if (!event.ctrl && !event.meta && event.sequence && !/[\x00-\x1f\x7f]/.test(event.sequence)) update(secret + event.sequence)
  })
  return <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
    <text fg={theme.text.base}>API key (masked)</text>
    <text fg={theme.text.muted}>Stored in a local mode-600 key file, never in settings metadata.</text>
    <text fg={theme.text.base} selectable={false}>{length() ? "•".repeat(Math.min(length(), 48)) : "Type or paste key"}</text>
    <text fg={theme.text.muted}>enter submit · esc cancel · backspace delete · ctrl+u clear</text>
  </box>
}

export function DialogInfiniteOC() {
  const dialog = useDialog()
  const toast = useToast()
  const [state, setState] = createSignal<Settings>()
  const fail = () => toast.show({ variant: "error", message: "Unable to save. Check strict JSON configuration, unique provider ID, valid fields and file permissions. No changes to traffic are active until restart." })
  const home = () => dialog.replace(() => <DialogInfiniteOC />)
  onMount(() => { void loadSettings().then(setState).catch(() => toast.show({ variant: "error", message: "Cannot read InfiniteOC settings. Fix invalid JSON or file permissions before saving." })) })

  function prompt(title: string, value: string, description: string, next: (value: string) => void) {
    dialog.replace(() => <DialogPrompt title={title} value={value} description={() => <text>{description}</text>} onCancel={home} onConfirm={next} />)
  }
  function choose(title: string, options: { title: string; value: string; description?: string }[], next: (value: string) => void) {
    dialog.replace(() => <DialogSelect title={title} options={options} onSelect={(option) => next(option.value)} />)
  }
  async function trafficSave(traffic: Traffic) {
    try {
      const current = await loadSettings()
      await saveSettings({ ...current, traffic: validateTraffic(traffic) })
      toast.show({ variant: "success", message: "Traffic settings saved. Restart InfiniteOC to apply. This is routing, not all-process anonymity." })
      home()
    } catch { fail() }
  }
  function traffic() {
    choose("Traffic routing — restart required; not all-process anonymity", [
      { title: "Inherit environment", value: "inherit", description: "Keep current proxy environment" },
      { title: "Direct", value: "direct", description: "Disable launcher-managed proxy routing" },
      { title: "Proxy", value: "proxy", description: "HTTP(S) or SOCKS5 proxy" },
      { title: "Tor", value: "tor", description: "Requires running SOCKS listener; default 127.0.0.1:9050" },
    ], (mode) => {
      const current = { ...state()!.traffic, mode }
      if (mode === "inherit" || mode === "direct") { void trafficSave(current); return }
      const bypass = () => prompt("No-proxy hosts (comma-separated)", current.noProxy, "Local control traffic is always bypassed. Subprocesses may ignore proxies; Tor does not guarantee anonymity.", (noProxy) => void trafficSave({ ...current, noProxy }))
      if (mode === "proxy") {
        // Credentials may be present in an existing URL: never prefill/display it.
        prompt("Proxy URL", "", "Enter http://, https://, socks5:// or socks5h:// URL. Prefer a credential-free local proxy.", (proxyURL) => {
          current.proxyURL = proxyURL
          try { validateTraffic(current); bypass() } catch { fail() }
        })
        return
      }
      prompt("Tor SOCKS host", current.socksHost, "Tor must already be running. Routing applies to supported network clients, not every tool/process.", (socksHost) => {
        current.socksHost = socksHost
        prompt("Tor SOCKS port", String(current.socksPort), "Default 9050 (Tor Browser may use 9150).", (socksPort) => {
          current.socksPort = Number(socksPort)
          try { validateTraffic(current); bypass() } catch { fail() }
        })
      })
    })
  }
  function provider() {
    const draft: ProviderDraft = { id: "", protocol: "", baseURL: "", models: "", apiKey: "" }
    const finish = async (apiKey: string) => {
      try {
        draft.apiKey = apiKey
        validateProvider(draft)
        const result = await saveProvider(draft)
        draft.apiKey = ""
        // Store only non-secret identification. Provider configuration is stock
        // opencode.json; existing settings/config entries remain untouched.
        const current = await loadSettings()
        await saveSettings({ ...current, providers: { ...current.providers, [result.id]: { protocol: result.protocol, models: result.models } } })
        toast.show({ variant: "success", message: "Provider saved in OpenCode config. Restart InfiniteOC, then choose its model. Existing config backed up when present." })
        home()
      } catch { draft.apiKey = ""; fail() }
    }
    const key = () => choose("API key storage", [
      { title: "Environment variable (recommended)", value: "env", description: "Key stays outside configuration" },
      { title: "Enter key (masked)", value: "key", description: "Local mode-600 key file" },
      { title: "No key", value: "none", description: "For unauthenticated local endpoints" },
    ], (mode) => {
      if (mode === "none") { void finish(""); return }
      if (mode === "key") { dialog.replace(() => <SecretPrompt onCancel={home} onConfirm={(value) => void finish(value)} />); return }
      prompt("API key environment variable", "", "Enter the variable NAME only, e.g. MY_PROVIDER_API_KEY. Export it before restarting InfiniteOC.", (name) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { fail(); return }
        void finish(`{env:${name}}`)
      })
    })
    choose("Custom provider protocol", [
      { title: "Anthropic messages", value: "anthropic" },
      { title: "OpenAI chat completions", value: "openai-completions" },
      { title: "OpenAI responses", value: "openai-responses" },
    ], (protocol) => {
      draft.protocol = protocol
      prompt("Unique provider ID", "", "Letters, digits, hyphens, underscores. Existing provider IDs are not overwritten.", (id) => {
        draft.id = id
        prompt("Provider base URL", "", "HTTP(S) API root, including /v1 if needed. No credentials or query parameters.", (baseURL) => {
          draft.baseURL = baseURL
          prompt("Model IDs (required)", "", "Comma or space-separated exact API model IDs. Provider discovery is not automatic.", (models) => {
            draft.models = models
            try { validateProvider(draft); key() } catch { fail() }
          })
        })
      })
    })
  }
  function removeProvider() {
    const ids = Object.keys(state()?.providers || {})
    if (!ids.length) { toast.show({ variant: "error", message: "No custom providers to delete." }); return }
    choose("Delete custom provider", ids.map((id) => ({ title: id, value: id })), (id) => {
      prompt(`Delete provider "${id}"? Type DELETE to confirm`, "", "Removes it from OpenCode config and InfiniteOC metadata, including its local key file. Restart to apply.", async (confirm) => {
        if (confirm.trim() !== "DELETE") { toast.show({ variant: "error", message: "Deletion cancelled. Type DELETE exactly to confirm." }); home(); return }
        try {
          await deleteProvider(id)
          toast.show({ variant: "success", message: `Provider "${id}" deleted. Restart InfiniteOC to apply.` })
          home()
        } catch { fail() }
      })
    })
  }
  return <DialogSelect title="InfiniteOC Settings" options={state() ? [
    { title: "Traffic", value: "traffic", description: "Restart required; not all-process anonymity", footer: state()!.traffic.mode },
    { title: "Providers", value: "provider", description: "Add custom Anthropic / OpenAI chat / OpenAI responses; explicit model IDs" },
    { title: "Delete provider", value: "remove", description: "Remove a custom provider, its config entry and key file" },
    { title: "Close", value: "close" },
  ] : [{ title: "Loading settings…", value: "loading" }]} onSelect={(option) => {
    if (option.value === "traffic") traffic()
    if (option.value === "provider") provider()
    if (option.value === "remove") removeProvider()
    if (option.value === "close") dialog.clear()
  }} />
}