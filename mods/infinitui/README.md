# infinitui: InfiniTUI, the Go terminal interface

InfiniTUI replaces OpenCode's OpenTUI interface with a [Bubble Tea](https://github.com/charmbracelet/bubbletea) v2
client written in Go. It talks to the same OpenCode v2 server over HTTP and the `/api/event` stream, so every
server-side feature (agents, tools, `/goal`, `/auto`, `/budget`, workflows, safety gates, …) works unchanged.

## How it plugs in

- `index.mjs` patches `packages/cli/src/commands/handlers/default.ts`. After the default command has resolved its
  server (the private `serve --stdio` child, or `--server URL`), it runs the InfiniTUI binary with the server URL and
  password instead of OpenTUI's `run()`. The Bun process stays alive as the server's lease holder.
- The `beforeLaunch` hook builds the binary from `.tui/` into `.runtime/infinitui/` (only when the sources
  changed; a stamp file keeps launches instant) and sets `INFINITEOC_GO_TUI`. `serve`, `run`, `web` and every other
  subcommand are untouched.
- The Go sources live in a dot-directory so a TUI-only change never triggers an OpenCode rebuild (the launcher
  fingerprint skips dotfiles).
- Release zips carry a prebuilt `infinitui` plus its source stamp (`scripts/package-release.mjs`,
  `scripts/fetch-prebuilt.mjs`, `.github/workflows/release.yml`), so release installs need no Go toolchain.

### Falling back to the classic interface

Nothing ever leaves you without a UI:

| Situation | Result |
| --- | --- |
| Go missing or `go build` fails | classic UI, with a startup notice saying why |
| `INFINITEOC_TUI=classic` or `"tui": "classic"` in `~/.config/infiniteoc/settings.json` | classic UI |
| `/classic` inside InfiniTUI | exits 75; the classic UI opens on the **same session** |
| InfiniTUI panics | crash report in `~/.local/state/opencode/infiniteoc/infinitui-crash.log`, then the classic UI |
| last-good fallback launch (no hooks run) | classic UI |

`INFINITEOC_TUI=infinitui` forces it on even when settings say classic.

## Using it

