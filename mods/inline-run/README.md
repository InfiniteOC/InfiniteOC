# inline-run — no second process for the private server

`run` started its private server as a child process (`serve --stdio`): a second runtime to boot and the
same modules to evaluate again before the first model request. Under InfiniteOC (`INFINITEOC=1`), `run` now
starts that same private server inside its own process and talks to it over loopback HTTP as before. Each
run still gets its own server, which stops when the run ends, however it ends.

The interactive command does the same when InfiniTUI is the interface: the Go TUI draws in its own process,
so this process only held the lease on the child server. The classic UI renders in this process, so it keeps
its separate server, except after InfiniTUI hands over (`/classic`, or a crash): it then uses the same server,
so work already running keeps running.

- `server-process.ts`: an `inline` mode that hands the address and password to the caller instead of
  printing them.
- `commands/handlers/run.ts`: starts the inline server, waits until it listens (or fails), runs as before,
  and interrupts the server at the end.
- `commands/handlers/default.ts`: the same when `INFINITEOC_GO_TUI` is set (InfiniTUI was built and chosen);
  the server stops when the command ends.

Unchanged: the classic UI on its own, `--server URL`, and every server option. `INFINITEOC_RUN_SUBPROCESS=1`
restores the child process for both commands.

Checked against the child-process path:

- `run`: the same output, byte for byte once ids and times are masked, for plain and `--format json` runs,
  and the same error and exit code for an unknown model. Server logs still go to the log file, and to stderr
  only with `OPENCODE_PRINT_LOGS=1`, as the child's stderr did.
- `run`: Ctrl-C while a bash tool runs exits 130 within 100 ms, and the tool's process is gone, as before.
- InfiniTUI: a prompt runs, Ctrl-C quits with exit 0 and leaves no process. `/classic` while a bash tool runs
  opens the classic UI on the same session with the tool still running; quitting it stops the tool.
- Mock model, interleaved runs:
  - `run`: time to first model request 1,251 → 1,177 ms median (14 runs each); peak memory of the process
    tree 475 → 381 MB and wall time 2,163 → 2,009 ms median (6 runs each).
  - InfiniTUI: launch to prompt 880 → 784 ms median; idle memory of the process tree 650 → 544 MB median;
    one process fewer (6 runs each).

Rollback: remove `./mods/inline-run/index.mjs` from `infiniteoc.json` and rebuild.
