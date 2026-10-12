# tnav-nav

TUI navigation for InfiniteOC. One built-in TUI plugin (`infiniteoc.tnav`, written to
`packages/tui/src/feature-plugins/tnav/`) plus a few small anchored patches.

| Command | What it does |
| --- | --- |
| `/find <text>` | Full-text search over every stored session (message text, shell output, tool inputs). Enter opens the session as a tab and scrolls to the message. |
| Command palette | While a filter is typed, also lists matching sessions, project files (inserts `@path` in the prompt) and a "search message text" hand-off to `/find`. Commands and settings were already searchable. |
| `/tree` (`/branches`) | Fork tree of the current conversation (all forked conversations from home). First row forks from a message with the upstream fork picker. |
| `/mark`, `/bookmarks` (`/marks`), `/mark-next`, `/mark-prev` | Bookmark user messages (also "Bookmark" in the message actions dialog), list them across sessions, step through them with `alt+]` / `alt+[`. Stored in the TUI storage as `tnav-bookmarks.json`. |
| `/minimap` | Toggles the one-row strip above the prompt: a cell per message (user, assistant, edit `+`, error `x`, shell `$`, bookmark). Click a cell to jump. On by default. |
| `/changes` (`/livediff`) | Side pane with the files this session changed and the diff of the selected file (upstream `PatchDiff`). Refreshes when an edit tool finishes. `j/k`, `space/b`, `f`, `q` while focused. |
| `/title` | Edit the session title in place. Clicking the title in the sidebar does the same; when the sidebar is hidden the editor appears above the prompt. Enter saves, Esc cancels. |
| `/split` | Read-only live view of a second session in the side pane. `s` swaps it with the main session, which is the interactive one. |
| `/transcript [md\|html]` | Writes the session to a Markdown or HTML file with tool-call diffs and a Changes section of full file diffs. Asks for the path and before overwriting. Upstream's `/export` is unchanged. |
| `/voice` | Dictation with a local whisper CLI (`whisper-cli`, `whisper-cpp`, or the `whisper` Python tool) and `ffmpeg` or `sox` for recording. Enter stops and inserts the text in the prompt; Esc discards. Reports what is missing instead of installing anything. |

Image paste needs no mod: upstream already reads `image/png` from the host clipboard on macOS (ctrl+v, empty bracketed
paste, and pasted image paths all attach the image).

## Upstream patches

All through `api.patchExact`, one anchor each (see `patches` in `index.mjs`): `plugin/builtins.ts` (register the plugin),
`routes/session/index.tsx` (register `jumpToMessage`), `routes/session/dialog-message.tsx` (Bookmark action),
`routes/session/sidebar.tsx` (click-to-edit title), `component/command-palette.tsx` (extra results).

## Tests

`node --test mods/tnav-nav/test.mjs` checks every anchor against the pinned source, that setup writes every plugin file, and
the pure logic in `tui/logic.ts` and `tui/voice.ts` (Node loads the `.ts` files directly).
