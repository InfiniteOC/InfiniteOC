# yolo

`/yolo` turns upstream's auto-approve mode on or off for this UI. Upstream calls it `autoaccept`;
it is the same mode as `opencode --auto` / `--yolo` / `--dangerously-skip-permissions`. While it
is on, every permission request that resolves to `ask` is answered "allow once", including file
edits, writes and shell commands, and including any request already waiting when you turn it on.

- **On** asks first (a `ctx.ui` confirm that spells out what gets approved). Esc or Cancel changes nothing.
- **Off** needs no confirmation.
- Each change shows a toast. While it is on, the prompt shows a bold warning-colored `YOLO` next to
  the agent name, in the slot of upstream's muted `auto` indicator.
- The command palette has it as "Toggle YOLO mode (auto-approve permissions)". The declarative
  command API has no arguments, so `/yolo on|off|status` is not available; the indicator shows the
  current state.

## What still stops the agent

- **`deny` rules.** The server stops a denied request before any prompt exists, so the client has
  nothing to approve. This mod does not touch server-side permission evaluation (`packages/core`).
- **safe-guard's always-ask gates.** These are protected paths, any `git push`, recursive `rm`,
  `git reset --hard`, `git clean`, `sudo`, destructive SQL, `npm publish`, your `safety.ask` globs
  and the rest of the list in [safe-guard](../safe-guard/README.md). safe-guard tags each gated
  request with its message, also when the request was already `ask`. Auto-approve skips tagged
  requests and still shows them as normal prompts. This applies to `--auto` and
  `session.permissions = "autoaccept"` as well.
- **Saved rules.** Approvals are "once" only. YOLO never answers "always", so it saves no
  permission rules.

## Not persisted

The switch lives in the TUI process memory and starts off on every launch. Your config is never
written. If `--auto` or `session.permissions = "autoaccept"` already enables auto-approve, `/yolo`
reports that and cannot turn it off; change that flag or setting instead.

## How it hooks in

- `packages/tui/src/infiniteoc-features/yolo-state.ts` (written): a Solid signal, the
  safe-guard gate matcher `yoloAlwaysAsk`, and a framework-free `globalThis[Symbol.for("infiniteoc.yolo")]`
  handle used by the `/yolo` handler, so the handler also works as a live-reloaded bundle.
- `context/permission.tsx`: `mode` is `autoaccept` when the signal is on (otherwise upstream logic).
- `routes/session/index.tsx`: upstream's auto-approver (`permissions().forEach(... decision: "once")`),
  the hidden-prompt memo `promptedPermissions` and `useToolPermission` skip gated requests.
- `component/prompt/metadata.tsx`: the `auto` indicator reads `YOLO` in the warning color while on.

## Caveats

- Like upstream, approvals happen in the open session view: they cover the session you are
  looking at and its subagents. Requests from sessions in other tabs wait until you open them.
- On a very narrow terminal the prompt metadata row drops the indicator, as upstream does with `auto`.
- Non-interactive `infiniteoc run --auto` is upstream's separate path and is unchanged; safe-guard
  gates are auto-approved there.
- The gate matcher depends on safe-guard's exact message text; `test.mjs` fails if the two drift apart.

Rollback: `node bin/infiniteoc.mjs feature disable yolo`, then restart (the next launch rebuilds).
