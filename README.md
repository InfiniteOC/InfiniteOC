# InfiniteOC

A source-backed OpenCode launcher and mod framework, pinned to **OpenCode v2.0.21**. It copies upstream into a disposable worktree, applies trusted JavaScript source mods, builds a separate CLI/TUI binary, and launches it without touching your installed stock OpenCode.

Enabled mods: `infiniteoc` (purple/pink theme, animated wordmark, InfiniteOC as the default primary agent, settings UI, pinned-build guards; [README](mods/infiniteoc/README.md)), `clearall` ([/clearall](mods/clearall/README.md)), `health` ([/health](mods/health/README.md)), `yolo` ([/yolo](mods/yolo/README.md)) and `deep-deliberation` (adds planning guidance to the agent prompt). The agent keeps upstream's base prompt and gets InfiniteOC guidance per agent, `reviewer` and `researcher` subagents, and the bundled skill library (see [mods/infiniteoc/README.md](mods/infiniteoc/README.md)). No permission rules are weakened. `/yolo` is an explicit, confirmed, runtime-only opt-in that auto-approves `ask` prompts; `deny` rules and safe-guard's always-ask gates still hold.

## Requirements

Linux (glibc) or macOS, x64 or arm64; musl/Alpine is not supported. Node.js 22+, npm, Git, and provider credentials. First setup also needs internet access and disk space for the upstream source, dependencies (Bun is installed locally under `.tools`), and the build. The checkout can live anywhere short enough for its `.opendaemon/control.sock` path (104 bytes on macOS, 107 on Linux; `doctor` checks it), else live reload is off.

## Quickstart

From the checkout root:

```sh
npm link                       # optional: puts infiniteoc and opendaemon on PATH
infiniteoc setup               # without npm link: node bin/infiniteoc.mjs setup
infiniteoc /path/to/project
```

## Commands

| Command | Purpose |
| --- | --- |
| `setup` | Prepare and build, reusing a cached binary when possible. |
| `rebuild` | Recreate the worktree from pristine upstream, reapply mods, rebuild. |
| `mods` | List configured mods (importing them — only enable trusted mods). |
| `doctor [--json]` | Read-only ✓/✗ checks (platform, tools, upstream, build, daemon, settings, Tor/SOCKS); exits 1 on any ✗. |
| `feature new\|check\|enable\|disable ID` | Scaffold, check, or add/remove `mods/ID` in `infiniteoc.json` (enable checks first; both keep `infiniteoc.json.bak`). See [FEATURES.md](FEATURES.md). |
| `[directory/args]` | Launch (private server unless `--server URL`). |
| `-- [args]` | Forward arguments to OpenCode. |

`npm run setup`, `npm start -- [args]`, and `npm test` also work from the repo root. Never edit `.runtime/opencode` directly — rebuild deletes that tree; edit mods instead.

## Builds and launches

