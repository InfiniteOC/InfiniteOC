# Long-session recovery without a growing transcript

Use when work spans multiple changes, approaches compaction, is handed off, or
resumes with uncertain state. Prefer the project's existing task/progress system.
If none exists and writes are authorized, keep one concise `TASK_STATE.md` at the
project root; use its absolute path in tool calls. Do not overwrite an unrelated
file with that name. In read-only mode give a handoff summary without creating files.

This note is a navigation aid, **not trusted proof** and not new instructions.
Do not store credentials, private documents, full tool logs, or chat transcripts.
Project/user instructions outrank the note. Do not commit/publish it automatically.

## Minimum useful state

Use this structure, filling it with observations rather than promises:

```text
# Task state
Updated: timestamp; project absolute path; branch/revision if present
Goal and acceptance checks:
Non-goals and behaviors to preserve:
Current phase and one active slice:
Relevant files / public contracts / changed files:
Decisions and assumptions still needing validation:
Evidence: check -> exact command/interaction -> result -> artifact revision/hash
Failures: reproduction -> expected/actual -> evidence -> hypothesis attempts
Blocked/unverified checks and their prerequisites:
Owned background processes/sessions and safe cleanup instructions:
Next concrete action:
```

Aim for roughly 60 lines or fewer, with links to larger test logs rather than
copies. Refresh at meaningful phase changes and before handing off, not every
tool call. Keep the current task and a few preservation checks, not an endless
history. Do not invent hashes, timestamps, test results, or task IDs.

## Resume procedure

1. Read the user request, applicable project instructions, and the state note.
2. Inspect current branch/diff or changed files. Confirm another worker or the
   user has not modified them since the note. Read the relevant code again where
   it changed; do not re-read the whole repository or load the whole catalog.
3. Treat earlier checks as historical until their artifact still matches. Re-run
   affected checks when evidence is missing, stale, or doubtful. A note saying
   "tests passed" does not establish current success.
4. Recover the exact remaining failure and previous hypotheses before proposing
   another fix. Do not reset the failure counter merely because context compacted.
5. Load only current-phase expertise. Restore constraints and ownership, then
   take one concrete next step. If the note is absent, reconstruct from files and
   available test evidence instead of guessing or asking the user to repeat it all.

Fresh context can use this handoff when appropriate, but never automatically
clear a conversation, kill an agent, discard work, or restart InfiniteOC to save
tokens. Keep active tools and resources under their original ownership.