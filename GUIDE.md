# InfiniteOC guide

The full reference. The short version is in [README.md](README.md); installing, updating and the launcher's
own features are in [LAUNCHER.md](LAUNCHER.md); writing mods is in [FEATURES.md](FEATURES.md).

## What is built in

Enabled mods: `infiniteoc` (purple/pink theme, animated wordmark, InfiniteOC as the default primary agent, settings UI, pinned-build guards; [README](mods/infiniteoc/README.md)), `clearall` ([/clearall](mods/clearall/README.md)), `health` ([/health](mods/health/README.md)), `deep-deliberation` (adds planning guidance to the agent prompt), `awareness` ([README](mods/awareness/README.md)), `hash-mentions` ([README](mods/hash-mentions/README.md)), `tool-perf` ([README](mods/tool-perf/README.md)), `path-repair` (repairs file text that a model leaked into a tool's path argument instead of failing or creating junk folders; [README](mods/path-repair/README.md)), `lean-context` (one-line skill catalog and a smaller Code Mode listing on every request; [README](mods/lean-context/README.md)), `yolo` ([/yolo](mods/yolo/README.md)), `webui` (InfiniteOC's purple/pink theme and title for the web UI of `infiniteoc web`; [README](mods/webui/README.md)), `accounts` (several logins per provider, switched with `/account`; [README](mods/accounts/README.md)), `workflows` (background DAG workflows of subagents that message each other, with a model chosen per step; off until `workflows.enabled` is set; [README](mods/workflows/README.md)) and `infinicode` (an extra **InfiniCode** effort level for every model: its strongest effort, workflows on, and a smooth fade to a red theme; [README](mods/infinicode/README.md)). The agent keeps upstream's base prompt and gets InfiniteOC guidance per agent, `reviewer` and `researcher` subagents, and the bundled skill library (see [mods/infiniteoc/README.md](mods/infiniteoc/README.md)). No permission rules or approval requirements are weakened. `/yolo` is an explicit, confirmed, runtime-only opt-in that auto-approves `ask` prompts; `deny` rules and safe-guard's always-ask gates still hold.

## Features

