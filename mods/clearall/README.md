# /clearall

Version 2 is a local TUI feature registered with `api.tui.command`, not a server
command or an agent prompt.

Type `/clearall` to close every open tab in the configured current global/cwd
scope and return to New session. Stored sessions and messages are unchanged;
running tasks continue. Reopen saved conversations with `/sessions`. Other cwd
scopes are untouched. With no open tabs (or tabs disabled) it only says so.

Click the toast's `Undo` (toast actions are mouse-only) to restore the closed
tabs at their positions and reselect the active one (`ctx.tabs.restoreAll`).
From the keyboard, the palette command "Reopen closed tab" (`ctrl+shift+t`)
reopens them one at a time in original order. Terminals without the kitty
keyboard protocol (e.g. macOS Terminal.app) send `ctrl+shift+t` as `ctrl+t`,
which cycles model variants, so the toast names the palette command too.
Both use the upstream recently-closed stack, which retains at most 25 tabs, and
skip sessions deleted or already reopened meanwhile.

Persistence uses one locked update (Undo too); queued route registrations are
cancelled so they cannot resurrect the just-closed tabs. Storage failures
produce an error, not a false success toast.

The enabled mod replaces the broken version after rebuild/restart. It is also
the reference for [FEATURES.md](../../FEATURES.md) and the AI feature scaffold.

Tests, from the checkout root:
`node --test test/tui-features.test.mjs mods/clearall/test.mjs`.
Live verification used an isolated XDG directory and loopback server: three
created sessions, three persisted tabs, actual terminal entry of `/clearall`,
empty current-scope tab list afterwards, all three session API reads successful,
other scope unchanged. No user sessions or credentials were used. Undo (2.1) is
unit-tested against the injected method and upstream tab model only.