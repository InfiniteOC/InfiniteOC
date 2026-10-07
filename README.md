# InfiniteOC

A source-backed OpenCode launcher and mod framework, pinned to **OpenCode v2.0.21**. It copies upstream into a disposable worktree, applies trusted JavaScript source mods, builds a separate CLI/TUI binary, and launches it without touching your installed stock OpenCode.

The bundled mod adds a purple/pink theme, an animated terminal logo, and InfiniteOC as the default primary agent. No permission rules or approval requirements are weakened. Details: [mods/infiniteoc/README.md](mods/infiniteoc/README.md).

## Requirements

Linux x64, Node.js 22+, npm, Git, and provider credentials. First setup also needs internet access and disk space for the upstream source, dependencies, and build.

## Quickstart

```sh
ROOT=/path/to/InfiniteOC  # absolute path of your checkout
node "$ROOT/bin/infiniteoc.mjs" setup
node "$ROOT/bin/infiniteoc.mjs" /path/to/project
```

## Commands

| Command | Purpose |
| --- | --- |
| `setup` | Prepare and build, reusing a cached binary when possible. |
| `rebuild` | Recreate the worktree from pristine upstream, reapply mods, rebuild. |
| `mods` | List configured mods (importing them — only enable trusted mods). |
| `doctor` | Check pinned source and tools; may download them. |
| `-- [args]` | Forward arguments to OpenCode. |

`npm run setup`, `npm start -- [args]`, and `npm test` also work from the repo root. Never edit `.runtime/opencode` directly — rebuild deletes that tree; edit mods instead.

## Configuration

`infiniteoc.json` lives beside this README:

```json
{
  "upstream": "v2.0.21",
  "mods": ["./mods/infiniteoc/index.mjs"],
  "options": { "reducedMotion": false }
}
```

Mod paths are relative to the repo root and order matters. See [AGENTS.md](AGENTS.md) for the agent entry point.

## Features and skills

- New TUI slash commands: `node bin/infiniteoc.mjs feature new my-feature` — see [FEATURES.md](FEATURES.md).
- Live ctx-only command reload without restart: see [OPENDAEMON.md](OPENDAEMON.md).
- Bundled skills live in [skills/](skills/); mod API and safety rules: [skills/infiniteoc-mod-development/SKILL.md](skills/infiniteoc-mod-development/SKILL.md).
- Settings UI (`/settings` → InfiniteOC Settings) covers traffic/proxy and provider setup — see [mods/infiniteoc/settings/README.md](mods/infiniteoc/settings/README.md).

## Tests

```sh
npm test
```

Framework tests need only Node built-ins. Compiled-binary and interactive-TUI behavior need separate build/manual validation — see [VERIFICATION.md](VERIFICATION.md).

## Trust boundary

Mods are trusted local JavaScript, not sandboxed. Review any mod before enabling it, and never use untrusted mods with secrets available.
