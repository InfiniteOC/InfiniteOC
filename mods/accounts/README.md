# accounts: several accounts per provider

Lets you keep several logins per provider (two Claude accounts, a personal and a work GitHub Copilot, two OpenAI keys) and switch between them. It builds on OpenCode v2.0.21's own credential store, which already keeps any number of named credentials per integration and marks one as active. This mod adds a cross-provider switcher, account names at login, a rename command, the active name in the footer and an opt-in switch on rate limits.

Runs after `mods/infiniteoc` (it adds a row to InfiniteOC Settings and a server plugin next to `/goal`), and after `mods/prov-kit` and `mods/tstat-status` when those are enabled.

## Where accounts are stored

- Credentials stay in upstream's `credential` table, in InfiniteOC's own database `opencode-infiniteoc.db` in OpenCode's data directory (`infiniteoc -- debug paths db` prints the path). Upstream creates that file, and re-applies mode 600 to it and its `-wal`/`-shm` files on every start.
- Stock OpenCode uses `opencode.db`, a different file, so its credentials are never changed. The legacy `auth.json` is only imported by upstream on first start, never written.
- This mod never opens the database itself. Every add, switch, rename and remove goes through upstream's credential API, so the stored format is exactly upstream's.
- The only thing InfiniteOC stores itself is the opt-in flag, `"accounts": { "fallback": true }`, in `~/.config/infiniteoc/settings.json`. That file is written atomically at mode 600, and its other keys are kept.

## TUI

| Where | What |
| --- | --- |
| `/account` (alias `/accounts`, palette "Switch account") | Lists each provider that has stored accounts, with its active account and count. Choose a provider, then an account to use it for new requests. Also: **Add another account…** (upstream's sign-in), **Rename an account…**, **Remove an account…** (asks first; sessions are kept), **Auto-switch on rate limit: on/off**, **Connect a provider…**. |
| `/settings` → InfiniteOC Settings → Accounts | Opens the same menu. |
| Prompt footer | `acct <name>`: the active account of the current model's provider, shown only when that provider has two or more stored accounts. Hidden when the footer hides details, for example in `/zen` or while interrupting on narrow terminals. |
| `/connect` | Upstream's integration dialog. It still works as before (add account, rename, delete, select). |

Every action has a keyboard path. Feedback after a switch is a toast, and errors show as `Accounts` error toasts.

## CLI

`infiniteoc auth …` forwards to the built binary's upstream `auth` commands, which use InfiniteOC's database. This mod adds `rename`, `--label` and the active marker:

| Command | |
| --- | --- |
| `infiniteoc auth login anthropic --label work` | Add an account with a name (key, OAuth or command login). Without `--label`, upstream names it after the provider: "Anthropic", "Anthropic 2", … A new login becomes the active one. |
| `infiniteoc auth list` | Integrations and account names; the account used for requests is marked `stored, active` when there is more than one connection. `--format json` lists IDs and names, never secrets. |
| `infiniteoc auth switch anthropic work` | Make an account active. |
| `infiniteoc auth rename anthropic "Anthropic 2" personal` | Rename (name or ID; prompts for whatever is missing on a terminal). Names: 1-64 characters, no control characters. |
| `infiniteoc auth logout anthropic personal` | Remove one stored account. |

Upstream's `auth export` prints stored credentials including secrets, on purpose; this mod does not change it. Nothing this mod adds prints a secret.

## Switching without restarting

A switch applies to new requests immediately. Upstream looks up the active credential each time a model is loaded for a request, and providers reload their catalog on the `credential.switched` event. A response that is already streaming finishes on the account it started with. The active account is global: it applies to every session and every InfiniteOC window, and it is kept after a restart.

## Opt-in: switch account on rate limit

Off by default. Turn it on in `/account` (or set `"accounts": {"fallback": true}`). When a request fails with a rate limit or quota error (`provider.rate-limit`, `provider.quota`, HTTP 429) and the provider has another stored account:

1. The next account becomes active, the same as choosing it in `/account`.
2. The request is retried after 0.5 s.
3. A toast says which account hit which limit and which one is now active.

Each other account is tried at most once per session in a failure streak (a streak ends after 10 quiet minutes). After that, upstream's normal backoff continues on the current account. The switch stays in effect afterwards: use `/account` to go back. Accounts supplied by environment variables are not rotated. When an account was switched, prov-kit's model fallback (`/routing fallback`) does not also switch the model for that retry.

## Files

`accounts-lib.ts` (pure helpers, copied into core and the TUI), `plugin.ts` (server retry hook), `tui.tsx` (`/account` and footer, registered as a builtin TUI plugin because it renders upstream's sign-in dialog, so it is not a live-reloadable ctx-only command), `menu.ts`, `cli-rename.ts`, `test.mjs`. Patched upstream files: `core/src/plugin/internal.ts`, `tui/src/plugin/builtins.ts`, `cli/src/commands/commands.ts`, `cli/src/index.ts`, `cli/src/commands/handlers/auth/{account,list,login}.ts`. Patched mod outputs: InfiniteOC Settings (`dialog-infiniteoc.tsx`, `dialog-config.tsx` keyword) and prov-kit's `infiniteoc-prov.ts`.

Disable with `infiniteoc feature disable accounts`. Stored accounts stay in upstream's store and remain available through `/connect` and `infiniteoc auth`.