| Key | Action |
| --- | --- |
| `enter` | send (while the agent runs: steer it; the message lands at the next step) |
| `shift+enter` `alt+enter` `ctrl+j`, or a trailing `\` | newline |
| `↑` `↓` / `ctrl+r` | prompt history (shared with the classic UI) / search it |
| `/` | commands: local ones, server commands, and InfiniteOC views |
| `@` / `#` | mention agents, skills, references and files / files only (mods/hash-mentions semantics) |
| `!cmd` | run a shell command in the session |
| `esc` | interrupt; inside a subagent view, back to the parent |
| `esc esc` | timeline: jump to, rewind to (restores files) or fork from any prompt |
| `ctrl+c` | clear the prompt → interrupt → (twice) exit |
| `shift+tab` / `ctrl+t` / `f2` | next agent / next effort level / model picker |
| `/effort` (`ctrl+x v`) | effort slider: ←→ between the model's levels, faster to smarter, enter applies |
| `ctrl+o` | expand every tool output; click a block to expand just that one |
| `ctrl+p` | command palette |
| `ctrl+l` / `ctrl+n` | sessions / new session |
| `ctrl+y` | copy the last response |
| `alt+↑` `alt+↓` | previous / next turn |
| drag in the transcript | select and copy (mouse capture hides the terminal's own selection) |
| `ctrl+x` then `n l m a v u r c y e t g s b x q →` `←` | leader keys (help: `f1`) |

What you get beyond the classic UI:

- Its own look: an animated braille ∞ mark and ∞ spinner; each prompt is a tinted band with a turn badge and its
  time, and the turn's answer hangs off a purple→pink thread from that badge: `◆` replies, `∴` thinking and tool
  calls are nodes on it, and it ends in `╰─ 24s · ↓ 298 tokens · model`. The composer is a frame whose borders
  carry the agent, model, effort level, YOLO/goal state, a context meter and cost, plus key hints that follow what
  you are doing. Cards and dialogs use the same frame.
- It moves well: replies stream in at a steady pace instead of in network-sized chunks, scrolling glides, toasts
  slide in with a draining countdown edge, palette switches (InfiniCode on/off, themes) crossfade, a light orbits
  the composer frame while the agent works, and a pending node waits on the thread until the first token arrives.
- Code blocks are framed with their language and line numbers; click one to copy it. Click a prompt band for its
  menu (copy prompt or reply, rewind, fork). Hover a block and its stretch of the thread lights up.
- Long sessions: a scrollbar with a tick per turn, `alt+↑`/`alt+↓` to jump between turns, and an OUTLINE of
  every prompt in the sidebar (the one in view is lit; click to jump).
- The composer colours `/commands`, `@mentions`, `#files` and `!shell` as you type, and a big paste becomes a
  `[pasted #1 · 120 lines]` chip that expands when you send. Shortcuts show as keycaps in menus and help, the
  completion popup has per-kind icons, the session picker previews the latest exchange, and the live activity
  line shows tokens and tokens per second. While the agent works the window title spins and terminals that
  support OSC 9;4 show progress in the tab.
- Finished turns glow green for a moment (`╰─ ✓ 26s · …`), failures are red cards on the thread, written files show
  as framed code blocks (click to copy), shell output that is a diff keeps its colours, and a new session's title
  types itself into the header when the server names it. The home screen rotates tips and opens recent
  sessions with `alt+1`…`alt+3`. Reduced motion (`INFINITUI_NO_ANIMATIONS=1`, or on battery via prov-kit) turns
  every animation into an instant change.
- Runs of read-only tool calls (reads, searches, listings, fetches) fold into one "Explored · 3 files, 2 searches"
  row; click it to list them. Edits, shell commands and subagents stay on their own rows, with inline
  syntax-highlighted diffs (word-level emphasis), a live activity line, and trivial sub-3-second thoughts hidden.
- Permission and question cards replace the prompt: numbered options, single-key answers (`y s a n`), a diff or
  command preview, **allow for this session**, and **reject with a message** to tell the agent what to do instead.
  Requests from subagents surface in the parent view.
- Subagent tasks show live progress (current tool, tool count, tokens); click one to open the child session.
- A HUD sidebar on wide terminals (`ctrl+x b`): context meter, tokens and cache rate, cost, net file changes of the
  session, running subagents, MCP status, and the `/goal` state.
- The `/context`, `/octx`, `/memory`, `/pins`, `/workflows` and `/usage` views come from the server
  (`/api/rpc/infiniteoc`, mods/webui) and render generically, so they stay in sync with those mods.
- The purple/pink theme, plus light and the red InfiniCode palette (used while the `infinicode` effort level is
  selected), with hand-picked fallbacks for 256-colour terminals.
- With mods/fastlane: starting to type a prompt opens provider connections ahead of the request, and
  `/reconnect` recovers at once after a network or VPN change that fastlane did not notice by itself.
- `/yolo`, `/infinicode`, desktop notifications when a run ends or needs you while the terminal is unfocused,
  opendaemon notices, `INFINITEOC_NOTICE`, and `tui.toast.show` / `tui.session.select` / `tui.prompt.append` /
  `tui.command.execute` events from server plugins.

Classic-UI features that only exist as OpenTUI code (`/apps`, `/account`, `/settings`' InfiniteOC dialog,
`/health`, `/import`, `/find`, `/display`, `/voice`, tabs) are one `/classic` away.

State it shares with the classic UI: `~/.local/state/opencode/model.json` (recent/favourite models, effort per
model) and `prompt-history.jsonl`. Its own preferences (theme, sidebar, thinking view) live in
`~/.local/state/opencode/infiniteoc/tui/infinitui.json`.

## Developing

```sh
cd mods/infinitui/.tui
go test ./...                                   # unit tests (also run by npm test)
go run ./cmd/infinitui                          # standalone: starts its own `opencode serve --stdio`
OPENCODE_BIN=../../../.runtime/opencode/packages/cli/dist/cli-linux-x64/bin/opencode go run ./cmd/infinitui
OPENCODE_PASSWORD=pw go run ./cmd/infinitui --server http://127.0.0.1:4096
URL=... PW=... DIR=$PWD MODEL=... TEXT=... go run ./cmd/probe   # dump the event stream of one prompt
```

Layout: `internal/api` (HTTP client, SSE, IDs, wire types), `internal/ui` (store that mirrors server events, transcript
and tool renderers, prompt and completion, dialogs, permission/question cards, sidebar), `internal/render`
(markdown, diffs, syntax highlighting), `internal/theme`. The next launch rebuilds the binary by itself.
