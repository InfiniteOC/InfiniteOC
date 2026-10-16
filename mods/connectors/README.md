# connectors

`/apps` (alias `/connectors`) in the TUI and `infiniteoc connect` in a shell: add apps to the agent as MCP servers.

- `catalog.mjs` — the apps. Each remote URL was checked to answer as an MCP server; OAuth ones register clients
  themselves (DCR/CIMD), open ones answered `tools/list` and a tool call without credentials. Local commands come
  from each project's README. Community servers that receive a secret are pinned (Discord `mcp-discord@1.3.4`,
  iMessage `mac-messages-mcp@1.1.0`, Workspace `workspace-mcp@2.1.0`, Obsidian `mcp-obsidian@0.2.3`, Telegram a
  commit of `chigwell/telegram-mcp`: never PyPI's `telegram-mcp`, which its maintainers say is an unrelated project).
- `connectors.mjs` — config writes shared by the CLI and the TUI: keeps every other key, writes a `.bak`, refuses
  JSONC or a JSONC overlay, never replaces without `force`. Secrets → mode-600 key files referenced as `{file:…}`;
  empty required values → `{env:NAME}`; optional ones are left out. `disconnect` removes the entry and only the key
  files it created.
- `dialog.tsx` — the `/apps` dialog, written to `packages/tui/src/component/dialog-apps.tsx` and registered beside
  upstream's `/mcps` (a source patch: it renders upstream components, which live ctx-only commands cannot import).
  Adding writes the config and calls the server's `mcp.add` with the references resolved, so the app connects
  without a restart; OAuth apps open upstream's `DialogIntegration` sign-in. Remove = config + key files +
  `mcp.remove`. It reuses the masked `SecretPrompt` from `mods/infiniteoc` (enable that mod first).

Not covered automatically: completing a real OAuth sign-in or a real Discord/Telegram/iMessage session. Verified by
hand in a disposable build: list and search, Context7 connecting live, Discord's masked token landing in a key file,
Linear opening upstream's OAuth page, Remove, and Esc leaving the config untouched.

Tests: `node --test mods/connectors/test.mjs`.
