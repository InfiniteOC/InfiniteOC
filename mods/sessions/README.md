# sessions

Read-only access to any session on this machine: `session_data {action: "list"|"read"|"search"}`.
Never modifies, deletes or prompts; the call itself stays visible in the transcript as the audit trail.
Reads OpenCode's databases opened read-only (same pattern as `src/graph.mjs`).