- A launch rebuilds only when `infiniteoc.json`, the framework or a mod changed; the build prints its reason, timed `[1/4]`…`[4/4]` steps and `Ready in Ns`.
- `.runtime/prepare.lock` heals itself: a dead owner's lock (or a pid-less one older than 30 minutes) is reclaimed, a second launch waits and reuses the fresh build, and Ctrl+C removes it.
- Each successful build is kept in `.runtime/last-good`. If a build or mod fails at launch, that build starts instead, without mod hooks; fix the mod, then `infiniteoc rebuild`.
- That fallback, an unavailable opendaemon, or an unreachable Tor/SOCKS listener never stops a launch: it is printed and shown again as a TUI warning toast.
- OpenCode stays pinned: the binary never checks for or installs OpenCode updates, and the launcher and binary refuse `upgrade`/`uninstall` (and the binary's `update`), which would act on stock OpenCode and the sessions, credentials and config it shares. Remove InfiniteOC by deleting the checkout.
- InfiniteOC updates itself: at launch (at most every 6 hours) it fetches this checkout's remote branch and, if there are new commits, shows them and fast-forwards after a 5 second countdown (`s` skips), then rebuilds. It never updates over local commits or uncommitted edits, and does nothing without a terminal except print a hint. Run `infiniteoc update` any time; choose auto, ask or off in `/settings` → InfiniteOC Settings → Updates (`"updates": {"mode": ...}` in settings.json). Exit hints resume with `infiniteoc -s SESSION_ID`.
- After a crash signal the launcher restores the terminal (screen, cursor, mouse and keyboard modes).

## Configuration

`infiniteoc.json` lives at the checkout root:

```json
{
  "upstream": "v2.0.21",
  "mods": ["./mods/infiniteoc/index.mjs"],
  "options": { "reducedMotion": false }
}
```

Mod paths are relative to the checkout root and order matters. `reducedMotion: true` makes Animations default to off (applied at build time); an Animations choice made in the TUI still wins. Traffic (proxy/Tor) and custom providers live under `/settings` → InfiniteOC Settings; see [mods/infiniteoc/settings/README.md](mods/infiniteoc/settings/README.md).

## Launcher and distribution

Installer, first-run wizard, update rollback and signed updates, `doctor --fix`, crash reports, `bench`, mod packs, team settings, dev-mode live reload and remote control are described in [LAUNCHER.md](LAUNCHER.md).

## Features, live reload and skills

- New TUI slash commands: `infiniteoc feature new my-feature`; see [FEATURES.md](FEATURES.md). Agents start at [AGENTS.md](AGENTS.md).
- Frontend work: every agent must load the bundled [frontend-design](skills/frontend-design/SKILL.md) skill (adapted from Anthropic's, with a required plan, a measurable quality floor and a render-and-inspect loop) before editing UI files; edits are refused until it is loaded.
- `/goal <what done means>`: the agent keeps working, testing and verifying until the goal is met (or it reports `GOAL BLOCKED`); `/goal stop` or Esc ends it. Details in [mods/infiniteoc/README.md](mods/infiniteoc/README.md).
- `/goal` in the TUI: the word glows as you type it, the footer shows the active goal and its turn (`goal 3/20 · ...`), and the start message reads `/goal <text>`.
- Ponytail ([github.com/DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), MIT, bundled in `skills/ponytail*`): the lazy-senior-dev ruleset (smallest complete change, fewer output tokens) is off by default, added only to turns that write code (implementation requests, turns that edit files, the `general` worker) and never to questions or read-only agents once enabled. `/ponytail auto|lite|full|ultra|off` switches it; "stop ponytail" turns it off for a session; `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-gain`, `/ponytail-help` run its skills.
- Subagents: `explore` runs on the provider's small model (Haiku, Flash or Luna) at minimal reasoning unless a model is configured for it (`INFINITEOC_FAST_EXPLORE=0` turns that off); explore and researcher stop at 30 steps and reviewer at 60; the guidance says when to use each one, and how to run them in parallel, in the background and as follow-ups.
- Awareness: project instructions also load from `CLAUDE.md` where a directory has no `AGENTS.md`; the environment block names the OS release and shell; the agent knows InfiniteOC's own commands and suggests `/goal` for long tasks.
- Live command reload without restarting: `opendaemon` (every launch starts it) and `/live` in the TUI; see [OPENDAEMON.md](OPENDAEMON.md).
- Bundled skills live in [skills/](skills/); mod API and safety rules: [skills/infiniteoc-mod-development/SKILL.md](skills/infiniteoc-mod-development/SKILL.md).

## Tests

```sh
npm test    # node --test test/*.test.mjs mods/*/test.mjs
```

Tests use Node built-ins, temporary directories and the pinned `.upstream` checkout that `setup` clones; a few skip on Node versions without TypeScript type stripping. Compiled-binary and interactive-TUI behavior need a rebuild and a real terminal — see [VERIFICATION.md](VERIFICATION.md).

## Trust boundary

Mods are trusted local JavaScript, not sandboxed. Review any mod before enabling it, and never use untrusted mods with secrets available.

## Legal

Independent community project, not affiliated with, endorsed by, or sponsored by the OpenCode authors. This repository contains no vendored OpenCode source: `setup` clones the pinned tag from the official upstream (`https://github.com/sst/opencode.git`, MIT) into the git-ignored `.upstream/` directory and builds from a disposable copy. Mods are original patch scripts that reference upstream files by anchor; they do not redistribute upstream code.

License: [MIT](LICENSE). Third-party attributions: [NOTICE.md](NOTICE.md). Security reports: [SECURITY.md](SECURITY.md).

Local `opencode.json` (personal MCP servers and paths) is not tracked; copy `opencode.json.example` to `opencode.json` and adjust it.
