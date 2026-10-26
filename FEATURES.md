# Adding features with AI

InfiniteOC can add **new features**, not just change existing source. It supports
typed local TUI slash commands through `api.tui.command`, source files/components
through `api.write`, unique-anchor changes through `api.patchExact`, arbitrary
source transformations through `api.patch`, and launch/exit hooks through `api.on`.
Mods are trusted code, not sandboxed. Source changes require build/restart; this
does **not** hot-patch an already running executable. `opendaemon` can reload
declared ctx-only TUI commands without restarting the UI/backend; see
[OPENDAEMON.md](OPENDAEMON.md) for supported live changes and limits.

Paths and commands are relative to the checkout root. After `npm link`,
`infiniteoc` can replace `node bin/infiniteoc.mjs`.

## Start with a working feature

```sh
node bin/infiniteoc.mjs feature new hello-ai
```

This creates `hello-ai/index.mjs`, `command.tsx`, and a README in your **personal mods
folder**, `~/.config/infiniteoc/mods/` (next to `settings.json`; `INFINITEOC_MODS_DIR`
overrides it). That folder is a local git repository with no remote and its own
`AGENTS.md`: commit your mod there if you like, but the InfiniteOC checkout itself stays
untouched, so updates keep working and nothing of yours is pushed anywhere. (Working on
InfiniteOC itself? `feature new ID --repo` puts it in this checkout's `mods/` instead.)
It does not enable the mod or replace existing files. Edit `command.tsx` instead of finding
and patching a command registry. The initial `/hello-ai` handler already shows a
toast with the open-tab count. A fuller example:

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
export async function run(ctx: FeatureContext) {
  const ok = await ctx.ui.confirm({ title: "Say hello", message: "Show a greeting?" })
  if (ok) ctx.toast.show({ variant: "info", message: "Hello!" })
}
```

Handlers support `async` and get a typed context:

| Capability | What it means |
| --- | --- |
| `ctx.tabs.tabs()`, `ctx.tabs.current()` | Open tabs in the configured global/cwd scope; the selected session ID |
| `await ctx.tabs.closeAll()` | Close all tabs in that scope, return the count, navigate home; no history deletion or task interruption |
| `await ctx.tabs.restoreAll(ids, active?)` | Undo `closeAll`: reopen those tabs at their old positions in one locked write, reselect `active`, return the count |
| `ctx.tabs.close(id?)`, `open(id)`, `select(id)`, `reopen(id?)` | Upstream single-tab behavior; `reopen` uses the in-memory recently-closed stack (at most 25) |
| `ctx.route` | Upstream typed home/session routing API |
| `await ctx.ui.alert/confirm/prompt/select({...})` | Promise dialogs that resolve with the answer, or `undefined` on Esc. `confirm`'s `label` is `{ confirm?, cancel? }`; `ctx.ui.set({ size: "large" })` widens the open dialog |
| `ctx.dialog` | Upstream dialog API; `replace(() => <YourComponent />)` adds Solid/OpenTUI UI (compiled mods only) |
| `ctx.toast` | `show({ variant, title?, message, duration?, action? })`; one toast at a time, replaced by the next unless hovered |
| `ctx.client` | The backend this UI is connected to; `ctx.client.api` is the typed SDK (`session.get/list/import/export`, models, ...). Use it to do the work in place instead of telling the user to run a command |

Toast actions are mouse-only and toasts render under an open dialog's backdrop, so
give every side-effecting choice a keyboard path (`ctx.ui`) and keep feedback for
an open dialog inside it. `/health` is the reference: a `ctx.ui.select` menu asks
before probing, and Esc sends nothing.

The generated `./api` type is available in the prepared runtime's
`packages/tui/src/infiniteoc-features/api.ts`. Handler modules compile in that
directory, so use `../ui/...` / `../context/...` when importing upstream components.
For multiple files, `api.write` can place supporting code under
`packages/tui/src/infiniteoc-features/`; use a unique mod-prefixed filename.
This declarative API is for **local UI commands**, not arbitrary server tools or
model-facing agent commands. Those still need source/config integration.

Command IDs become `infiniteoc.<mod>.<id>`, which is also their keybind name. Each
run first closes the open dialog (e.g. the command palette); a throw or rejection
shows an error toast titled `/<slash> failed`. Slash names and aliases may not
collide with any slash command declared in the TUI source (app, routes, plugins;
the full build also sees other mods' patches), the built-in `/live`, or another
feature: the build, `feature check` and `opendaemon reload` all fail closed.

## Check, enable, build, verify

```sh
node bin/infiniteoc.mjs feature check hello-ai
npm test
```

`feature check` validates declarations, slash collisions and pinned integration
anchors in a small disposable tree, without editing upstream/config/runtime. It
is **not** a compiler or runtime test and does not apply arbitrary source patches.
For mixed source mods, use
`skills/infiniteoc-mod-development/scripts/check-mod.mjs` for a full disposable
ordered application.

After inspecting the code, enable it:

```sh
node bin/infiniteoc.mjs feature enable hello-ai
```

`enable` runs the same check, then adds the mod to the personal folder's `mods.json`
(personal mods load after the bundled ones, in the order you enabled them). For a
`--repo` mod it appends `./mods/hello-ai/index.mjs` to `infiniteoc.json` instead, keeping
other mods/options and the previous file as `infiniteoc.json.bak`. `feature disable
hello-ai` removes it the same way. A
running opendaemon publishes a ctx-only command to open UIs right away; the next
launch rebuilds automatically (or run `node bin/infiniteoc.mjs rebuild`).

Restart InfiniteOC and execute `/hello-ai`. InfiniTUI, the default interface, lists it
too and runs it in a classic client of the same server, then comes back. Test actual
behavior; do not call a source-text assertion functional proof. Generated files are recorded in
`.runtime/opencode/infiniteoc-features.json`. The launcher fingerprints the
framework and mod files, so later launches rebuild changed code. A mod's own
`README.md` and `test.mjs` are left out: never read them while building. Never edit
`.runtime` or `.upstream` to implement persistent features.

## `/clearall`: closing is not deleting

The bundled `/clearall` is the reference feature. It closes tabs in the active
global/cwd scope, returns to the new-session screen, leaves stored conversations
unchanged, and does not interrupt running tasks. Its toast's **Undo** (mouse)
restores the tabs at their positions; from the keyboard, "Reopen closed tab"
(`ctrl+shift+t`) brings them back one at a time in their original order, and
`/sessions` reopens any conversation. Other cwd scopes are intentionally untouched.

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
4. Keep destructive operations out of close/hide actions and toast-only actions.
   Never expose API keys.
5. Cover behavior, races, duplicate registrations, and cached-launch registration.
6. Run tests, rebuild, then interact with the real feature before claiming success.
7. Rollback with `feature disable ID` (it removes only that entry), then restart;
   the next launch rebuilds.
