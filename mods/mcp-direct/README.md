# mcp-direct — pinned npx MCP servers run without npm

An MCP server configured as `npx -y pkg@1.2.3 ...` runs as two processes: `npm exec`, which stays alive for the
server's whole life, and the package's program under it. Once npx has installed the package in its cache, npx
always runs the same cached files, so the server spawns that program directly instead:

- `mcp/npx-direct.ts` (new): finds the program npx would run in `<npm cache>/_npx/<sha512(spec)[:16]>/node_modules/.bin`
  and puts that `.bin` first on PATH, as npx does.
- `mcp/stdio.ts`: spawns the resolved program when there is one.
- `environment/environment.ts`: `local` is true when processes spawn on this host. A workspace location spawns
  elsewhere, so it keeps npx.

npx keeps every case it has to decide itself: a tag or range (`@latest`, `^1`), no version, other npx flags, a
cached version that differs, several programs where none is named after the package, Windows, and a cache set
only in an `.npmrc` (`npm_config_cache` is read). The first launch after adding a server goes through npx, which
fills the cache. `INFINITEOC_MCP_NPX=1` keeps npx for every server.

Measured with this machine's config (`rea-agents@4.0.1`, plus servers that stay on npx or uvx):

| | through npx | direct |
|---|---|---|
| processes for the server | 2 (`npm exec` 130 MB + `node`) | 1 (`node`) |
| launch to `mcp connected` (3 interleaved launches each) | 3,849 / 4,106 / 4,290 ms | 3,419 / 3,542 / 3,607 ms |
| spawn to `initialize` reply, alone (3 runs) | 1,567–1,625 ms | 1,153–1,168 ms |

The server still lists the same 116 tools. To benefit, pin the version: `@playwright/mcp@latest` stays on npx.

```sh
node --test mods/mcp-direct/test.mjs
node bin/infiniteoc.mjs feature check mcp-direct
```

Rollback: `node bin/infiniteoc.mjs feature disable mcp-direct`, restart.
