# opendaemon live development and temporary testing

Authority (relative to the checkout): `OPENDAEMON.md`, `src/opendaemon.mjs`,
`src/live-runtime.ts`, `src/live-build.mjs`, `src/opendaemon-tool.mjs`,
and `bin/opendaemon.mjs`. Inspect them before relying on behavior.

## Select the right path

| Change | Mechanism | Lifetime |
|---|---|---|
| Notification | `opendaemon notify 'text'` | One message to connected UIs |
| Permanent ctx-only command | `api.tui.command`, reload/auto | Saved mod, live registry |
| Test code once | `opendaemon script UI_ID /absolute/test.ts` | One invocation in selected UI |
| Temporary command/replacement | `opendaemon temporary UI_ID /absolute/command.json` | Selected UI process only |
| Remove overlays | `opendaemon temporary-clear UI_ID` | Restores permanent command registry |
| Components/backend/tools/permissions | Source mod + safe build/restart | Compiled executable |

Every launch starts or reuses a same-user Unix-socket daemon; if it cannot start,
the UI runs without live reload and says so in a toast. Directory mode is 0700,
socket 0600; it is not a TCP service. Scripts are not sandboxed. Supported live
handlers are JS/TS ctx-only exports. Use `import type { FeatureContext } from
"./api"` if desired; types are erased. `ctx.ui` promise dialogs work live. Local
imports can be bundled, but don't import Solid/OpenTUI/OpenCode framework
instances or use JSX components in the live path. Scripts execute with UI process
permissions; they can block or damage it if written badly. Keep tests small,
bounded and non-destructive.

## Runnable workflow (from the checkout root; replace UI_ID with a real ID)

```sh
opendaemon status
opendaemon script UI_ID examples/opendaemon/test-notification.ts
opendaemon temporary UI_ID examples/opendaemon/temporary-command.json
opendaemon temporary-clear UI_ID
opendaemon reload
opendaemon watch
opendaemon auto on
opendaemon auto off
```

Inside the target UI's own terminal or agent, omit `UI_ID`: launched UIs pass
their ID (`INFINITEOC_UI_CLIENT`) to their server, terminals and agent, and the
agent tool's `client` defaults to it too. Elsewhere take the ID from `/live`
("This UI") in the target UI, or from the client lines of `opendaemon status`
(`--json`: `status.clients`); never send literal `CLIENT` or `UI_ID`. The selected
client must report `scripting: true`. Do not guess among multiple UIs.

The example temporary descriptor registers `/tempdemo`; run it in that UI.
Descriptor fields: `id`, `title`, `slash` without `/`, `source` exporting run;
optional `aliases` and `category`. Overlays replace permanent mod commands by
primary slash name; built-in slashes and `/live` stay reserved. Clearing/restarting
restores permanent handlers; no mod files or launcher configuration are changed. A
newly started UI gets a new identity and does not inherit overlays. Persistent
side effects of handlers (file writes, session operations, network requests) are
NOT automatically undone. Compiled temporary source artifacts are retained on disk
like other generations; "temporary" refers to registration, not secure erasure of
script text.

For an inline agent invocation, the generated tool is
`tools.opencode.opendaemon` (opencode namespace, codemode). Inputs:

```json
{"action":"status"}
{"action":"script","client":"REAL_UI_ID","source":"export function run(ctx) { ctx.toast.show({ variant: 'info', message: 'Live script' }) }"}
{"action":"temporary","client":"REAL_UI_ID","slash":"demo","title":"Demo","source":"export function run(ctx) { ctx.toast.show({ variant: 'info', message: 'Demo' }) }"}
{"action":"temporary-clear","client":"REAL_UI_ID"}
```

Also supports `reload`, `notify` with text, `close-all-tabs`, and `auto` with
boolean enabled. Notifications do not inject prompts or steer agent generation.

## Real progress and continuity

`reload` returns a job, not completion. Check discovery/compilation/validation/
publication events and each client's revision acknowledgement. Script/message
responses are queued; check `messages[].acknowledgements[UI_ID].status` for
`applied` or `failed`. Messages expire after 30 seconds. No client means no
delivery. Failure reports avoid compiler source/secret excerpts; framework checks
such as a slash collision are named in the events and the UI's failure toast.

Permanent generations publish atomically; failed compilation/loading retains
working handlers, and the UI shows a warning toast. Temporary compilation failures
retain the previous overlay. In-flight command calls keep their original function.
The daemon does not kill the backend or interrupt model tasks. Do not claim active
token-stream testing unless actually performed; earlier isolated checks used no
paid model request. Auto updates mean hashing trusted local mod files, including
atomic saves, not downloading Git changes or executing unreviewed remote mods.

## Version mismatch troubleshooting

- `Unknown opendaemon operation`: likely old resident daemon lacking endpoint.
- `Choose a connected client ID`: placeholder, stale ID, or no connected UI.
- `CLIENT required outside an InfiniteOC UI`: pass an ID from `/live` or status.
- `predates temporary scripting support`: UI loader needs safe update/restart.
- `not running; start it with: opendaemon start`: no daemon on that socket/home.
- Published but not applied: inspect clients, failures and correct socket/home.

Read status PID, `/live`, generated source and `.runtime/build.json`. Source
changes alone do not reload daemon/loader infrastructure. If necessary, run
`opendaemon restart`: it signals only the pid the daemon reports, and clients poll
and reconnect. This loses daemon-only temporary overlay state. Never wildcard
kill, stop the agent, or rebuild its active runtime tree for a demonstration.
Loader/backend/tool infrastructure needs one safe build and UI restart; use a
user-safe boundary and explain that limitation rather than promising magic.
