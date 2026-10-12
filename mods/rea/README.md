# rea

Reverse-engineer shipped apps from InfiniteOC without touching the REA checkout
(the local repo stays untouched).

REA (`rea-agents@4.0.1`, MIT, https://github.com/morluto/rea) exposes
reverse-engineering tools through a CLI and an MCP server: native binaries via
Hopper or bring-your-own Ghidra, plus static JavaScript/Electron, .NET, browser,
firmware, and Android inspection with inline Evidence. This mod wires it into
InfiniteOC and leaves `/home/rize/rea` alone: it uses the pinned npm package,
never a local path.

## What this mod does

- Appends REA routing guidance to the primary agent (`build`): when to use REA,
  how to check for MCP tools, the approval-required setup flow, the JS/ASAR CLI
  fallback, and Evidence rules. It patches only the
  `// infiniteoc:guidance-extensions` marker written by `mods/infiniteoc`, so it
  must run after that mod.
- Registers `/rea` (category Mods): a read-only status/setup helper. It reads
  the global OpenCode config and the installed skill file, then shows copyable
  terminal commands. It writes nothing and installs nothing.

## Setup (approval required)

`/rea` never applies changes. Run these in a terminal, review, approve, restart:

```sh
npx -y rea-agents@4.0.1 doctor --client opencode --json
npx -y rea-agents@4.0.1 setup --client opencode --dry-run --json
# after approving the exact paths, backups, and changes:
npx -y rea-agents@4.0.1 setup --client opencode --yes
```

Setup pins MCP to the exact version, installs the matching
`reverse-engineer-anything` skill to `~/.agents/skills/`, preserves unrelated
config, and keeps backups. Never add `--install-hopper` unless Hopper was
needed and explicitly approved. REA never installs Node/npm/Java/Ghidra.

No MCP registration or engine is needed for static JS/ASAR:

```sh
npx -y rea-agents@4.0.1 analyze-javascript-application /absolute/path/to/app --json
```

Native analysis needs Hopper or `GHIDRA_INSTALL_DIR` pointing at Ghidra 12.1.4
with JDK 21. On Arch derivatives `doctor` may report `unsupported_host`;
static JS/CLI work still applies.

## Enable

```sh
node bin/infiniteoc.mjs feature check rea
node bin/infiniteoc.mjs feature enable rea
```

Rollback: `node bin/infiniteoc.mjs feature disable rea`, then restart.
The next launch rebuilds.
