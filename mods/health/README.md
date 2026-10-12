# /health — free-model availability checks

`/health` reads the public OpenCode Zen model catalog and the opendaemon state,
then opens a keyboard menu: **Probe N free models**, **Show last report** (once a
run finished) and **Close**. Listing is not proof of inference availability. Only
choosing Probe sends requests; Esc or Close sends nothing, and toasts carry no
actions, so clicking one only dismisses it. Probe sends a tiny prompt sequentially
to each `*-free` model using the running genuine OpenCode executable and its normal
protocol/headers. If the catalog cannot be read, nothing is probed: the menu offers
only the last report, or a warning says so when there is none.

Each probe uses a private server, fresh temporary XDG/HOME/config/history, public
free-tier access, a one-step diagnostic agent and deny-all tool permissions.
No existing conversation or provider credential is used. Existing proxy environment
is retained; the check reflects the current network path. No provider configuration
is changed. Probe process groups are terminated after 20 seconds/model and their
temporary directories removed. Retries inside OpenCode count within that timeout.

Results: responding, timeout, provider/client error, client error, empty response,
or inconclusive. Raw error bodies and model output are not displayed. Progress
toasts (info) show a meter, the count, the latest result and the model in flight:
`■■■■⬝⬝⬝ 4/7`, `exo-free: responding`, `now: other-free · up to 20s`. One appears
at the start and after each finished model except the last; each stays until the
next replaces it. New toasts queue behind a hovered
one, so progress is skipped while any toast is queued; the one shown during a hover
can still appear late, before the summary. `/health` during a run shows the current
progress instead of starting another run. A run ends with a summary toast
(`5/7 responding · run /health to view`); no dialog opens by itself. Show last
report lists each model with status and duration. Closing a toast or dialog does
not cancel a running diagnostic.

The last report and the running probe's progress live on `globalThis`, shared by
every opendaemon live generation: after a live reload `/health` still shows the
running probe's progress (never a second run) and the last report.

These are free-labelled models, not a billing guarantee. Testing consumes requests
and may use free-tier quotas. It checks a tiny text reply, not tool use, coding
quality, long context or all providers. No requests run until you select Probe.

The command supports ctx-only live publication with opendaemon; a TUI built before
the dialog API (`ctx.ui`) shows a rebuild notice instead. Source files belong here,
not in generated trees. Test from the checkout root:

```sh
node --test mods/health/test.mjs
node bin/infiniteoc.mjs feature check health
```