# auto-loop

Agent-loop features as a core session plugin (`packages/core/src/plugin/infiniteoc-auto.ts`), the same
way `/goal` works. It must be listed after `mods/infiniteoc` (it patches `/goal` and the guidance file
that mod writes).

Settings live in the `autonomy` section of the InfiniteOC settings file and are read on every use.
Change them with `/auto <key> <value>`; `/auto` alone prints them.

| Key | Default | Meaning |
| --- | --- | --- |
| `verify` | on | after a run that edited files, run the project check and give failures back for a fix-up turn |
| `verifycmd` | detected | override the check command |
| `retries` | 2 | most fix-up turns per prompt (1-5) |
| `timeout` | 300 | seconds before the check is killed |
| `stuck` | on | block a call that failed 3 times with the same output |
| `critique` | off | one self-critique turn before a change is reported done |
| `reviewer` | off | `provider/model`; that model reviews the diff before done (the diff is sent to it) |
| `escalate` | off | `provider/model`; used for the fix-up after repeated failure, then dropped back |
| `persona` | off | `terse`, `teacher` or `pair` (prompt style only) |

Commands: `/loop <interval> <prompt>`, `/queue <prompt>|list|clear`, `/timebox <duration>`,
`/plan <task>`, `/askfirst [on|off]`, `/why [focus]`, `/macro record|stop|run|list|delete`,
`/goal tests|types|lint`.

The check command comes from package.json scripts (`check`, `verify`, `test`), a Makefile target,
cargo, go or pytest. Loop, queue, timebox and macro recording are in memory per server process; macros
are saved next to the settings file. Everything else is derived from the session transcript.
