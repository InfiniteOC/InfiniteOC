# fastlane: no stalls after a network change, warm connections

One wrapper around the OpenCode server's `fetch`, installed by a core plugin. Every provider request goes through
it: AI SDK routes call `globalThis.fetch`, and the native routes get a fetch that looks it up per call (Effect's
`FetchHttpClient` would otherwise keep the one it saw at startup; patched in `core/src/effect/app-node-platform.ts`).
Loopback traffic is never touched.

## Network changes (the "wait two minutes after switching Wi-Fi or VPN" problem)

Bun pools keep-alive connections per origin. After a Wi-Fi switch, a VPN coming up or a resume from sleep, the
pooled sockets belong to a route that no longer exists. A request written to one is never answered, and it waits
for the kernel to give up or for the provider header timeout (300 s). Interrupting killed that socket, which is
why interrupting and resending used to help.

fastlane watches the network interfaces every 1.5 s (Docker/VM bridges are ignored; a long timer gap counts as a
resume) and, on a change:

- resends model requests that were still waiting for their response headers, on a fresh connection;
- fails streams that produce nothing for 5 s after the change, so OpenCode's own retry takes over;
- purges each recently used origin's pool with parallel short probes (every dead socket a probe takes is destroyed
  when it times out), and sends the next requests on fresh connections for a few seconds.

Measured with a relay that silently kills existing connections (what a route change does): without fastlane the
next prompt hung until the test gave up (40 s; the real limit is 300 s); with fastlane it completed as soon as
the change was seen.

POSTs are only resent to model APIs (known provider hosts, plus any origin that has streamed events before):
resending one costs at most a duplicate generation. Other POSTs fail fast instead of hanging. A request the
user interrupts is never resent.

`/reconnect` in InfiniTUI (or `POST /api/rpc/fastlane/reconnect`) does the same on demand, for networks that
change without touching an interface.

## Warm connections

- Recently used provider origins (kept in `~/.local/state/opencode/infiniteoc/fastlane.json`) are opened when
  the server starts; origins used in the last 10 minutes get a credential-free `HEAD` after 45 s of idle.
- InfiniTUI calls `warm` when you start typing a new prompt, so the request goes out on an open connection.
- When a consumer cancels a response right after its last event, fastlane reads the remaining tail (up to
  250 ms / 64 KB) instead of cancelling at once, so the socket returns to the pool. With plain `fetch`, a consumer
  that cancels at the final event threw the connection away on every request (4 connections for 4 requests vs 1).

Why the keep-alive matters, measured against OpenCode Zen: a pooled connection answers in ~160 ms for at least
130 s of idle time, but after 5 minutes idle the pooled socket is stale and the request takes ~700 ms (Bun
notices and reconnects) versus ~160 ms warm. A pause like that between replies is normal, so the first request
after it paid about half a second; the keep-alive and the warm-on-typing remove that.

What it does not change: a fresh TLS handshake to OpenCode Zen costs about 230 ms, and in quick back-and-forth
OpenCode already keeps that connection warm. On Zen the time to first token is dominated by the provider (about 1–2.5 s);
OpenCode's own work before the request leaves is about 40–60 ms once the session's catalogs are loaded.
Request-body compression is not an option for Zen: it answers gzip and zstd bodies with HTTP 400.

## Settings

| Variable | Effect |
| --- | --- |
| `INFINITEOC_FASTLANE=0` | disable the wrapper entirely |
| `INFINITEOC_NET_TRACE=/path` | append one JSON line per request, resend, change, purge and warm |
