<p align="center">
  <img src="assets/logo.svg" alt="InfiniteOC" width="420">
</p>

<p align="center">
  <b>OpenCode with superpowers.</b><br>
  Keeps working until the job is done, runs subagent workflows in parallel, connects to ~90 apps, and is easy to extend.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-c084fc"></a>
  <img alt="Node 22+" src="https://img.shields.io/badge/node-22%2B-f472b6">
  <img alt="Platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-555">
</p>

<p align="center">
  <img src="assets/home.png" alt="InfiniteOC home screen" width="760">
</p>

InfiniteOC is a modded build of [OpenCode](https://github.com/sst/opencode). It keeps working until a job is done
(`/goal`), runs subagent workflows in parallel, connects to ~90 apps (`/apps`), and is easy to extend with your
own mods. It installs next to stock OpenCode and never changes it.

## See it

<table>
  <tr>
    <td width="50%"><img src="assets/commands.png" alt="Slash command menu"><br><sub>Type <code>/</code> for every command.</sub></td>
    <td width="50%"><img src="assets/goal.png" alt="The /goal command"><br><sub><code>/goal</code> works until the goal is built and verified.</sub></td>
  </tr>
</table>

## Install

InfiniteOC is a private, invite-only repository: only people the owner added can install it. You need
[Node.js 22+](https://nodejs.org), [Git](https://git-scm.com) and the
[GitHub CLI](https://cli.github.com) (to prove you have access). No administrator rights.

Sign in once so git and gh can clone it:

```sh
gh auth login        # also wires git's credential helper (gh auth setup-git)
```

**macOS / Linux**

```sh
gh api -H "Accept: application/vnd.github.raw" /repos/InfiniteOC/InfiniteOC/contents/install.sh | sh
```

**Windows** (PowerShell)

```powershell
(gh api -H "Accept: application/vnd.github.raw" /repos/InfiniteOC/InfiniteOC/contents/install.ps1) | iex
```

That's it. Open a new terminal, go to a project and run:

```sh
infiniteoc
```

The first run asks a few setup questions (provider, model, theme); Enter skips any of them. With no provider you
get OpenCode's free model; add Claude, GPT, Gemini or others later with `/connect`. Where a prebuilt binary
exists for your system it starts right away; otherwise the first run builds it (a few minutes). If
`infiniteoc` is not found, the installer printed the folder to add to your PATH.

## Everyday use

| Type this in InfiniteOC | What it does |
| --- | --- |
| `/goal <what done means>` | Works on its own until the goal is built, tested and verified. `/goal stop` ends it. |
| "make me a …" | Something new gets its own project in `~/infiniteoc-projects` (the agent creates it, `git init`s it and moves there); "open my … project" switches. |
| `/apps` | Connect GitHub, Google, Cloudflare, Discord, Telegram, iMessage, Figma, Linear, Notion and more. |
| `/connect` | Sign in to an AI provider (Claude, GPT, Gemini, ...). |
| `/settings` | Custom providers, proxy/Tor, updates, workflows. |
| `/workflows` | See and cancel background subagent workflows. |
| `/account` | Switch between several logins per provider. |
| `/routing fallback opencode/beam-free` | When your model is rate limited or down (a free tier's 429 included), the run continues on this one. |
| `/ponytail auto` | Minimal-code mode: smallest change that solves it. |
| `/yolo` | Auto-approve permission prompts for this session (asks first). |
| `/classic` | Switch from InfiniTUI (the default Go interface, see [mods/infinitui](mods/infinitui/README.md)) to the classic OpenCode UI on the same session. `"tui": "classic"` in settings makes it permanent. |

From a shell:

| Command | What it does |
| --- | --- |
| `infiniteoc [folder]` | Start InfiniteOC (resume with `infiniteoc -s SESSION_ID`). |
| `infiniteoc new NAME` | Create a project in `~/infiniteoc-projects` and open it (`--template node\|python\|web`); `infiniteoc projects` lists them. |
| `infiniteoc connect` | List or add app connectors (same as `/apps`). |
| `infiniteoc graph` | A local, Obsidian-style graph of your projects, sessions and notes. |
| `infiniteoc web` | The browser UI, with a one-time sign-in link. |
| `infiniteoc doctor` | Check that everything is set up; `--fix` repairs it. |
| `infiniteoc update` | Update now (it also checks by itself every 6 hours). |

## Make your own mod

```sh
infiniteoc feature new my-mod      # creates ~/.config/infiniteoc/mods/my-mod
infiniteoc feature enable my-mod   # checks it, then turns it on
```

Your mods live in `~/.config/infiniteoc/mods`, a folder of your own (a local git repository with no remote),
not in the InfiniteOC install. So updates never fight your changes, and an AI that writes a mod for you commits
it there instead of trying to push to InfiniteOC; installs refuse to push. Mods are trusted code: only enable
ones you have read. How to write one: [FEATURES.md](FEATURES.md).

## Update and uninstall

InfiniteOC updates itself at launch (choose auto, ask or off in `/settings`). To remove it:
`sh ~/.infiniteoc/uninstall.sh` (macOS/Linux) or `& "$env:LOCALAPPDATA\InfiniteOC\uninstall.ps1"` (Windows).
Your stock OpenCode, its sessions and settings are never touched.

## More

- [GUIDE.md](GUIDE.md): everything that is built in, connectors, graph, builds, configuration.
- [LAUNCHER.md](LAUNCHER.md): install options, prebuilt binaries, serve/web, remote control, mod packs, bench.
- [FEATURES.md](FEATURES.md) and [AGENTS.md](AGENTS.md): writing mods (for you and for AI agents).
- Working on InfiniteOC itself: clone this repository, `node bin/infiniteoc.mjs setup`, `npm test`. To check that a
  change makes real runs better, compare two checkouts with [scripts/eval](scripts/eval/README.md).

Independent community project, not affiliated with the OpenCode authors. No OpenCode source is vendored here:
setup clones the pinned upstream tag (MIT) and builds from a copy. License: [MIT](LICENSE) ·
[NOTICE.md](NOTICE.md) · [SECURITY.md](SECURITY.md).
