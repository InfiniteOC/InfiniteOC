# Local auto-route reliability update

Maintained source: `/home/rize/InfiniteOC/skills/auto-route/`.
Active OpenCode library: `/home/rize/.config/opencode/skill-library/auto-route/`.

This improves the existing general-purpose router, not model choice or permissions.
The main skill keeps all domain routes. Software reliability, state recovery, and
helper details are loaded from references only when relevant. No dependencies or
remote skill packages are installed.

- `scripts/find.py`: metadata-only catalog search. Supports existing query,
  category, and category-list arguments plus `--json`, `--include-missing`, and
  `--catalog`. Missing skill paths are excluded by default; `file-present` is not
  a claim of runtime capability. Search rank is not a quality score.
- `scripts/route.py`: optional deterministic advisory policy over explicit facts.
  It cannot force agent compliance or establish whether a feature actually works.
- `references/catalog.json`: existing local catalog with the previously omitted
  installed `playwright-cli` indexed. Catalog paths are specific to this host.

## Validate

```sh
node --test /home/rize/InfiniteOC/test/auto-route-*.test.mjs
node --test /home/rize/InfiniteOC/test/*.test.mjs
```

The routing tests check decisions and invalid inputs; search tests check real CLI
behavior with disposable catalogs. They are not a benchmark proving that every
model follows the skill or that the user's book app is fixed.

## Installation and rollback

Before installing, back up the active auto-route directory and the global
`/home/rize/.config/opencode/AGENTS.md`. Update only this skill's owned files;
preserve catalog entries and unrelated instructions/configuration. Publish helpers
and references first, then `SKILL.md`, using atomic file replacement. Do not modify
the separate Claude skill mirror: it has its own tool conventions and additions.

The global routing paragraph should request phase re-evaluation without requiring
unchanged skill bodies to be reloaded on every turn. No binary rebuild is needed
to edit these files. Already loaded skill text may remain cached or present in a
conversation. Do not claim that a file update rewrites an active agent's context.
If the native tool returns old text, read the updated installed `SKILL.md` and
needed references directly, subject to permissions. Starting a new conversation
does not guarantee the location's cached registry is refreshed. The pinned source
has a skill-file watcher; check returned content before claiming refresh. Never
restart an active agent solely to refresh guidance.

Rollback restores only this skill and its edited routing paragraph from the backup;
do not overwrite subsequent unrelated user edits. No model/provider configuration,
permission rules, stored sessions, or source-generated runtime files are changed.