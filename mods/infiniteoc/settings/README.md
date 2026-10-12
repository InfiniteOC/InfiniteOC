# InfiniteOC Settings

Main mod setup calls `await installSettings(api)` from `./settings/index.mjs`.
The installer copies the dialog and shared helper to the upstream TUI component
directory, then adds **InfiniteOC Settings** to the existing `/settings` dialog.
Anchors fail closed on incompatible upstream versions; installation is idempotent.

The shared Node-compatible `settings-store.mjs` exports:

- `settingsFile(env = process.env)`: `INFINITEOC_SETTINGS_FILE`, otherwise
  `~/.config/infiniteoc/settings.json`.
- `loadSettings(file?)`, `saveSettings(settings, file?)`, `validateTraffic(input)`.
- `providerConfigFile(env?)`: `OPENCODE_CONFIG`, otherwise
  `${XDG_CONFIG_HOME || ~/.config}/opencode/opencode.json`.
- `providerProtocols`, `validateProvider(input)`, `buildProvider(input, keyReference)`,
  `saveProvider(input, {configFile?, settingsFile?})`.

Settings and provider configuration writes use an exclusive temporary file,
fsync, and atomic rename, mode 0600. Existing provider configurations receive an
exact-content mode-0600 timestamped backup. Other config keys/providers are
preserved. JSONC, malformed JSON, existing IDs and adjacent JSONC overlays are
rejected rather than rewriting comments or overriding an active overlay.

Provider definitions use verified upstream v2 `providers` / `package` / `settings`
/ `models` fields. `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible` and
`@ai-sdk/openai` are mapped by upstream `AISDKNative` to native Anthropic messages,
OpenAI chat, and OpenAI responses respectively. The native OpenAI provider's
`model` method is `responses`, not chat. Models must be explicitly supplied.

API keys preferably use `{env:VARIABLE}`. Entered keys are captured without an
Input/Textarea (OpenTUI 0.5.14 has no password option), displayed only as bullets,
and written to separate mode-0600 files referenced via `{file:absolute-path}`.
Provider metadata in InfiniteOC settings contains only protocol and model IDs.
Keys never enter titles, inline messages or helper error messages. Local plaintext key
files are not encryption; use environment references when possible.

Traffic modes are `inherit`, `direct`, `proxy`, `tor`. Default Tor listener is
`127.0.0.1:9050`; Tor must already be running. In Tor mode the host must pass the
launcher's own rule (letters, digits, dots, hyphens or IPv6, no port), so a saved host
never blocks the next launch; other modes never read it. Saving requires a restart. This UI
does not apply routing itself: the launcher consumes the helper. Supported client
routing is not all-process anonymity; tools/subprocesses may ignore proxies.

Dialog: the home rows show the current traffic route (proxy shows only the URL
host, never credentials) and the custom providers with protocol and model count.
The provider wizard has five numbered steps, each validated on Enter. Errors and
the post-save notice appear inside the dialog, never as toasts, because toasts render
under the backdrop. Only the store's own static messages are shown; filesystem errors
become a generic permissions message. Esc on any step returns to the settings home,
except while a save runs. One in-flight save is shared by provider save, traffic save and delete.
Every step uses the large dialog size, so one-line rows and their safety notes fit (narrower
terminals clamp it).

Verification: `node --test test/settings.test.mjs` (12 tests). TUI typecheck found
no errors in added settings files; the upstream workspace has unrelated missing
declaration outputs and test/simulation type errors.