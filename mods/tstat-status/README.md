# tstat-status

Status and feedback surfaces for the TUI. One builtin plugin (`tstat.tsx`) plus small anchored patches.

- Desktop notifications (macOS `osascript`, Linux `notify-send`) when a run finishes, fails, a `/goal` ends, or a permission/question waits. Skipped while the terminal is known to be focused; on by default.
- Sound cues (macOS `afplay`, Linux `paplay`): Glass = done, Basso = error, Ping = waiting. Off by default.
- Errored tabs show `x`; running, waiting (`!`, `?`) and done markers are upstream's.
- Subagent progress in the prompt footer while subagents run: `agents ▰▰▱▱▱▱▱▱ 1/3 done, 2 running`.
- Home dashboard: git status of the project, update status of this checkout (local, no network), recent sessions.
- Tool bodies (writes, diffs) are capped at 14 lines; click the hint or run `/expand` to open all. Shell output keeps upstream's own expand.
- Permission prompt: `Allow for session (s)` plus single keys `y`, `a`, `n`. Session allow covers the same action and patterns "always" would save, for that session family only, in memory.
- `/zen` hides tabs, sidebar and footer details.
- Terminals that never report light/dark get it from the OSC 11 background color at startup.
- Footer usage meter: `in 12K out 3K`, plus `budget N%` when a budget is set.
- Nerd Font icons: `auto` (Kitty, WezTerm, Ghostty, or `NERD_FONT=1`), `on`, `off`.

`/tstat` opens the settings menu (saved through the TUI's storage). `/zen` and `/expand` are session toggles.
Upstream's own `attention` config (terminal notifications and bundled sounds) is independent and unchanged.
