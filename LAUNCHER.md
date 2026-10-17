# Launcher, CLI and distribution

Everything here lives in `src/` and `bin/`; none of it patches OpenCode.

## Install

The repository is private and invite-only, so installing needs credentials. Sign the
[GitHub CLI](https://cli.github.com) in once (`gh auth login`); `install.sh`/`install.ps1` then run
`gh auth setup-git` so git can clone it. A `GH_TOKEN`/`GITHUB_TOKEN`, a git credential helper, or
`INFINITEOC_REPO` set to an SSH URL also work. Fetch the script with gh so you can read it:

```sh
gh api -H "Accept: application/vnd.github.raw" /repos/InfiniteOC/InfiniteOC/contents/install.sh | sh   # read it first
brew tap InfiniteOC/infiniteoc && brew install --HEAD infiniteoc   # private tap, see Formula/ (run gh auth setup-git first)
```

```powershell
(gh api -H "Accept: application/vnd.github.raw" /repos/InfiniteOC/InfiniteOC/contents/install.ps1) | iex   # Windows PowerShell, read it first
```

Or clone first and run the copy you can read (`gh repo clone InfiniteOC/InfiniteOC ~/.infiniteoc && sh ~/.infiniteoc/install.sh`).

`install.sh` clones (or fast-forwards) into `~/.infiniteoc`, links `infiniteoc` and `opendaemon` into
`~/.local/bin` and runs the first build. On Windows, run `install.sh` from Git Bash
(`https://git-scm.com`), or run `install.ps1` from PowerShell: it installs into
`%LOCALAPPDATA%\InfiniteOC`, creates `infiniteoc.cmd`/`opendaemon.cmd` shims in a per-user
`bin` directory and adds it to your *user* PATH. `INFINITEOC_DIR`, `INFINITEOC_BIN`, `INFINITEOC_REPO`, `INFINITEOC_REF`,
`INFINITEOC_NO_SETUP=1` and `INFINITEOC_NO_LINK=1` change that. Nothing is published by this repository; the
formula is meant for a tap you create.

## Uninstall

```sh
sh uninstall.sh                # Git Bash on Windows, macOS, Linux
```

```powershell
.\uninstall.ps1                # Windows PowerShell
```

Stops opendaemon, removes the command shims/links and deletes the install directory.
Your InfiniteOC settings are kept (add `--remove-settings` / `-RemoveSettings` to delete
them too). Stock OpenCode — providers, sessions, `~/.config/opencode` — is never touched.
`INFINITEOC_DIR` / `INFINITEOC_BIN` target a custom location; the scripts refuse to remove
anything that is not an InfiniteOC checkout. (`infiniteoc uninstall` stays refused: that
would run OpenCode's own uninstaller against your shared stock install.)

No administrator is needed anywhere: the install directory, the shims/links, the user PATH entry,
the named-pipe (Windows) or socket (macOS/Linux) daemon transport and the prebuilt binaries are
all per-user. The installer warns when run elevated but installs per-user anyway.

Where a prebuilt binary exists for your platform (GitHub releases, `infiniteoc-<target>.zip`,
built by `.github/workflows/release.yml`), the installer downloads it so the first run is instant
(`INFINITEOC_VERSION` pins a tag, `INFINITEOC_PREBUILT=0` always builds from source, and
`INFINITEOC_PREBUILT_URL` points at a mirror file). Without one, the launcher builds from source,
which takes several minutes and downloads Bun and the OpenCode sources. Supported targets:
`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64`
(`darwin-x64` has no hosted release runner and always builds from source).

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

## serve and web

```sh
infiniteoc serve [--hostname H] [--port N] [--cors ORIGIN]...   # headless API
infiniteoc web   [--hostname H] [--port N] [--no-open]           # API + web UI + one-time sign-in link
```

Both run upstream's `opencode serve` (the v2 API, and the web UI when it is built in) from the InfiniteOC build,
through the same path as a TUI launch: the build cache, a rebuild when mods changed, the last-good fallback,
mods' launch hooks, settings, traffic (proxy/Tor) and opendaemon. They also apply after `--`, so the rules below
cannot be skipped by forwarding.

- **Bind address**: `127.0.0.1` unless `--hostname` (alias `--host`) says otherwise. Without `--port` the launcher
  picks upstream's choice itself (4096, else the next free port) so it knows the URL.
- **Password**: upstream's server auth (HTTP Basic, user `opencode`) is always on. The password is
  `OPENCODE_PASSWORD` (or the legacy `OPENCODE_SERVER_PASSWORD`) if set, else a random 32-character one that is
  printed once. The server process drops it from its environment after reading it (`mods/webui`; upstream does
  that only for `--stdio`), so the agent's shell tools do not inherit it.
- **Off loopback** (`0.0.0.0`, `::`, a LAN address, ...): a warning says the server is reachable from other
  machines, gives the agent's power to anyone with the password and is plain HTTP; a typed password under 16
  characters is refused before anything starts. Put TLS (a reverse proxy) or an SSH tunnel in front for anything
  but a network you trust.
- **Checked, not assumed**: once the server answers, the launcher sends a request without a password and one with a
  wrong password. Unless both get 401 it stops the server and fails (a build or mod that disabled auth never stays
  up).
- **CORS**: upstream allows `http://localhost:*`, `http://127.0.0.1:*`, its desktop app and `https://*.opencode.ai`
  origins; `--cors` adds exact origins. Every one of them still needs the password.
- `--service` (OpenCode's background service, shared with stock OpenCode) and `--stdio` are refused.

The web UI is opt-in because upstream compiles it (a vite build of `packages/app`) into the binary: `"options":
{"webUi": true}` in `infiniteoc.json` drops `--skip-web-ui` from the build, and the fingerprint change rebuilds on
the next launch. `infiniteoc web` asks to set it on a terminal (keeping `infiniteoc.json.bak`) and otherwise says
how. Once the server is up it prints a one-time sign-in link (upstream pairing, `/auth/connect/CODE`; it sets a
session cookie) and opens it with `open`/`xdg-open` where there is a desktop (`--no-open` skips that), plus a second
link for other devices when listening on all interfaces. A build without the web UI (for example the last-good
fallback from before it was enabled) is detected and stopped with that hint. `mods/webui` gives the page
InfiniteOC's purple/pink theme and title. Connect a TUI with `OPENCODE_PASSWORD=... infiniteoc --server URL`.
`infiniteoc doctor` reports whether the web UI is enabled and built.
