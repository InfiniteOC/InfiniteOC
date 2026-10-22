# opendaemon: live control without restarting the agent

Every InfiniteOC launch starts (or reuses) a same-user background daemon and
connects the TUI and agent tool to its Unix socket. Declared ctx-only TUI command
handlers can then be added, changed or removed live without replacing the UI or
backend process. A running binary cannot gain new loader code: after a loader
change, one restart into the rebuilt executable is necessary.

The daemon is optional. If it cannot start (for example when the checkout path
makes `.opendaemon/control.sock` longer than the OS allows: 104 bytes on macOS,
107 on Linux), the launch continues without live reload, the TUI shows the reason
as a warning toast, and the compiled commands keep working.

## CLI

`npm link` in the checkout puts `opendaemon` on PATH; otherwise run
`node bin/opendaemon.mjs`.

```sh
opendaemon status             # pid, uptime, revision, last job, restart flag, clients, events
opendaemon status --json      # the raw status object
opendaemon reload             # compile and publish live handlers; returns a job
opendaemon watch [--json]     # stream events; keeps waiting across daemon restarts
opendaemon notify 'A new feature is ready'
opendaemon close-all-tabs
opendaemon auto off           # stop watching local mod files (auto on resumes)
opendaemon start | stop | restart | serve
```

`stop` sends SIGTERM to the pid the daemon reports (only that pid) and waits for
its socket to close; `restart` is stop plus start. Both end only the daemon: UIs
and agents keep running and reconnect, and temporary overlays are dropped. After an
update changes the daemon's own code (`src/`, `bin/opendaemon.mjs`), the next launch
replaces a running daemon while no UI is connected; with UIs open it waits for a later
launch. `serve` runs in the foreground for diagnostics/service managers. `--home PATH`
selects another installation and takes precedence over the
`INFINITEOC_DAEMON_SOCKET` that launcher-started UIs inherit. No systemd unit is
installed.

## In the TUI: `/live`

The built-in `/live` command (category System) shows this UI's client ID (choose
the row to see it in a copyable alert), the daemon's pid, phase and auto state,
the loaded and published revisions, the temporary command count, whether a
restart is required and why, the connected UIs, the last failure, and a **Reload
live commands now** row. Toasts report live changes:

| Toast | Meaning |
| --- | --- |
| Live commands updated | A new generation loaded (the startup one loads silently) |
| Live reload failed | A daemon reload job failed, with the reason when the framework names one (e.g. `Duplicate TUI slash command: /name`); the last working commands stay |
| Live generation invalid — last working commands kept | A published generation or overlay did not load in this UI |
| opendaemon unreachable — live reload paused | Shown once per outage; current commands keep working |
| opendaemon reconnected | The outage ended |

Launch notices (fallback build, daemon unavailable, unreachable Tor/SOCKS
listener) appear once at startup as a warning toast.

## Agent tool

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
are UI communication, not injected agent prompts or steering instructions. Tool
errors read `opendaemon: <reason>. The agent continues.`

## Temporary testing and scripting

Each launched UI passes its client ID (`INFINITEOC_UI_CLIENT`) to its server,
terminals and agent, so inside that UI `CLIENT` can be omitted (not with
`--home`). Elsewhere copy an ID from `/live` or `opendaemon status`. The client
must report `scripting: true`; an older running executable needs one restart into
the current loader. Do not restart an active agent just to apply an infrastructure update.

```sh
opendaemon script [CLIENT] /absolute/path/test.ts
opendaemon temporary [CLIENT] /absolute/path/command.json
opendaemon temporary-clear [CLIENT]
```

Scripts must export `function run(ctx)` or `async function run(ctx)`. For example:

```ts
export function run(ctx) {
  ctx.toast.show({ variant: "info", message: "Live test script executed" })
}
```

