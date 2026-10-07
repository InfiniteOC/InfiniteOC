# Shared settings, providers and traffic

Authority: `$HOME/InfiniteOC/mods/infiniteoc/settings/index.mjs`,
`settings-store.mjs`, `settings-store.ts`, `dialog-infiniteoc.tsx`,
`src/traffic.mjs` and the pinned core config/SDK code.

`index.mjs` exports `async installSettings(api)`; the main InfiniteOC mod calls
it during setup. It writes the dialog/store files and patches `dialog-config.tsx`
to add "InfiniteOC Settings" and intercept selection using `useDialog`.
Do not install it twice from another mod or duplicate its anchors. Respect the
loader's no-op rejection despite the integration helper's idempotent detection.

Import shared launcher settings logic from
`mods/infiniteoc/settings/settings-store.mjs`, not a generated runtime copy.
Exports: `settingsFile`, `providerConfigFile`, `loadSettings`, `saveSettings`,
`validateTraffic`, `providerProtocols`, `validateProvider`, `buildProvider`,
`saveProvider`, `deleteProvider`. Inspect actual argument/options shape before
calling provider helpers. `settingsFile(env)` honors `INFINITEOC_SETTINGS_FILE`;
default is `~/.config/infiniteoc/settings.json`. Provider config honors
`OPENCODE_CONFIG`, otherwise the XDG/default OpenCode strict JSON path.

Traffic modes: inherit, direct, proxy, tor. Keep `validateTraffic` authoritative
and preserve unknown settings fields when saving. Changes take effect on launcher
restart; this is not all-process anonymity or guaranteed Tor routing for every
subprocess. Never display credential-bearing proxy URLs or secret environment
values. Do not add a second traffic store or silently mutate global process.env.

Protocol/package mapping in the implemented helper:

| Protocol key | Package |
|---|---|
| `anthropic` | `@ai-sdk/anthropic` |
| `openai-completions` | `@ai-sdk/openai-compatible` |
| `openai-responses` | `@ai-sdk/openai` |

`buildProvider` produces name/package/settings/models for the pinned config.
Before changing mappings verify schema, native SDK selection and model protocol
behavior in `.upstream/packages/core/src/aisdk-native.ts` and provider adapters;
do not assume chat and responses are interchangeable.

Provider saves preserve existing strict JSON objects, reject duplicate IDs and
JSONC/commented files or conflicting JSONC overlays rather than stripping
comments with regex, and create private backups. Environment key references are
supported; raw keys are placed in separate mode-600 files referenced from config.
Never print secrets, include them in toasts/logs, or put them in metadata.
Deletion and restoration must not remove unrelated user config.

The pinned OpenTUI Input/Textarea lacks a password option. The current dialog
uses custom masked key capture; inspect it rather than inventing a password prop
or briefly rendering the raw key. Test typing/paste/editing without exposing the
secret. Provider/traffic/config edits are not temporary script overlays and
must not be described as automatically reversible on restart.