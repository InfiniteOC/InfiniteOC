# session-import

Continue Claude Code and Antigravity CLI sessions in InfiniteOC. Foreign
transcripts become ordinary sessions through the backend's session-import
API, so the agent continues with full history.

## Quick start

Type `/import` in the TUI, pick a session (newest first, Claude Code and
Antigravity together) and it opens, ready to continue. It runs in the session's
original project folder when that still exists, else in the current one.
Picking the same session again opens the copy made the first time.

Scripts can use the CLI against a running backend instead:

```sh
node mods/session-import/import.mjs --list
node mods/session-import/import.mjs --read <id> --from claude
IOC_IMPORT_PASSWORD=... node mods/session-import/import.mjs --import <id> --from claude --upstream http://127.0.0.1:4096
```

## Sources

- Claude Code: `~/.claude/projects/*/[uuid].jsonl` (main sessions;
  `agent-*.jsonl` subagent forks are skipped).
- Antigravity CLI: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`,
  with titles from `conversation_summaries.db` when readable.

## Fidelity (v1, text-first)

- User and assistant text import in order, up to 240k characters: a longer
  session keeps its first request and its newest turns, with a note where
  earlier turns were left out.
- Assistant turns arrive as marked messages (origin + model note), since
  foreign model refs are not backend models; no model identity is faked.
- Thinking blocks import truncated to 1000 chars and marked; tool calls
  become one-line summaries; images are omitted with a marker.
- Sessions over 50MB are refused with a message instead of stalling.

## Configuration

`--home DIR` overrides the home directory (tests, alternate machines).
Backend password from `IOC_IMPORT_PASSWORD`, `IOC_PROXY_PASSWORD` or
`OPENCODE_PASSWORD` (env only, never logged). `--dir` overrides the session
directory (defaults to the original cwd when it still exists).

## Rollback

`node bin/infiniteoc.mjs feature disable session-import` (or remove its
entry from `infiniteoc.json`); the next launch rebuilds without it.
Imported sessions are ordinary sessions and stay until deleted.
