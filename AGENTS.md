# InfiniteOC feature development

Read `/home/rize/InfiniteOC/FEATURES.md` first for new features. For source mods,
also read `/home/rize/InfiniteOC/skills/infiniteoc-mod-development/SKILL.md`.

- Local UI slash commands: prefer `api.tui.command` and a typed `command.tsx`.
- Live ctx-only command updates: read `/home/rize/InfiniteOC/OPENDAEMON.md`; use
  `opendaemon reload/status/watch`. Do not run full rebuild during active agent
  work or claim compiled backend patches were applied live.
- Scaffold: `node /home/rize/InfiniteOC/bin/infiniteoc.mjs feature new ID`.
- Check: `node /home/rize/InfiniteOC/bin/infiniteoc.mjs feature check ID`.
- **Tabs are not sessions**: closing UI tabs must not delete stored conversations,
  interrupt tasks or submit prompts. `/clearall` is the working reference.
- Persistent changes belong in `/home/rize/InfiniteOC/mods`, never in generated
  `.runtime` or pristine `.upstream` trees.
- Use `api.patchExact` when a unique source anchor is needed; preserve mod order.
- Test with `node --test /home/rize/InfiniteOC/test/*.test.mjs`; rebuild and interact
  before asserting UI success. Builds require restarting; there is no binary hot reload.
- Preserve provider secrets, permissions, stock installations and session history.