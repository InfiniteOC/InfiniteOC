# session-import

Continue Claude Code and Antigravity CLI sessions in InfiniteOC. Foreign
transcripts become ordinary sessions through the backend's session-import
API, so the agent continues with full history.

## Quick start

```sh
infiniteoc serve   # note the backend URL and password
node mods/session-import/import.mjs --list
node mods/session-import/import.mjs --read <id> --from claude
IOC_IMPORT_PASSWORD=... node mods/session-import/import.mjs --import <id> --from claude --upstream http://127.0.0.1:4096
```

Then open the TUI on that backend; the imported session is in `/sessions`.
`/import` in the TUI browses the foreign sessions on this machine and shows
the same steps.

## Sources

- Claude Code: `~/.claude/projects/*/[uuid].jsonl` (main sessions;
  `agent-*.jsonl` subagent forks are skipped).
- Antigravity CLI: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`,
  with titles from `conversation_summaries.db` when readable.

## Fidelity (v1, text-first)

- User and assistant text import fully, oldest first, capped at 60k
  characters (the cap is disclosed in the transcript when hit).
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
