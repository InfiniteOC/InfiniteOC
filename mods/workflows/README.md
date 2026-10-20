# workflows

Workflows of subagents for the primary agent: it declares a small plan of steps with
dependencies (a DAG), the framework runs it **in the background** in child sessions,
independent steps in parallel and dependent ones in order, each step gets the results of
the steps it needs, the steps can **message each other** and the starting agent, and every
step gets a **model chosen for its kind of work** from the models the user has configured.
The classic `subagent` tool is unchanged and stays available.

**Off by default.** Turn it on in `/settings` → InfiniteOC Settings → Workflows, in
`/workflows` → Settings, or with `"workflows": {"enabled": true}` in the InfiniteOC settings
file. Why off: when on, every request carries the tool and its guidance (tokens; compaction gets them too, so it reuses the session's prompt cache),
the automatic *strong* tier may pick a pricier model than the one the user chose, and a
finished workflow wakes the agent for another turn, like a background subagent does. Those
are cost decisions the user (or the InfiniCode mod, see the contract below) should opt into.

## What the agent gets

| Tool | Who sees it | What it does |
| --- | --- | --- |
| `workflow` | Agents that may spawn subagents (permission action `subagent` not wholly denied), only while `workflows.enabled` is true | `start` a workflow (`name`, `steps`, optional `wait`); `status` one (`workflowID`; optional `wait` + `timeout`, see below) or all; `result` / `cancel` one (`workflowID`, optional `stepID`); `list` this session's workflows |
| `send_message` | Steps of a running workflow and the agent that started it (permission action `workflow_message`) | Message a step id, `"main"` (the starting agent) or `"all"` |
| `read_messages` | Same | Read unread messages; `wait` up to 120 s for one |

A step is `{ id, title?, agent?, prompt, needs?, kind?, model?, optional?, each? }`. `agent`
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

### Fan-out: hundreds of steps from one template

`each: [...]` turns one step into one step per item: the prompt is a template with `{{item}}`, the ids become
`<id>-1`, `<id>-2`, … and `needs: ["<id>"]` (or `{{steps.<id>}}`) waits for all of them. The agent writes the
prompt once and a list of short items, not hundreds of prompts. `glob: "src/**/*.ts"` is the same over the
project files it matches (`git ls-files`, so ignored files are skipped), without the agent listing them, and
`{{file}}` in the prompt inlines each item's file (project files only, never `.env`, up to 100k characters), so
a step answers in one model call instead of reading the file first. `maxSteps` (default 500) counts the
expanded steps. What keeps a big fan-out cheap:

- Each item's prompt names its group as one teammate entry, not every other step (500 items used to mean ~5k
  tokens of team list in every one of 500 prompts).
- A step after a group gets a digest: all dependency results share 4 × `maxOutputChars`, at least 100 characters
  per item, cut off with a pointer to `result` when the budget runs out. It is told to work from the results and
  open files only to check a doubt.
- The completion notice gives each group one budget slice, and `status` shows a group as one line with counts.
- State is saved at most once a second (it was rewritten on every step change), and an item keeps at most 20k
  characters of output.
- Claude Code workers are separate ~300 MB processes, so they get their own cap, `claudeParallel` (default 4),
  counted across every workflow; OpenCode steps run inside the server and only share `maxParallel`.

## Speed

Measured on this repository: one step per `mods/*/index.mjs` (34 files), each summarizing its file. The
first version took 45 s. Where the time went, and what changed:

| Cost | Measured | Change |
| --- | --- | --- |
| Git snapshots | each model step captured the work tree twice (8 git processes; `ls-files --others` walks it all): ~80% of the server's time per step, 758 ms per tool round trip at 16 parallel | read-only steps (agents that cannot edit: explore, researcher, reviewer) skip them; `session/runner/step.ts` patch. 200 instant steps: 16.5 s → 3.7 s |
| Provider throttling | the free DeepSeek endpoint answered 12 of 16 parallel requests with 503; the retry backoff turned 3 s into 17-40 s | per-model limits learned from 429/5xx/overload (`pool.ts`): halved once per burst, +1 per `cap` successes; a 5-minute pause for an exhausted quota; a rate limit (429, "rate limit exceeded") also pauses the provider's other pool members, since the free OpenCode models share one |
| Failed items | a rate limit sent as an error is final: the item failed, and with it everything after the group | a pooled fan-out item that fails is queued again (twice at most) and placed with what was learned (in a measured run 5 of 34 moved to Claude Code); fan-out items are best effort (`optional` unless `optional: false`) |
| Slow or failing models | 9 models at 16 parallel: 2.8 s to 100 s, changing within the hour | a tier can be a pool (`"a/x, b/y"`): each step goes to the member expected to finish it first, from learned step times (kept for a day in `model-speeds.json`), queue-aware so a full fast member beats an idle slow one; a throttled step moves to another member at once |
| Stragglers | median step 2.5 s, slowest 16.8 s | a read-only fan-out item running 2.5 × its siblings' median (at least 4 s) gets a backup run on another member; the first to finish wins. A 30 s straggler: 30 s → 4.1 s |
| Reading files | 2+ model calls per item (read, then answer) | `glob` + `{{file}}`: 1.1-1.3 calls per item |
| Polling | waiting agents checked every second | `read_messages` and `status` wait on a bell rung by every message and step change |
| Orchestrator | re-read files to verify, fetched results the digest cut off | the notice says to answer from the reports; a fan-out's notice grows with it (700 characters a step, up to 80k) |

