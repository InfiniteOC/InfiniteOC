# opendaemon: live control without restarting the agent

The InfiniteOC launcher automatically starts a same-user background daemon and
connects the TUI and agent tool to its Unix socket. **One initial restart into
the new executable is necessary**; a binary already running cannot gain the
new loader. Thereafter declared ctx-only TUI command handlers can be added,
changed or removed live without replacing the UI or backend process.

## CLI and agent tool

```sh
opendaemon status
opendaemon reload
opendaemon watch
opendaemon notify 'A new feature is ready'
opendaemon close-all-tabs
opendaemon auto off
opendaemon auto on
```

The executable is `$HOME/InfiniteOC/bin/opendaemon.mjs`, linked from
`$HOME/.local/bin/opendaemon`. `start` starts the daemon explicitly; `serve`
runs it in the foreground for diagnostics/service managers. `--home PATH`
selects another installation. It does not automatically install a systemd unit.

The built-in `opendaemon` tool is in the `opencode` tool namespace (available via
codemode as `tools.opencode.opendaemon`). Input:

```json
{"action":"status"}
{"action":"reload"}
{"action":"notify","text":"Reload ready"}
{"action":"close-all-tabs"}
{"action":"auto","enabled":false}
```

`reload` returns a job immediately. Inspect `status` or `watch` for discovery,
compilation, validation, publication and UI acknowledgement events. Publication
is **not** proof that a client applied the change: connected clients report their
generation and actions have separate applied/failed acknowledgements. Messages
expire after 30 seconds; a queued message may have no recipient. Notifications
are UI communication, not injected agent prompts or steering instructions.

## Temporary testing and scripting

Use `opendaemon status` to choose a connected client ID. The client must report
`scripting: true`; older running executables need one safe restart into the new
loader. The existing daemon also needs a safe restart to load new endpoints.
Do not restart an active agent just to apply this infrastructure update.

```sh
opendaemon script CLIENT /absolute/path/test.ts
opendaemon temporary CLIENT /absolute/path/command.json
opendaemon temporary-clear CLIENT
```

Scripts must export `function run(ctx)` or `async function run(ctx)`. For example:

```ts
export function run(ctx) {
  ctx.toast.show({ variant: "info", message: "Live test script executed" })
}
```

The script is compiled and queued only for the chosen UI; watch its applied/failed
acknowledgement in `status`. A temporary JSON command contains `id`, `title`,
`slash` (without `/`), and `source` (the same exported handler). Temporary commands
can replace permanent mod commands with the same slash name, and clearing restores
the permanent handler. They are scoped to the UI process ID, not saved to mods or
reapplied to a newly started UI. Compilation failure retains the previous overlay.

Agent tool actions `script`, `temporary`, and `temporary-clear` accept `client`;
the first two accept inline `source`, with optional `slash` and `title`.

**Trusted local code only: scripts are not sandboxed.** They run with the UI's
permissions. Temporary registration goes away on restart, but file writes,
session operations, network requests, or other script side effects are not
automatically reversible. Use notifications or transient UI changes for safe
tests. No arbitrary source-file hot patching or automatic rollback is promised.

## What reloads live

- `api.tui.command` metadata and ctx-only handlers (including new/removed commands).
- Supporting local imports that Bun can bundle without another TUI framework.
- Toast notifications and explicit non-destructive close-all-tabs requests.
- Local mod changes detected by content hashing, including editor atomic saves.

Live handlers use `FeatureContext` and its `tabs`, `route`, `dialog`, `toast`
capabilities. Type-only `import type { FeatureContext } from "./api"` is erased.
Framework imports and JSX/component-heavy source modifications are not the
supported live path: use source mods plus rebuild/restart for those. Initial
compiled command fallbacks still work if the daemon is unavailable.

Fresh compiler workers avoid reusing Node's cached mod/helper modules. Each
generation has unique module paths. All handlers are compiled before the
manifest is atomically replaced; the TUI loads all modules before switching its
registry. Failed reloads keep the last working generation. Already-running
handler calls retain their original function. They are not cancelled by reload.

## What does not reload live

Compiled backend/agent code, arbitrary source patches, permission logic,
launcher/traffic settings and the core executable. Changed mod files conservatively
set `restartRequired` because setup can mix live declarations and arbitrary
patches. That flag does not mean live command publication failed. No daemon
operation calls rebuild, kills the backend, interrupts a session or deletes
history. Rebuild/restart compiled changes at a safe boundary yourself.

Auto-update means **reacting to trusted local files**, not automatically pulling
Git or installing remote code. The daemon runs trusted mod setup in a fresh
worker, so review mods before enabling them. It is not a sandbox.

## Safety and lifecycle

Control socket mode 0600; directory mode 0700; no TCP listener. Same-user processes
can control it. Requests/messages/events are bounded. There is no shell-exec or
network update endpoint; explicit scripting executes trusted code and can perform
side effects. Normal status excludes script source and notification
text; compiler source snippets are not exposed in reload failure reports.
Generations are retained so in-flight calls can finish; memory/module growth
means long development sessions may eventually benefit from a safe restart.
No automatic generation garbage collection is implemented yet.

Only use `reload` for live updates. The existing manual full `rebuild` still
replaces the generated source tree and is **not** guaranteed safe during active
agent work. After framework/daemon code changes, restart the daemon at a safe
boundary (foreground Ctrl+C or exact service PID), then reconnect clients.

## Verification

Node tests cover atomic publication, failed-generation retention, same-user
permissions, local auto reload, request validation, messages/acknowledgements,
and serialized/coalesced compilation. Live isolated PTY verification added a
command, invoked it, edited its source, observed auto publication and client
acknowledgement, invoked the updated handler, delivered a notification and closed
three tabs. UI/backend PIDs stayed unchanged; all three stored sessions survived.
No paid model request was used, so active token-generation continuity is an
architectural guarantee (no interrupt/restart operation), not a paid-stream test.