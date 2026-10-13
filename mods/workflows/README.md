# workflows

Workflows of subagents for the primary agent: it declares a small plan of steps with
dependencies (a DAG), the framework runs it **in the background** in child sessions,
independent steps in parallel and dependent ones in order, each step gets the results of
the steps it needs, the steps can **message each other** and the starting agent, and every
step gets a **model chosen for its kind of work** from the models the user has configured.
The classic `subagent` tool is unchanged and stays available.

**Off by default.** Turn it on in `/settings` → InfiniteOC Settings → Workflows, in
`/workflows` → Settings, or with `"workflows": {"enabled": true}` in the InfiniteOC settings
file. Why off: when on, every primary request carries the tool and its guidance (tokens),
the automatic *strong* tier may pick a pricier model than the one the user chose, and a
finished workflow wakes the agent for another turn, like a background subagent does. Those
are cost decisions the user (or the InfiniCode mod, see the contract below) should opt into.

## What the agent gets

| Tool | Who sees it | What it does |
| --- | --- | --- |
| `workflow` | Agents that may spawn subagents (permission action `subagent` not wholly denied), only while `workflows.enabled` is true | `start` a workflow (`name`, `steps`, optional `wait`); `status` one (`workflowID`; optional `wait` + `timeout`, see below) or all; `result` / `cancel` one (`workflowID`, optional `stepID`); `list` this session's workflows |
| `send_message` | Steps of a running workflow and the agent that started it (permission action `workflow_message`) | Message a step id, `"main"` (the starting agent) or `"all"` |
| `read_messages` | Same | Read unread messages; `wait` up to 120 s for one |

A step is `{ id, title?, agent?, prompt, needs?, kind?, model?, optional? }`. `agent`
defaults to `general`. `needs` lists step ids that must finish first; their results are
appended to the step's prompt, or placed where the prompt says `{{steps.<id>}}` (which must
be listed in `needs`). A failed step skips everything that requires it; a step marked
`optional` does not. Plans are validated before anything runs: unique ids, known
dependencies, no cycles, at most `maxSteps` steps.

```json
{"action":"start","name":"auth audit","steps":[
  {"id":"find","agent":"explore","prompt":"List every auth middleware with path:line…"},
  {"id":"spec","agent":"researcher","prompt":"Summarize the OAuth 2.1 changes relevant to…"},
  {"id":"review","agent":"reviewer","needs":["find","spec"],"prompt":"Review the middleware in {{steps.find}} against the spec…"}
]}
```

