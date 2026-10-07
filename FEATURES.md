# Adding features with AI

InfiniteOC can add **new features**, not just change existing source. It supports
typed local TUI slash commands through `api.tui.command`, source files/components
through `api.write`, unique-anchor changes through `api.patchExact`, arbitrary
source transformations through `api.patch`, and launch/exit hooks through `api.on`.
Mods are trusted code, not sandboxed. Source changes require build/restart; this
does **not** hot-patch an already running executable. The new `opendaemon` path
can reload declared ctx-only TUI commands without restarting the UI/backend;
see `/home/rize/InfiniteOC/OPENDAEMON.md` for supported live changes and limits.

## Start with a working feature

```sh
node /home/rize/InfiniteOC/bin/infiniteoc.mjs feature new hello-ai
```

This creates `/home/rize/InfiniteOC/mods/hello-ai/index.mjs`, `command.tsx`, and a
README. It does not enable the mod or replace existing files. Edit `command.tsx`
instead of finding and patching a command registry. The initial `/hello-ai` handler
already shows a toast with the open-tab count.

```js
import { readFile } from "node:fs/promises"
export default {
  id: "hello-ai",
  version: "1.0.0",
  async setup(api) {
    api.tui.command({
      id: "main",
      title: "Say hello",
      slash: "hello-ai", // no leading slash
      aliases: ["greet"], // optional
      category: "Mods", // optional
      source: await readFile(new URL("./command.tsx", import.meta.url), "utf8"),
    })
  },
}
```

```tsx
import type { FeatureContext } from "./api"
export function run(ctx: FeatureContext) {
  ctx.toast.show({ variant: "info", message: "Hello!" })
}
```

Handlers support `async` and get a typed context:

| Capability | What it means |
| --- | --- |
| `ctx.tabs.tabs()` | Open tabs in the current configured global/cwd scope |
| `await ctx.tabs.closeAll()` | Close all tabs in that scope, return count, navigate home; no history deletion or task interruption |
| `ctx.tabs.close(id?)` | Existing upstream single-tab close behavior |
| `ctx.tabs.open(id)`, `ctx.tabs.select(id)` | Open/select an existing session tab |
| `ctx.tabs.reopen(id?)` | Existing in-memory recently closed tabs (upstream retains at most 25) |
| `ctx.route` | Existing typed home/session routing API |
| `ctx.dialog` | Existing dialog API; `replace(() => <YourComponent />)` can add new Solid/OpenTUI UI |
| `ctx.toast` | Existing notification API |

The generated `./api` type is available in the prepared runtime's
`packages/tui/src/infiniteoc-features/api.ts`. Handler modules compile in that
directory, so use `../ui/...` / `../context/...` when importing upstream components.
For multiple files, `api.write` can place supporting code under
`packages/tui/src/infiniteoc-features/`; use a unique mod-prefixed filename.
This first declarative API is for **local UI commands**, not arbitrary server
tools or model-facing agent commands. Those still need source/config integration.
Aliases and slash names are checked for collisions with app-level built-ins and
other declared features. Route-specific/upstream plugin commands must also be
checked manually. Handler errors go to the normal toast error path.

## Check, enable, build, verify

```sh
node /home/rize/InfiniteOC/bin/infiniteoc.mjs feature check hello-ai
node --test /home/rize/InfiniteOC/test/tui-features.test.mjs
```

`feature check` validates declarations and pinned integration anchors in a small
disposable tree, without editing upstream/config/runtime. It is **not** a compiler
or runtime test and does not apply arbitrary source patches. For mixed source mods,
use `/home/rize/InfiniteOC/skills/infiniteoc-mod-development/scripts/check-mod.mjs`
for a full disposable ordered application.

After inspecting the code, back up `/home/rize/InfiniteOC/infiniteoc.json` and
append `./mods/hello-ai/index.mjs` to its `mods` array. Preserve other mods/options.
Then run:

```sh
node /home/rize/InfiniteOC/bin/infiniteoc.mjs rebuild
```

Restart InfiniteOC and execute `/hello-ai`. Test actual behavior; do not call a
source-text assertion functional proof. Generated files are recorded in
`/home/rize/InfiniteOC/.runtime/opencode/infiniteoc-features.json`. The launcher
fingerprints the framework and mod files, so later launches rebuild changed code.
Never edit `.runtime` or `.upstream` to implement persistent features.

## `/clearall`: closing is not deleting

The bundled `/clearall` is the reference feature. It closes tabs in the active
global/cwd scope, returns to the new-session screen, leaves stored conversations
unchanged, and does not interrupt running tasks. Reopen conversations with
`/sessions`; recently closed-tab restoration remains available too. Other cwd
scopes are intentionally untouched.

The old mod registered a server-side command, interrupted sessions, and submitted
another prompt. That cannot close a client's UI tabs. The replacement executes
in the TUI and mutates only its persisted tab layout under the existing storage
lock. Cancellation marks prevent queued tab-registration writes from reopening
the tabs. Persistence failures are reported rather than falsely claiming success.

## Agent checklist

1. Identify ownership: TUI tabs/layout, stored sessions, server tools or launcher?
2. Prefer the declarative TUI API for slash commands; don't synthesize an agent
   prompt for a local UI action.
3. Inspect types in the pinned source; use Solid/OpenTUI, not DOM/React assumptions.
4. Keep destructive operations out of close/hide actions. Never expose API keys.
5. Cover behavior, races, duplicate registrations, and cached-launch registration.
6. Run tests, rebuild, then interact with the real feature before claiming success.
7. Rollback by removing only your mod's entry and rebuilding/restarting.