Result, same 34 files: free pool 23 s (load-dependent), Claude Code haiku with 8 workers 15.9 s, the `turbo`
pool (haiku plus the free models) 11.3 s once speeds are learned, against 45 s before. Server overhead per
step is ~10 ms (an instant fake model: 200 steps in 2.1 s).

`start` returns at once with the step table (each step's model and tier) and the
`workflowID`; the agent keeps working. When the workflow ends, the starting session gets one
synthetic `<workflow …>` message with every step's result and its unread messages, which
wakes it exactly like a finished background subagent. A cancelled or interrupted workflow's
notice is delivered without waking the agent (whoever cancelled already knows). `wait: true`
blocks the tool call instead and, like a foreground subagent, interrupting that call (Esc)
cancels the workflow. With
`notify: "each"` a running starting agent also gets a short note per finished step.

### Getting the agent to use it

Delegation goes through workflows by default rather than by exception:

- The build agent's own guidance (`mods/infiniteoc/workflow.mjs`, `[Subagents]`) routes "two or more tasks, or a task
  plus its review" to one workflow call and names the shapes that pay off (parallel explore/researcher steps; general
  steps on disjoint files followed by a reviewer; explore → general → reviewer).
- The tool description opens with "The preferred way to delegate two or more tasks".
- When one assistant message still starts a second plain `subagent` call, that call's result gets a one-paragraph
  note pointing at the workflow tool (`D.subagentNudge`, at most twice per session, only while workflows are on).
- `infiniteoc.json` turns workflows on for the build (`options.workflows.enabled`); `settings.json` still wins.
- **Fleet mode** (`fleet: true`; `/fleet on|off` in InfiniTUI, or `/workflows` → Settings) makes delegation the rule
  instead of the preference. Primary agents get a `[Fleet mode]` system part (`FLEET_GUIDANCE`): they are the
  orchestrator, even one task goes to a one-step workflow, and they do not read, grep, edit or run commands themselves
  beyond a look-up or two to plan. Their own direct work calls (`read grep glob edit write patch shell`) are counted
  since their last `workflow` or `subagent` call; the third and every fourth after it get a `[Fleet]` note in the
  result telling them to hand the rest to a workflow (`D.fleetNudge`). Workflow steps and subagents never see either.
  The guidance asks for many narrow steps at once (10 to 50), the fast tier on every read-only step and a shallow
  dependency chain, and every step's prompt gets `D.FAST_WORKER`: fewest tool calls, batched, stop at the answer,
  reply in a few lines. Claude Code is never used: `claude-code/*` drops out of every tier and pool (a configured
  `claude-code/opus` strong tier falls back to `auto`) and a step that names one is refused, so the user's Claude
  limits stay untouched. Turning it on also sets `enabled` and `maxParallel: 64`.
- **Rate limits wait instead of failing.** Upstream retries a request 10 times 2-10 s apart (about 84 s), less than
  a free provider's rate limit lasts. On a 429 a workflow step first moves to a pool member on another provider;
  with nowhere to go (and for a fleet orchestrator) the retry waits `Pool.rateLimitDelay`: 5 s doubling to 60 s,
  ±20%, never under the provider's retry-after, about 7 minutes over the 10 retries. The model and its same-provider
  pool members pause that long, so new steps do not start into the limit.

For speed: up to 8 steps run at once by default (`maxParallel`, up to 64), search/summarize steps run on the fast model, and the
guidance tells the agent to start with `wait: true` when the result is the only thing it needs next, which returns
the results in that call and saves the extra wake-up turn a background run costs.

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

## Claude Code workers

A step whose model is `claude-code/haiku`, `claude-code/sonnet` or `claude-code/opus` runs on the user's own
logged-in Claude Code CLI instead of an OpenCode child session (`claude.ts`): `claude -p --output-format
stream-json` in the project directory, with the step prompt on stdin. Available when `claude` is on PATH.

