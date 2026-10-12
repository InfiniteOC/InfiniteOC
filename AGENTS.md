# InfiniteOC feature development

Paths are relative to this checkout, which can live anywhere. Read `FEATURES.md`
first for new features. For source mods, also read
`skills/infiniteoc-mod-development/SKILL.md`.

- Local UI slash commands: prefer `api.tui.command` and a typed `command.tsx`.
  Ask with `ctx.ui` dialogs; toast actions are mouse-only.
- Live ctx-only command updates: read `OPENDAEMON.md`; use
  `opendaemon reload/status/watch` (or `/live` in the TUI). Do not run full rebuild
  during active agent work or claim compiled backend patches were applied live.
- Scaffold: `node bin/infiniteoc.mjs feature new ID`.
- Check: `node bin/infiniteoc.mjs feature check ID`; then `feature enable ID`
  (checks again, keeps `infiniteoc.json.bak`) or `feature disable ID`.
- **Tabs are not sessions**: closing UI tabs must not delete stored conversations,
  interrupt tasks or submit prompts. `/clearall` is the working reference.
- Persistent changes belong in `mods/`, never in generated `.runtime` or pristine
  `.upstream` trees.
- Use `api.patchExact` when a unique source anchor is needed; preserve mod order.
- Test with `npm test` (`node --test test/*.test.mjs mods/*/test.mjs`); rebuild and
  interact before asserting UI success. Builds require restarting; there is no binary hot reload.
- Preserve provider secrets, permissions, stock installations and session history.
