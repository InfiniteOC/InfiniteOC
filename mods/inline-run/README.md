# inline-run — `run` without a second process

`run` started its private server as a child process (`serve --stdio`): a second runtime to boot and the
same modules to evaluate again before the first model request. Under InfiniteOC (`INFINITEOC=1`), `run` now
starts that same private server inside its own process and talks to it over loopback HTTP as before. Each
run still gets its own server, which stops when the run ends, however it ends.

- `server-process.ts`: an `inline` mode that hands the address and password to the caller instead of
  printing them.
- `commands/handlers/run.ts`: starts the inline server, waits until it listens (or fails), runs as before,
  and interrupts the server at the end.

Unchanged: the TUI, `--server URL`, and every server option. `INFINITEOC_RUN_SUBPROCESS=1` restores the child
process.

Checked against the child-process path:

- The same output, byte for byte once ids and times are masked, for plain and `--format json` runs, and the
  same error and exit code for an unknown model. Server logs still go to the log file, and to stderr only
  with `OPENCODE_PRINT_LOGS=1`, as the child's stderr did.
- Ctrl-C while a bash tool runs: exit code 130 within 100 ms, and the tool's process is gone, as before.
- Mock model, interleaved runs: time to first model request 1,251 → 1,177 ms median (14 runs each); peak
  memory of the whole process tree 475 → 381 MB and wall time 2,163 → 2,009 ms median (6 runs each).

Rollback: remove `./mods/inline-run/index.mjs` from `infiniteoc.json` and rebuild.
