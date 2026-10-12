# Launcher, CLI and distribution

Everything here lives in `src/` and `bin/`; none of it patches OpenCode.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/riz3y0/InfiniteOC/main/install.sh | sh   # read it first
brew tap riz3y0/infiniteoc && brew install --HEAD infiniteoc                          # personal tap, see Formula/
```

`install.sh` clones (or fast-forwards) into `~/.infiniteoc`, links `infiniteoc` and `opendaemon` into
`~/.local/bin` and runs the first build. `INFINITEOC_DIR`, `INFINITEOC_BIN`, `INFINITEOC_REPO`, `INFINITEOC_REF`,
`INFINITEOC_NO_SETUP=1` and `INFINITEOC_NO_LINK=1` change that. Nothing is published by this repository; the
formula is meant for a tap you create.

## First run

On a terminal, a brand-new installation (no `settings.json`, no OpenCode data) asks about provider, default
model, theme, update mode and ponytail level. Enter keeps each default, Ctrl+C skips the rest. It writes through
the same store as `/settings` (API keys go to mode-600 key files). Run it again with `infiniteoc wizard`.

## Updates

`updates.mode` is `auto`, `ask` or `off` (settings.json). After an update, the new version is built before it
is launched. If that build fails, the checkout goes back to the commit it came from, that is rebuilt, and a
notice says so; the failed commit is not retried automatically (`infiniteoc update` retries). A checkout that
changed after the update is never reset.

`"updates": {"requireSigned": true}` makes the updater fast-forward only to a target that `git verify-commit`
accepts, or that carries a tag `git verify-tag` accepts (tags are fetched for this). It uses your git/gpg
setup; InfiniteOC creates no keys. An unsigned target is refused with the reason.

## doctor

`infiniteoc doctor [--json]` is read-only. A stale or missing build and missing MCP paths are warnings (`!`,
exit code 0). `infiniteoc doctor --fix` fetches missing tools, relinks MCP paths that exist under this install's
`.tools`, and rebuilds a stale build (skipped while a UI is connected). Each step is reported; one failure does
not stop the others.

MCP servers in the repo `opencode.json` use `{env:INFINITEOC_HOME}/.tools/...`; the launcher exports
`INFINITEOC_HOME`, so they resolve wherever the checkout lives.

## Crash reports

If the TUI dies by a signal (or exits non-zero by itself on a terminal), the launcher writes
`.runtime/crashes/crash-<time>.log` (mode 600) with the exit code, build info, the last daemon events and the
tail of OpenCode's newest log (secret shapes redacted) and prints the path. Nothing is sent anywhere.

## bench

```sh
infiniteoc bench --a model=anthropic/claude-sonnet-4-5,ponytail=off --b model=anthropic/claude-sonnet-4-5,ponytail=full [--runs 3] [--tasks tasks.json]
```

Runs five small built-in tasks (or your `--tasks` file: `[{id, prompt, files, check: [argv...]}]`) per
configuration, interleaved, each in a fresh temp directory with tools auto-approved, and prints pass rate,
tokens and mean time for both plus the difference. Configuration keys: `model` (required), `agent`,
`ponytail`, `label`. It spends real money on real providers, so it asks first (`--yes` skips the question).
Bench sessions stay in your session history, titled `infiniteoc bench <task>`.

## Mod packs

```sh
infiniteoc mod add https://example.com/pack.git          # shows commit + sha256, asks
infiniteoc mod add URL --commit <40 hex> --sha256 <hex>  # non-interactive, fails on any mismatch
infiniteoc mod remove <id>
```

A pack is a git repo with an `index.mjs` at its root exporting a mod. It is installed to `packs/<id>`
(git-ignored), pinned in `infiniteoc.packs.json`, and its files are re-hashed at every launch: a pack that
changed on disk is named and not loaded. Packs are trusted code like any mod. `ext::` URLs are refused.

## Team settings

A committed `infiniteoc.team.json` in the project (searched up to the git root) is merged under your personal
settings. Because a repository is untrusted input: only `traffic` and `updates` are read, and the file must be
approved once per content (`infiniteoc team trust`, or the prompt at launch). Editing the file asks again.
A personal value equal to its built-in default counts as unset. `infiniteoc team` shows the state.

## Live reload in dev mode

`opendaemon dev` turns on auto reload, checks mod files every 250 ms (installed packs included), shows the
compiler's own diagnostics when a ctx-only handler fails to build, and prints how long each reload took.
Ctrl+C leaves dev mode; the daemon and UIs keep running. Source patches still need a rebuild (see
OPENDAEMON.md).

## Remote control

```sh
infiniteoc remote                # prints a URL and a one-time token
infiniteoc remote attach         # in another terminal: the TUI on the backend the phone page watches
```

Opt-in: nothing listens until you run it. It starts its own `opencode serve` on loopback with a random
password and a small front on your private-network address (private addresses only, other clients get 403;
`--host` must also be private). The front needs the token (8 wrong tries a minute per address), serves the
phone page and forwards exactly three operations: list sessions, list pending permission prompts, answer one
with approve-once or deny. There is no "always" from the phone. It is plain HTTP, so use a network you trust or
tunnel it. It only sees sessions that run on its backend, which is what `remote attach` starts.
