# /clearall

Version 2 is a local TUI feature registered with `api.tui.command`, not a server
command or an agent prompt.

Type `/clearall` to close every open tab in the configured current global/cwd
scope and return to New session. Stored sessions and messages are unchanged;
running tasks continue. Reopen saved conversations with `/sessions`. Other cwd
scopes are untouched. The upstream recently-closed stack retains at most 25 tabs.

Persistence uses one locked update; queued route registrations are cancelled so
they cannot resurrect the just-closed tabs. Storage failures produce an error,
not a false success toast.

The enabled mod replaces the broken version after rebuild/restart. It is also
the reference for `/home/rize/InfiniteOC/FEATURES.md` and the AI feature scaffold.

Tests: `node --test /home/rize/InfiniteOC/test/tui-features.test.mjs
/home/rize/InfiniteOC/mods/clearall/test.mjs` (put both paths on the same shell line).
Live verification used an isolated XDG directory and loopback server: three
created sessions, three persisted tabs, actual terminal entry of `/clearall`,
empty current-scope tab list afterwards, all three session API reads successful,
other scope unchanged. No user sessions or credentials were used.