- New TUI slash commands: `infiniteoc feature new my-feature`; see [FEATURES.md](FEATURES.md). Agents start at [AGENTS.md](AGENTS.md).
- Frontend work: every agent must load the bundled [frontend-design](skills/frontend-design/SKILL.md) skill (adapted from Anthropic's, with a required plan, a measurable quality floor and a render-and-inspect loop) before editing UI files; edits are refused until it is loaded.
- `/goal <what done means>`: the agent keeps working, testing and verifying until the goal is met (or it reports `GOAL BLOCKED`); `/goal stop` or Esc ends it. The goal, its plan (kept with the `goal_progress` tool, which does not end the turn) and "don't stop to report" rules sit in the system prompt on every step, survive compaction, and a turn that only announces `Next: ...` is sent straight back to do it. While a workflow or background subagent it started is running, the goal waits for its completion notice instead of re-prompting (it resumes anyway after 5 minutes without progress). Details in [mods/infiniteoc/README.md](mods/infiniteoc/README.md).
- `/goal` in the TUI: the word glows as you type it, the footer shows the active goal and its turn (`goal 3/50 · ...`), and the start message reads `/goal <text>`.
- Ponytail ([github.com/DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), MIT, bundled in `skills/ponytail*`): the lazy-senior-dev ruleset (smallest complete change, fewer output tokens) is off by default, added only to turns that write code (implementation requests, turns that edit files, the `general` worker) and never to questions or read-only agents once enabled. `/ponytail auto|lite|full|ultra|off` switches it; "stop ponytail" turns it off for a session; `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-gain`, `/ponytail-help` run its skills.
- Subagents: `explore` runs on the provider's small model (Haiku, Flash or Luna) at minimal reasoning unless a model is configured for it (`INFINITEOC_FAST_EXPLORE=0` turns that off); explore and researcher stop at 30 steps and reviewer at 60; the guidance says when to use each one, and how to run them in parallel, in the background and as follow-ups.
- InfiniCode: `ctrl+t` past the model's highest effort, `/variants`, or `/infinicode` selects it. The model runs at its strongest variant (max, xhigh, the largest thinking budget; defaults for models without effort levels), workflows turn on, and the theme fades to red; leaving restores your workflows setting and theme, and `/infinicode` again also restores the previous effort. Remembered per model like any effort level, so it survives restarts; see [mods/infinicode/README.md](mods/infinicode/README.md).
- Workflows (on in this build's `infiniteoc.json`; `/settings` → InfiniteOC Settings → Workflows): the agent declares subagent steps with dependencies, they run in the background (parallel where independent), pass results on, message each other through a per-workflow mailbox, and each gets a fast, default or strong model from the providers you configured. Progress shows in the sidebar and footer; `/workflows` inspects and cancels. The agent is told not to poll; a repeated `status` with nothing new gets a short "no change" answer, and `status` with `wait: true` blocks once until something changes. Other mods flip `workflows.enabled` through the contract in [mods/workflows/README.md](mods/workflows/README.md).
- Projects (`mods/projects`): the agent's `project` tool creates a project in the InfiniteOC projects folder (`~/infiniteoc-projects`; `projects.root` in settings.json or `INFINITEOC_PROJECTS_DIR` move it) from a template (empty, node, python, web), runs `git init` and moves the session there through upstream's session move; `open` switches to another project and `list` shows them. Creating one goes through the permission system as action `project` (add `"project": "ask"` to your permission rules to be asked). From a shell: `infiniteoc new NAME`, `infiniteoc projects`.
- Awareness: project instructions also load from `CLAUDE.md` where a directory has no `AGENTS.md`; the environment block names the OS release and shell; the agent knows InfiniteOC's own commands and suggests `/goal` for long tasks.
- Accounts: keep several logins per provider (`infiniteoc auth login anthropic --label work`), switch with `/account` or `/settings` → InfiniteOC Settings → Accounts without restarting, and see the active one in the footer. They live in upstream's credential store in InfiniteOC's own `opencode-infiniteoc.db` (mode 600); stock OpenCode's `opencode.db` and `auth.json` are never written. Optional: switch to the next account on a rate limit. See [mods/accounts/README.md](mods/accounts/README.md).
- Live command reload without restarting: `opendaemon` (every launch starts it) and `/live` in the TUI; see [OPENDAEMON.md](OPENDAEMON.md).
- Bundled skills live in [skills/](skills/); mod API and safety rules: [skills/infiniteoc-mod-development/SKILL.md](skills/infiniteoc-mod-development/SKILL.md).

## Connectors

Type **`/apps`** inside InfiniteOC (alias `/connectors`): a searchable list of about 100 apps the agent can use,
grouped by category, with live status. Enter on an app asks for what it needs (secrets in a masked field), saves it
and connects it at once — no restart — and OAuth apps go straight to sign-in. Enter on a connected app offers sign
in, retry, pause, replace or remove. `infiniteoc connect` does the same from a shell (`--ask` prompts for values).

- **Cloudflare**: the whole Cloudflare API, docs, Workers bindings/builds/observability, containers, browser
  rendering, Logpush, AI Gateway, AI Search, audit logs, DNS analytics, DEX, CASB, GraphQL, Radar (all OAuth).
- **Google**: gcloud, Cloud Run, Cloud Storage, Logging & Monitoring, BigQuery, Firebase, Analytics, Workspace
  (Gmail, Drive, Calendar, Docs, Sheets, …), Maps, Maps code assist, developer docs, Chrome DevTools.
- **Apple** (macOS): Xcode's own MCP bridge (Xcode 26.3+), XcodeBuildMCP, Notes/Reminders/Calendar/Contacts/Mail,
  Apple developer docs, AppleScript/JXA automation.
- **Chat & messaging**: iMessage (macOS, Full Disk Access), Discord (bot token), Telegram (your account; API ID,
  hash and a session string from the server's own QR login).
- Plus GitHub, GitLab, Vercel, Netlify, Railway, Supabase, Neon, Prisma, Sentry, Stripe, AWS, Azure, Kubernetes,
  Linear, Jira & Confluence, Notion, Todoist, Miro, Dropbox, Figma, Canva, PostHog, Grafana, MongoDB, Postgres,
  Context7, DeepWiki, Microsoft Learn, Brave Search, Playwright, Blender, Obsidian and more.

Each one is a plain `mcp.servers.<id>` entry in the OpenCode config. Typed secrets go to mode-600 key files under
the InfiniteOC settings directory and the config holds only `{file:…}`; an empty answer stores `{env:NAME}`. Every
remote URL was checked to be a real MCP server that signs in by itself (servers that only accept pre-registered
apps — Slack, HubSpot, Box, Discord's hosted server, PagerDuty, Render — are left out), and community servers that
receive a secret are pinned to an exact version or commit. See [mods/connectors](mods/connectors/README.md).

## Graph

`infiniteoc graph` opens a local page with a force-directed graph of what InfiniteOC knows about your work:
projects and their recent top-level sessions (read-only from OpenCode's databases), the memory and glossary the agent
keeps per project, each project's `AGENTS.md`/`CLAUDE.md`, and your notes. Notes are markdown files in
`$XDG_DATA_HOME/infiniteoc/notes` (`INFINITEOC_NOTES_DIR` overrides) that link with `[[Note title]]` or
`[[project]]` and tag with `#tag`; a link to a note that does not exist yet shows as an unwritten node you can click
to write it. Notes are the only thing the page writes, and deleting one moves it to the folder's `.trash`.

Search with `/`, `N` writes a note, `F` fits the view, Esc closes the panel; the List view is the keyboard and
screen-reader path. Temporary projects (benchmark and scratch directories, deleted folders) are hidden until you
turn them on. The server listens on 127.0.0.1 only; the page's API needs the random token from the printed link
(kept in the tab, removed from the address bar) and rejects other Host names.

## Builds and launches

- A launch rebuilds only when `infiniteoc.json`, the framework or a mod changed; the build prints its reason, timed `[1/4]`…`[4/4]` steps and `Ready in Ns`.
- Rebuilds are incremental: the generated tree is synced back to the pinned source (only files mods touched are restored, `node_modules` stays), and the web UI archive is reused when nothing it is built from changed, or per compressed file otherwise. The source tree and the embedded web UI archive are byte-identical to a clean build's; `infiniteoc rebuild --clean` starts from nothing.
- `.runtime/prepare.lock` heals itself: a dead owner's lock (or a pid-less one older than 30 minutes) is reclaimed, a second launch waits and reuses the fresh build, and Ctrl+C removes it.
- Each successful build is kept in `.runtime/last-good`. If a build or mod fails at launch, that build starts instead, without mod hooks; fix the mod, then `infiniteoc rebuild`.
- That fallback, an unavailable opendaemon, or an unreachable Tor/SOCKS listener never stops a launch: it is printed and shown again as a TUI warning toast.
- OpenCode stays pinned: the binary never checks for or installs OpenCode updates, and the launcher and binary refuse `upgrade`/`uninstall` (and the binary's `update`), which would act on stock OpenCode and the sessions, credentials and config it shares. Remove InfiniteOC with `uninstall.sh`/`uninstall.ps1` (stock OpenCode data is left untouched).
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

Mod paths are relative to the checkout root and order matters. `reducedMotion: true` makes Animations default to off (applied at build time); an Animations choice made in the TUI still wins. It also turns off the launcher's animated update and build screens: builds then stream `bun` output as plain lines instead of the progress block (whose full output goes to `.runtime/build.log`). `webUi: true` builds upstream's web UI into the binary for `infiniteoc web` (off by default: it makes every build slower and use more memory; `infiniteoc web` offers to turn it on). Traffic (proxy/Tor) and custom providers live under `/settings` → InfiniteOC Settings; see [mods/infiniteoc/settings/README.md](mods/infiniteoc/settings/README.md).

## Requirements in detail

Linux (glibc), macOS or Windows, x64 or arm64; musl/Alpine is not supported. Node.js 22+, npm, Git, and provider credentials. No administrator is needed: the install, the PATH entry and the daemon transport are all per-user. First setup also needs internet access and disk space for the upstream source, dependencies (Bun is installed locally under `.tools`), and the build. The checkout can live anywhere short enough for its `.opendaemon/control.sock` path (104 bytes on macOS, 107 on Linux; `doctor` checks it), else live reload is off. On Windows the daemon uses a named pipe instead, so path length does not matter there.

## Tests

```sh
npm test    # node --test test/*.test.mjs mods/*/test.mjs
```

Tests use Node built-ins, temporary directories and the pinned `.upstream` checkout that `setup` clones; a few skip on Node versions without TypeScript type stripping. Compiled-binary and interactive-TUI behavior need a rebuild and a real terminal — see [VERIFICATION.md](VERIFICATION.md).
