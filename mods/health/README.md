# /health — free-model availability checks

`/health` checks the public OpenCode Zen model catalog and shows an explicit
"Probe free models" action. Listing is not proof of inference availability.
Click the action to send a tiny prompt sequentially to each `*-free` model using
the running genuine OpenCode executable and its normal protocol/headers.

Each probe uses a private server, fresh temporary XDG/HOME/config/history, public
free-tier access, a one-step diagnostic agent and deny-all tool permissions.
No existing conversation or provider credential is used. Existing proxy environment
is retained; the check reflects the current network path. No provider configuration
is changed. Probe process groups are terminated after 20 seconds/model and their
temporary directories removed. Retries inside OpenCode count within that timeout.

Results: responding, timeout, provider/client error, client error, empty response,
or inconclusive. Raw error bodies and model output are not displayed. Progress
toasts show completed/total, and a final report lasts 30 seconds. `/health` offers
the last report again. Closing a toast does not cancel a running diagnostic.

These are free-labelled models, not a billing guarantee. Testing consumes requests
and may use free-tier quotas. It checks a tiny text reply, not tool use, coding
quality, long context or all providers. No requests run until you select Probe.

The command supports ctx-only live publication with opendaemon. Source files belong
here, not in generated trees. Test:

```sh
node --test $HOME/InfiniteOC/mods/health/test.mjs
node $HOME/InfiniteOC/bin/infiniteoc.mjs feature check health
```