`start` returns at once with the step table (each step's model and tier) and the
`workflowID`; the agent keeps working. When the workflow ends, the starting session gets one
synthetic `<workflow …>` message with every step's result and its unread messages, which
wakes it exactly like a finished background subagent. A cancelled or interrupted workflow's
notice is delivered without waking the agent (whoever cancelled already knows). `wait: true`
blocks the tool call instead and, like a foreground subagent, interrupting that call (Esc)
cancels the workflow. With
`notify: "each"` a running starting agent also gets a short note per finished step.

### Waiting instead of polling

The guidance and the `start` output tell the agent to keep working or end its turn: the
completion notice wakes it. `status` is for when there is a reason to check (the user asks, a
long silence, one step's result is needed early), and polling is made pointless:

- `status` remembers the last answer per session and target (`start` counts as the first). A
  repeat that finds nothing changed (same workflow and step statuses, no new message; running
  times do not count) gets a short `No change since your last check Ns ago; still running: …
  do not poll` instead of the full table. A back-to-back repeat first waits out the rest of a
  10 s cooldown for a change, so a polling loop slows down instead of spinning. A finished
  workflow always gets the full view at once.
- `status` with `wait: true` is one blocking check: it returns the full view as soon as
  something changes (a step finishes, a message arrives, the workflow ends), or the short
  answer after `timeout` seconds (default 120, 1 to 300). Esc interrupts it like any tool call.
- Under `/goal`, a turn that ends while a background workflow runs is not re-prompted (see
  [mods/infiniteoc](../infiniteoc/README.md)). The plugin reports its running, non-waiting
  workflows to mods/infiniteoc's background registry (`core/src/infiniteoc/background.ts`)
  and signals it: a message for an idle starting agent wakes the held goal (the message
  itself stays unread for `read_messages`), a finished step counts as progress (a wake with
  `notify: "each"`). The completion notice wakes the session as before. Outside `/goal` those
  signals have no effect.

Guidance (the `[Workflows]` block) is added to agent-loop requests only while the `workflow`
tool is offered, so turning the flag off removes both.

## Automatic model choice

Each step resolves to a model when the workflow starts, shown in the tool output, the TUI,
the child session's title, and `status`:

1. An explicit `model` on the step: a `provider/model[#variant]` that must be available, or a
   tier word (`fast`, `strong`, `default`).
2. A model set in the step agent's own configuration.
3. The tier of the step: its `kind` (`search`, `summarize` → fast; `plan`, `review`, `reason`
   → strong; `implement`, `test`, `other` → default), else the agent's tier (`explore`,
   `researcher` → fast; `reviewer` → strong), else keywords in the title and prompt.

Tiers resolve with the settings below, using only `Model.available()` (enabled models of the
providers the user configured):

| Tier | `auto` | Notes |
| --- | --- | --- |
| fast | the caller's provider's small model (upstream `Model.small`: Luna, Flash Lite, Flash, Haiku) at its lowest reasoning variant | falls back to the caller's model |
| strong | the newest model of each family of the caller's provider, highest output price first, never above `strongMaxCostRatio` × the caller's price | the caller's model when it is already the strongest or prices are unknown |
| default | — (`inherit`: the caller's model) | |

"The caller's model" is the starting session's model, or the configured default model.
A configured model that is no longer available falls back to the automatic choice.

## Settings

The `workflows` key of the InfiniteOC settings file (`$INFINITEOC_SETTINGS_FILE`, else
`~/.config/infiniteoc/settings.json`). The server reads it on every request; no restart.
Invalid values fall back field by field.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | The contract flag below |
| `maxParallel` | `3` | Steps of one workflow running at once (1–8) |
| `maxSteps` | `12` | Steps per workflow (1–32) |
| `maxOutputChars` | `12000` | Result characters passed to dependents and notifications |
| `notify` | `"end"` | `"each"` also notes every finished step to a running starter |
| `models.fast` / `models.strong` | `"auto"` | `auto`, `inherit` or `provider/model[#variant]` |
| `models.default` | `"inherit"` | `inherit` or a model |
| `models.strongMaxCostRatio` | `4` | Price ceiling for `strong: auto` relative to the caller |
| `agents` | `{explore: fast, researcher: fast, reviewer: strong}` | Tier per agent id |
| `kinds` | see above | Tier per step kind |

## The `workflows.enabled` contract

For other mods (the InfiniCode effort) that turn workflows on:

- **Where**: `workflows.enabled` (boolean) in the InfiniteOC settings file above. Strict JSON;
  every other key is preserved by all writers here.
- **Precedence**: an explicit boolean in the settings file, else the build default
  `options.workflows.enabled` in `infiniteoc.json` (only `true` counts; baked in at build),
  else `false`. Non-boolean values count as unset.
- **When it is read**: on every model request (tool list and guidance) and on every
  `workflow start`, by the server; on every `/workflows` and settings view, by the TUI. A
  change applies to the next request without rebuild or restart.
- **true**: the `workflow` tool and `[Workflows]` guidance are offered to agents allowed to
  spawn subagents; `send_message` / `read_messages` to them and to workflow steps.
- **false**: the tool and guidance are not offered and `start` is refused. Workflows already
  running continue until they finish or are cancelled, their members keep messaging, and
  `/workflows` still lists and cancels them.
- **Never affected**: the `subagent` tool, permission rules and approvals, other settings.
- **How to flip it from code**: `import { setWorkflowsEnabled, readWorkflowsEnabled } from
  "<checkout>/mods/workflows/flag.mjs"` (plain Node: atomic write, mode 0600, refuses to
  rewrite a file that is not strict JSON; `readWorkflowsEnabled()` returns `true`, `false`
  or `undefined` when unset). From the UI: `/settings` → InfiniteOC Settings → Workflows.

## Permissions and safety

- Each distinct step agent passes the same `subagent` permission check (`ask` prompts the
  user once per agent) and the same agent checks (exists, not a primary agent) and depth
  limit (`experimental.subagent_depth`) as the `subagent` tool, before any step starts.
- A step's child session runs as its agent with that agent's rules only; no session
  permission rules are added. Steps that need approval ask like any subagent.
- With safe-guard enabled, `/readonly` refuses a workflow that contains an editing step
  (any agent other than explore, reviewer, researcher), like it refuses such a subagent.
- Messages are scoped to one workflow: members are `main` and its step ids; nobody else can
  be addressed and the tools refuse callers outside a running workflow. At most 200 messages
  of 4000 characters per workflow.
- Agents whose rules deny everything by default (`explore`, `researcher`) do not get
  `send_message` / `read_messages`, and their step prompt does not mention them: messages to
  them still arrive in their session, and their result reaches their dependents. Allow `workflow_message` for such an agent to let it
  send.
- Cancelling interrupts only that workflow's running steps; sessions, results and history
  stay. Closing tabs never cancels anything.

## TUI

- **Sidebar**: the open session's workflows (running, or ended in the last 15 minutes): each
  step with its status and model.
- **Prompt footer** while one runs: `wf <name> 2/5 · review claude-opus-4-5`.
- **`/workflows`** (alias `/wf`): workflows of this session (or recent ones), each step's
  status, agent, model, tier and why that model; the step's result; messages; **Cancel
  workflow** (confirmed; the server stops it within about a second); Settings.
- **`/settings` → InfiniteOC Settings → Workflows**: on/off, tier models, parallel steps, notify.

## How it hooks into upstream (v2.0.21)

| File | Change |
| --- | --- |
| `packages/core/src/plugin/infiniteoc-workflows.ts` | The plugin (from `plugin.ts`): tools, runner, context hook |
| `packages/core/src/plugin/infiniteoc-wf-{dag,mailbox,models,settings,store}.ts` | Pure modules, unit-tested here |
| `packages/core/src/plugin/internal.ts` | Import after `import { SubagentTool } …`; plugin listed after `SubagentTool.Plugin,` |
| `packages/core/src/plugin/infiniteoc-safety.ts` | Only when safe-guard is enabled first: readonly rule after its `subagent` rule |
| `packages/tui/src/feature-plugins/system/infiniteoc-workflows.tsx` | Sidebar and footer plugin, listed after `Notifications,` in `plugin/builtins.ts` |
| `packages/tui/src/infiniteoc-features/workflows-{dag,settings,store}.ts` | Shared with `/workflows` |
| `packages/tui/src/component/dialog-infiniteoc.tsx` (+ `workflows-settings.ts`) | The Workflows row; needs mods/infiniteoc first |
| `packages/core/src/infiniteoc/background.ts` (imported, not written) | mods/infiniteoc's background registry for `/goal`; another reason this mod needs mods/infiniteoc first |

Runtime primitives are upstream's, the same the `subagent` tool uses: a step is
`Session.create({parentID, agent, model})`, `Session.prompt({resume: false})` and a
`Job.start` whose run is `Session.resume` (so `Job.cancel` + `Session.interrupt` stop it);
completion is `Session.synthetic` into the starting session; messages to a running session
are synthetic steers with `resume: false`, seen at its next step boundary.

State: `$XDG_DATA_HOME/infiniteoc/workflows/<sessionID>/<workflowID>.json` (mode 0600) holds
the plan, step states, models, results (up to 100,000 characters each) and messages; the
TUI's cancel request is a `.cancel` marker next to it. Finished workflow files are removed
after 7 days. Session history is never touched.

## Limits

- **No restart recovery.** Workflows run in the server process. When the location that runs
  one is reloaded, its running steps are stopped and it ends `interrupted` (the starter gets a
  non-waking notice). If the process stops, running workflows are marked `interrupted` at the
  next start and the starter is not notified; their child sessions stay in history
  and can be continued with the `subagent` tool's `sessionID`. (Upstream recovers plain
  background subagents; it has no recovery hook for a multi-step plan.)
- **Messages arrive at step boundaries.** A running recipient sees a message at its next model
  step, not mid-generation. A message to the starting agent while it is idle does not wake it;
  it arrives with the final notification or through `read_messages`. A message that reaches a
  step after it finished is not delivered.
- **No file locking.** Parallel editing steps must own disjoint files, as the guidance says.
- `wait: true` blocks only that tool call; everything else stays concurrent.
- The model choice is a heuristic within one provider (price as a capability proxy). Pin
  `models.strong` / `models.fast` when it guesses wrong.

## Verification

`node --test mods/workflows/test.mjs`: plan validation, scheduling (parallelism limit,
ordering, failure propagation, optional steps, cancel), step prompts and summaries, the
mailbox, model choice, settings, the store and startup sweep, the flag helper, the
polling-aware `status` (short no-change answer, cooldown, `wait` on change and timeout, driven
the way the plugin drives it on a fake clock), the `/goal` signals, and the mod
applied after every enabled mod onto pristine upstream (read from the pinned tag's git
objects). The Effect plugin and TUI code are syntax-checked but not compiled or run here:
rebuild and try a workflow before relying on it; the checklist is in the root VERIFICATION.md.