The script is compiled and queued only for the chosen UI; watch its applied/failed
acknowledgement in `status`. A long script does not stall that UI's polling. A
temporary JSON command contains `id`, `title`, `slash` (without `/`), and `source`
(the same exported handler). Temporary commands can replace permanent mod
commands with the same slash name, but not built-in slashes or `/live`; clearing
restores the permanent handler. They are scoped to the UI process, not saved to
mods or reapplied to a newly started UI. A failed compile returns a static error
(or the framework-named reason), records a `temporary-failed` event, and keeps the
previous overlay.

Agent tool actions `script`, `temporary`, and `temporary-clear` accept `client`,
which defaults to the agent's own UI; the first two accept inline `source`, with
optional `slash` and `title`.

**Trusted local code only: scripts are not sandboxed.** They run with the UI's
permissions. Temporary registration goes away on restart, but file writes,
session operations, network requests, or other script side effects are not
automatically reversible. Use notifications or transient UI changes for safe
tests. No arbitrary source-file hot patching or automatic rollback is promised.

## What reloads live

- `api.tui.command` metadata and ctx-only handlers (including new/removed commands).
- Supporting local imports that Bun can bundle without another TUI framework.
- Toast notifications and explicit non-destructive close-all-tabs requests (the UI
  then offers Undo, like `/clearall`).
- Local mod changes detected by content hashing, including editor atomic saves. Per-file digests are reused while a file's size, mtime, ctime and inode are unchanged, so an idle check only stats the files.

Live handlers use `FeatureContext`: `tabs`, `route`, `dialog`, `toast` and the
`ui` promise dialogs. Type-only `import type { FeatureContext } from "./api"` is
erased. Framework imports and JSX/component-heavy source modifications are not
the supported live path: use source mods plus rebuild/restart for those.

Fresh compiler workers avoid reusing Node's cached mod/helper modules. Each
generation has unique module paths. All handlers are compiled before the
manifest is atomically replaced; the TUI loads all modules before switching its
registry. Failed reloads keep the last working generation, and a UI does not
retry a generation that failed to load until a new one is published.
Already-running handler calls retain their original function. They are not
cancelled by reload.

## What does not reload live

Compiled backend/agent code, arbitrary source patches, permission logic,
launcher/traffic settings and the core executable. Changed mod files conservatively
set `restartRequired` because setup can mix live declarations and arbitrary
patches. That flag does not mean live command publication failed. It survives
daemon restarts and clears once `.runtime/build.json` is newer than the change
and every connected UI first connected after that build. No daemon operation
calls rebuild, kills the backend, interrupts a session or deletes history.
Rebuild/restart compiled changes at a safe boundary yourself.

Auto-update means **reacting to trusted local files**, not automatically pulling
Git or installing remote code. The daemon runs trusted mod setup in a fresh
worker, so review mods before enabling them. It is not a sandbox.

## Safety and lifecycle

Control socket mode 0600; directory mode 0700; no TCP listener. Same-user processes
can control it. Requests/messages/events are bounded; UIs unseen for 60 seconds
are dropped with their overlays. There is no shell-exec or network update
endpoint; explicit scripting executes trusted code and can perform side effects.
Normal status excludes script source and notification text. Reload failure
reports never include compiler output, only framework-authored reasons such as an
invalid declaration, a slash collision or the command that failed to compile.
Generations are retained so in-flight calls can finish; daemon startup deletes
generations older than 24 hours except the live one, so a long-lived daemon
grows until restarted.

Only use `reload` for live updates. The manual full `rebuild` replaces the
generated source tree and is **not** guaranteed safe during active agent work.
After daemon code changes, run `opendaemon restart` at a safe boundary; clients
reconnect on their own.

## Verification

`test/opendaemon.test.mjs`, `test/opendaemon-cli.test.mjs` and
`test/live-runtime.test.mjs` cover publication, failure retention, permissions,
auto reload, messages, acknowledgements, restart flags and the CLI. Real-terminal
results are recorded in [VERIFICATION.md](VERIFICATION.md).
