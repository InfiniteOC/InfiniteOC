# server-lease: the private server always exits when its lease ends

InfiniteOC's interfaces and `run` talk to a private server (`serve --stdio`) that lives while the launching
process holds its stdin open. On quit the launcher sends the server SIGTERM and exits; its own SIGKILL fallback
(3 s later) never runs because the launcher is gone by then. The server normally shuts down in milliseconds.

Sometimes a shutdown step never finished. The server's later cleanup then never ran either, so its handles stayed
open and it kept running with nobody left to use it: about 300 MB each, ignoring further SIGTERMs, piling up with
every launch it happened on (three times while testing here). Logs showed shutdown starting and stopping partway.

Once the lease ends, by stdin closing or by that SIGTERM interrupting the wait, this mod arms a timer that exits the
server 5 s later if it is still running. The timer is `unref`'d, so it never delays a clean exit; it only ends a
process that something else keeps alive.

- `packages/cli/src/server-process.ts`: `waitForStdinClose` arms the timer when stdin closes and when the wait is
  interrupted.

Checked:

- `test.mjs` runs the patched function: a hanging shutdown exits 300 ms (the test's timer) after stdin closes or
  after an interrupt with stdin still open; a clean one is not delayed. Each hang case fails without its timer.
- A Bun program with the server's shape (an Effect scope, a finalizer that never finishes, a handle a later
  finalizer would close) stays alive without the timer and exits 1.5 s after stdin closes with it.
- 30 launches and quits of the rebuilt InfiniteOC left no server; the 20 timed ones exited 55 to 163 ms after
  quitting.

Rollback: remove `./mods/server-lease/index.mjs` from `infiniteoc.json` and rebuild.