- **Permissions** (`claudeMode`, `/fleet claude readonly|auto|bypass`). Nothing ever prompts: workers are headless.
  - `readonly` (default): `Read Grep Glob WebSearch WebFetch` only (`--tools`). A step that edits (agent other
    than explore/researcher/reviewer and kind implement/test/other) cannot use it: an explicit request is refused
    with the reason, a tier set to a `claude-code/*` model falls back (default tier: the caller's model;
    fast/strong: the automatic choice).
  - `auto`: every tool, `--permission-mode auto`: Claude Code's classifier allows routine actions and blocks
    risky ones.
  - `bypass`: every tool, `--permission-mode bypassPermissions`: no checks at all.
  - Both editing modes disallow Claude Code's own `Task`/`Agent` subagents (the workflow is the parallelism) and
    tell the worker to change only the files its task owns.
- **Lean**: `--strict-mcp-config` and `--setting-sources project,local` skip the user's MCP servers, hooks and
  plugins, and `--no-session-persistence` keeps workers out of Claude Code's history. Measured on a one-line task:
  ~16k cache tokens and 3.7 s instead of ~465k with everything loaded.
- **Own login**: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are removed from its
  environment, so it uses the subscription the CLI is logged in with.
- Its tool calls feed `state.activity` (latest tool, tool count, last text) for the fleet view; its final
  `result` event is the step result; cancelling a step or workflow kills the process. Workers do not get
  `send_message`/`read_messages`; messages sent before they start are in their prompt.

## Presets

`/fleet preset <name>` in InfiniTUI (or `applyChange("preset", name)`) writes the three tier models at once:

| Preset | fast | strong | default |
| --- | --- | --- | --- |
| `turbo` | `claude-code/haiku` + the free pool | `claude-code/opus` | `inherit` |
| `free-cc` | the free pool | `claude-code/opus` | `claude-code/sonnet` (with `claudeMode` readonly, editing steps use the caller's model) |
| `free` | the free pool | `auto` | `inherit` |
| `cc` | `claude-code/haiku` | `claude-code/opus` | `claude-code/sonnet` |
| `auto` | `auto` | `auto` | `inherit` (the defaults) |

The free pool is `opencode/glm-5.3-flash-free, opencode/deepseek-v4.1-flash-free, opencode/mimo-v2.6-flash-free`
(`nemotron-3.5-lightning-free` is fast on tiny prompts but slow and failing on real ones). A pool member that is
not available (no `claude` CLI, provider not configured) is left out; a tier with none falls back to the
automatic choice.

## Settings

The `workflows` key of the InfiniteOC settings file (`$INFINITEOC_SETTINGS_FILE`, else
`~/.config/infiniteoc/settings.json`). The server reads it on every request; no restart.
Invalid values fall back field by field.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | The contract flag below |
| `fleet` | `false` | Fleet mode: the primary agent delegates nearly all its work through workflows, never on Claude Code (see above); on also sets `enabled` and `maxParallel: 64` |
| `maxParallel` | `16` | Steps of one workflow running at once (1–64); learned per-model limits keep throttled providers lower |
| `claudeParallel` | `4` | Claude Code worker processes at once, across all workflows (1–16) |
| `claudeMode` | `"readonly"` | What Claude Code workers may do: `readonly`, `auto` or `bypass` (see above) |
| `maxSteps` | `500` | Steps per workflow after expanding `each` (1–1000) |
| `maxOutputChars` | `12000` | Result characters passed to dependents and notifications |
| `notify` | `"end"` | `"each"` also notes every finished step to a running starter |
| `models.fast` / `models.strong` | `"auto"` | `auto`, `inherit`, `provider/model[#variant]`, `claude-code/haiku|sonnet|opus`, or a pool: several models separated by commas |
| `models.default` | `"inherit"` | `inherit`, a model or a pool |
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
| `packages/core/src/plugin/infiniteoc-wf-{claude,dag,mailbox,models,pool,settings,store}.ts` | Pure modules, unit-tested here |
| `packages/core/src/infiniteoc/no-snapshot.ts` + `packages/core/src/session/runner/step.ts` | Sessions in the set skip the start and end git snapshot of each model step (read-only workflow steps) |
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

A read-only step's backup run is a second child session of the same step (both in `/workflows`' history);
the loser is interrupted. Learned model speeds: `$XDG_DATA_HOME/infiniteoc/model-speeds.json`.

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
- **Backups and speed learning are heuristics.** Only read-only fan-out items get a backup (a second run
  costs tokens; an editing step must never run twice). Speeds are a moving average of whole step times, so a
  model that served short steps looks faster than one that served long ones until both have done similar work.
- **Claude Code workers start cold** (~0.6 s of a short step) and do not take part in messaging.
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
