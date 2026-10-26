// InfiniteOC workflows: DAG workflows of subagents that run in the background, talk to each other
// and get a model chosen per step. Written to packages/core/src/plugin/infiniteoc-workflows.ts by
// mods/workflows and registered next to upstream's subagent tool.
//
// Built on upstream v2.0.21 primitives, the same ones the subagent tool uses:
//   each step is a child session (Session.create with parentID, the step's agent and model),
//   admitted with Session.prompt and run as a Job (Session.resume), so Job.cancel and
//   Session.interrupt stop it; the starting session is told about the end with Session.synthetic,
//   like a background subagent completion. Messages to a running step are steered into its
//   session the same way.
// Pure logic (plan validation, scheduling, mailbox, model choice, settings) lives in the
// infiniteoc-wf-*.ts modules and is unit-tested in mods/workflows/test.mjs.
import { spawn, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { SystemPart, ToolFailure } from "@opencode/ai"
import { Tool } from "@opencode/schema/tool"
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { TuiEvent } from "@opencode/schema/tui-event"
import { Cause, Deferred, Effect, Exit, Schema, Scope } from "effect"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Job } from "../job.js"
import { Location } from "../location.js"
import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { Session } from "../session.js"
import { SessionSchema } from "../session/schema.js"
import { SubagentCompletion } from "../session/subagent-completion.js"
import * as Background from "../infiniteoc/background.js"
import * as NoSnapshot from "../infiniteoc/no-snapshot.js"
import * as C from "./claude.ts"
import * as D from "./dag.ts"
import * as M from "./mailbox.ts"
import * as Models from "./models.ts"
import * as Pool from "./pool.ts"
import { FREE_POOL, KINDS, type Settings } from "./settings.ts"
import * as Store from "./store.ts"

export const TOOL = "workflow"
export const SEND = "send_message"
export const READ = "read_messages"
export const SWARM_ADD = "swarm_add"
const MAX_STORED_OUTPUT = 100_000
// A fan-out item keeps less: 500 of them at the full size would make a 50 MB state file.
const MAX_ITEM_OUTPUT = 20_000
const MAX_WAIT_SECONDS = 120

export const GUIDANCE = `[Workflows]
Use the workflow tool whenever you would otherwise make two or more subagent calls, or one subagent call followed by a review; one quick task: the plain subagent tool. Its description covers steps, glob/each fan-out and swarm.
- Keep steps narrow with self-contained prompts, never two steps editing the same files; set kind and leave model unset unless the user asks for one.
- When its result is the only thing you need next, start it with wait: true: the results come back in that call. Otherwise keep working on non-overlapping tasks, or tell the user what you launched and end your turn; that notification wakes you, also under /goal. Do not poll.
- Check status only for a reason: the user asks, it has been silent far longer than its steps should take, or you need one step's result early (then status with wait: true blocks once until something changes).
- Answer from the steps' reports and never redo a step's work; for steps that changed files, verify as for any change: read the diff and run the checks.`

/** Added for primary agents while fleet mode is on; it overrides the "one quick task: subagent" rule above. */
export const FLEET_GUIDANCE = `[Fleet mode]
The user turned on fleet mode: you are the orchestrator of a swarm, not the worker. Hand the work to many agents at once.
- Default for every task that needs tools: workflow action "swarm" with goal (the task with everything the user said: paths, constraints, what done looks like) and edits: true when files must change, from a one-file fix to a whole new project. The planner splits it across many agents with a shared contract; they run at once, message each other, add tasks they discover, and an edit swarm ends with a reviewer. Start it with wait: true when you need the results next.
- Hand-written steps (action start) only when you already know the exact split; a one-step workflow is refused.
- Do not read, grep, edit, write or run shell commands yourself; a look-up or two to write a good goal is the most you do directly.
- Your own turns are for planning, talking to the user and answering from the results. When a result shows more work (a reviewer's finding, a failed task), start the next swarm for exactly that; never finish or redo the work by hand.
- Work yourself only for a pure chat answer that needs no tools, or when the user explicitly asks you to.`

const Step = Schema.Struct({
  id: Schema.String.annotate({ description: 'Short unique id (letters, digits, "-", "_"); used in needs, {{steps.<id>}} and messages.' }),
  title: Schema.optionalKey(Schema.String).annotate({ description: "A 3-6 word label shown to the user." }),
  agent: Schema.optionalKey(Schema.String).annotate({ description: 'The subagent that runs the step (see the list below). Defaults to "general".' }),
  prompt: Schema.String.annotate({
    description:
      "The full task. The subagent starts with no context: include goals, paths, owned files, constraints, checks and the return format. {{steps.<id>}} inserts the result of a step listed in needs.",
  }),
  needs: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Ids of steps that must finish first; their results are passed in." }),
  kind: Schema.optionalKey(Schema.Literals(KINDS)).annotate({
    description: "What the step does; picks the model tier (search/summarize: fast; plan/review/reason: strong; implement/test/other: default).",
  }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'NEVER set this unless the user asks for a model. "providerID/modelID[#variant]" (look it up with the models tool) or a tier: fast, strong, default.',
  }),
  optional: Schema.optionalKey(Schema.Boolean).annotate({ description: "If true, a failure does not fail the workflow or block dependents." }),
  glob: Schema.optionalKey(Schema.String).annotate({
    description:
      'Fan-out over the project files matching this glob (e.g. "src/**/*.ts"; git-ignored files skipped): like each with their paths, without listing them. Put {{file}} in the prompt to inline each file, so a step answers without reading it.',
  }),
  each: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      'Fan-out: one step per item, the prompt is a template with {{item}}. Ids become "<id>-1", "<id>-2"…; needs: ["<id>"] waits for all of them and gets a digest of their results.',
  }),
})

export const Input = Schema.Struct({
  action: Schema.Literals(["start", "swarm", "status", "result", "cancel", "list"]).annotate({
    description: "start a workflow from your steps; swarm: many agents on one goal (goal, edits, size); status / result / cancel one (workflowID); list this session's workflows.",
  }),
  goal: Schema.optionalKey(Schema.String).annotate({
    description: "swarm: the whole task, self-contained (the planner starts with no context): what to build or find, paths, constraints, what done looks like.",
  }),
  edits: Schema.optionalKey(Schema.Boolean).annotate({ description: "swarm: true when the agents must change files (build, fix, refactor); default false (search and report)." }),
  size: Schema.optionalKey(Schema.Number).annotate({ description: "swarm: the most agents the planner splits the goal into (2-64). Leave unset for the configured size." }),
  name: Schema.optionalKey(Schema.String).annotate({ description: "start: a short name for the workflow." }),
  steps: Schema.optionalKey(Schema.Array(Step)).annotate({ description: "start: the steps." }),
  wait: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "start: block until it finishes and return the results. status: block until something changes (a step finishes, a message for you, the end) or timeout passes. Default false; you are notified when it finishes anyway.",
  }),
  timeout: Schema.optionalKey(Schema.Number).annotate({
    description: `status with wait: most seconds to wait (default ${D.DEFAULT_STATUS_WAIT_SECONDS}, at most ${D.MAX_STATUS_WAIT_SECONDS}).`,
  }),
  workflowID: Schema.optionalKey(Schema.String).annotate({ description: "status, result, cancel: the workflow. status without it lists them." }),
  stepID: Schema.optionalKey(Schema.String).annotate({ description: "result: one step's full output. cancel: stop only this step (its dependents are skipped)." }),
})

const SendInput = Schema.Struct({
  to: Schema.String.annotate({ description: 'A step id of your workflow, "main" (the agent that started it) or "all".' }),
  text: Schema.String.annotate({ description: "The message. Short and specific: what changed, what you need, or a decision." }),
  workflowID: Schema.optionalKey(Schema.String).annotate({ description: "Only needed by the starting agent when several of its workflows run." }),
})
const SwarmAddInput = Schema.Struct({
  title: Schema.String.annotate({ description: "A 3-6 word label." }),
  prompt: Schema.String.annotate({ description: "The full task, self-contained: the new agent starts with no context beyond the goal and the contract." }),
  files: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Files it owns (edit swarms) or where to look; none owned by another agent." }),
})
const ReadInput = Schema.Struct({
  workflowID: Schema.optionalKey(Schema.String).annotate({ description: "Limit to one workflow (starting agent only)." }),
  wait: Schema.optionalKey(Schema.Number).annotate({
    description: `Seconds to wait for a message when none is unread (0-${MAX_WAIT_SECONDS}). Use only when you cannot continue without a reply.`,
  }),
})

type Run = {
  wf: D.Workflow
  members: string[]
  settings: Settings
  done: Deferred.Deferred<void>
  waiter: boolean
  finalized: boolean
  /** Unsaved changes; the watcher writes the file at most once a second, finalize at once. */
  dirty: boolean
  /** Agents whose rules leave send_message/read_messages visible; the step prompt mentions them only then. */
  messaging: Set<string>
  /** Agents that cannot use the edit tools: their steps skip per-step git snapshots. */
  readOnly: Set<string>
  /** Picks the model of a step added after the start (a swarm's tasks); returns an error message or undefined. */
  place: (step: D.StepSpec, state: D.StepState) => string | undefined
  /** Available free models with an allowance of their own: where a step goes when its model's allowance is spent. */
  spare: string[]
  /** A swarm: its planner's step grows into tasks, and workers add more with swarm_add. */
  swarm?: { goal: string; edits: boolean; size: number; worker: string; contract: string; next: number; added: Map<string, number>; owners: Map<string, { title: string; files: string[] }> }
}

// Process-wide: workflows started in any location of this server, and which child session is which step.
const runs = new Map<string, Run>()
// Waiters (read_messages, status with wait) sleep on this bell instead of polling: a message, a step
// change or a workflow end rings it, and every waiter re-checks at once.
const bell = new Set<() => void>()
const ring = () => {
  for (const wake of [...bell]) wake()
}
const listen = (ms: number) =>
  Effect.callback<void>((resume) => {
    const wake = () => {
      clearTimeout(timer)
      bell.delete(wake)
      resume(Effect.void)
    }
    const timer = setTimeout(wake, Math.max(0, ms))
    bell.add(wake)
    return Effect.sync(() => {
      clearTimeout(timer)
      bell.delete(wake)
    })
  })

/** Claude Code steps running now in every workflow: their processes share claudeParallel. */
/** Learned concurrency limits and speeds per model (pool.ts), shared by every workflow of this server. */
const limits: Pool.Limits = new Map()
try {
  for (const [model, ms] of Object.entries(Store.loadSpeeds())) limits.set(model, { cap: Infinity, wins: 0, until: 0, ms })
} catch {}
const saveSpeeds = () => {
  try {
    Store.saveSpeeds(Object.fromEntries([...limits].filter(([, entry]) => entry.ms !== undefined).map(([model, entry]) => [model, entry.ms!])))
  } catch {}
}
/** Steps running per model in every workflow, counted once per scheduling pass. */
const runningByModel = () => {
  const counts = new Map<string, number>()
  for (const run of runs.values())
    for (const step of run.wf.steps) {
      const state = run.wf.state[step.id]
      if (state.status === "running" && state.model) counts.set(state.model, (counts.get(state.model) ?? 0) + 1)
    }
  return counts
}
const claudeIn = (counts: Map<string, number>) => [...counts].reduce((n, [model, count]) => n + (C.isClaude(model) ? count : 0), 0)

/**
 * May this pending step start now? It picks the step's pool member (the one with the most room), honours
 * the learned per-model limits and the Claude Code process cap, and reserves its slot in `counts`.
 */
const admit = (run: Run, counts: Map<string, number>) => (id: string) => {
  const state = run.wf.state[id]
  // Another fiber's pass may have started it.
  if (state.status !== "pending") return false
  const now = Date.now()
  const count = (model: string) => counts.get(model) ?? 0
  const claudeFull = claudeIn(counts) >= run.settings.claudeParallel
  let model = state.model
  if (state.pool?.length) {
    // Claude Code members work claudeParallel at a time (shared by every Claude Code model).
    const choice = Pool.choose(state.pool, count, limits, now, (item) => (C.isClaude(item) ? run.settings.claudeParallel : Infinity), (item) => claudeFull && C.isClaude(item))
    if (!choice?.ready) return false
    model = choice.model
  } else if (model && (Pool.room(limits, model, count(model), now) <= 0 || (claudeFull && C.isClaude(model)))) return false
  if (model) {
    state.model = model
    counts.set(model, count(model) + 1)
  }
  state.status = "running"
  state.startedAt = now
  return true
}
const membership = new Map<string, { run: Run; member: string }>()
let swept = false

// mods/infiniteoc's /goal asks this before re-prompting a turn that ended, and holds while a session's
// background workflows run (a waiting start blocks its turn, so it never needs a hold).
Background.register((sessionID) =>
  [...runs.values()]
    .filter((run) => run.wf.parentSessionID === sessionID && !run.finalized && !run.waiter)
    .map((run) => ({ label: `workflow "${run.wf.name}"` })),
)

// InfiniTUI's fleet view reads workflows and live step activity through this.
const contract = {
  id: "workflows",
  methods: {
    list: { input: { type: "string" }, output: { type: "string" } },
    set: { input: { type: "string" }, output: { type: "string" } },
  },
  events: {},
} as const

const failure = (message: string, error?: unknown) => new ToolFailure({ message, ...(error === undefined ? {} : { error }) })
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const causeText = (cause: Cause.Cause<unknown>) =>
  Cause.prettyErrors(cause)
    .map((error) => error.message || error.name)
    .join("; ") || "unknown error"

export const Plugin = define({
  id: "infiniteoc.workflows",
  effect: Effect.fn(function* (ctx) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const models = yield* Model.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope
    const location = yield* Location.Service
    // Running Claude Code workers by "<workflowID>/<stepID>": their process has no session to interrupt.
    const kills = new Map<string, () => void>()

    /** {{file}}: the item's file inlined, so the step answers without a read round trip. Project files only, no .env. */
    const MAX_INLINE = 100_000
    const fileFor = (step: D.StepSpec) => {
      if (!step.item || !/\{\{\s*file\s*\}\}/.test(step.prompt)) return undefined
      const root = location.directory
      const full = path.resolve(root, step.item)
      if (!full.startsWith(root + path.sep) || /(^|[/\\])\.env(\.(?!example$)[^/\\]*)?$/.test(full)) return undefined
      try {
        const text = readFileSync(full, "utf8")
        if (text.includes("\0")) return undefined
        return text.length > MAX_INLINE ? `${text.slice(0, MAX_INLINE)}\n…[${text.length - MAX_INLINE} more characters: read the file for the rest]` : text
      } catch {
        return undefined
      }
    }

    /** glob on a step becomes each: the project files it matches (git-ignored ones skipped), sorted. */
    const withGlobs = (input: typeof Input.Type, maxSteps: number) => {
      if (!input.steps?.some((step) => step.glob)) return input
      const Glob = (globalThis as any).Bun?.Glob
      if (!Glob) throw new Error("glob needs the Bun runtime; list the items in each instead.")
      const root = location.directory
      const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 })
      const tracked: string[] | undefined = listed.status === 0 ? listed.stdout.split("\0").filter(Boolean) : undefined
      return {
        ...input,
        steps: input.steps.map((step) => {
          if (!step.glob) return step
          if (step.each) throw new Error(`Step "${step.id}": use each or glob, not both.`)
          const glob = new Glob(step.glob)
          const files: string[] = (
            tracked
              ? tracked.filter((file) => glob.match(file))
              : [...glob.scanSync({ cwd: root, onlyFiles: true })].filter((file: string) => !/(^|\/)(node_modules|\.git)\//.test(file))
          ).toSorted()
          if (files.length === 0) throw new Error(`Step "${step.id}": glob "${step.glob}" matched no files.`)
          return { ...step, each: files.slice(0, maxSteps + 1) }
        }),
      }
    }

    if (!swept) {
      swept = true
      try {
        Store.sweep()
      } catch (error) {
        yield* Effect.logWarning("InfiniteOC workflows: sweep failed", { error })
      }
    }

    // settings.json `workflows`, read per request; the enabled default is baked into DEFAULTS at build time.
    const settings = () => Store.readSettings()
    const toast = (text: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      bus.publish(TuiEvent.ToastShow, { title: "Workflow", message: text, variant, duration: 5000 }).pipe(Effect.ignore)
    const save = (run: Run) =>
      Effect.sync(() => {
        run.dirty = false
        try {
          Store.saveWorkflow(run.wf)
        } catch {}
      })
    // Every step change used to rewrite the whole file: quadratic for a 500-step fan-out.
    const persist = (run: Run) =>
      Effect.sync(() => {
        run.dirty = true
      })
    const active = (sessionID: string | undefined) =>
      sessionID === undefined ? Effect.succeed(false) : sessions.active.pipe(Effect.map((set) => set.has(sessionID as SessionSchema.ID)))

    // The last status answer per session and target (start counts as one), so an identical repeat gets the short reply.
    const checks = new Map<string, D.Check>()

    // ---- steering messages into running sessions --------------------------------------------------

    const push = (sessionID: string, text: string, description: string) =>
      sessions.synthetic({ sessionID: sessionID as SessionSchema.ID, text, description, metadata: { source: "workflow" }, resume: false }).pipe(Effect.ignore)

    /** Delivers a new message to recipients that are running now; the rest read it later. */
    const deliver = (run: Run, sent: M.Message) =>
      Effect.gen(function* () {
        for (const recipient of M.recipients(sent, run.members)) {
          const sessionID = recipient === M.MAIN ? run.wf.parentSessionID : run.wf.state[recipient]?.sessionID
          const running = recipient === M.MAIN || run.wf.state[recipient]?.status === "running"
          if (!running || !(yield* active(sessionID))) {
            // An idle starter reads it later; a /goal holding for this workflow wakes it for the message.
            if (recipient === M.MAIN)
              Background.signal(run.wf.parentSessionID, "wake", `workflow step ${sent.from} sent you a message (read_messages)`)
            continue
          }
          yield* push(
            sessionID!,
            `<workflow_message workflow="${run.wf.id}" from="${sent.from}" to="${sent.to}">\n${sent.text}\n</workflow_message>`,
            `Message from ${sent.from}`,
          )
          // A run that ended meanwhile never sees the steer; keep it unread for read_messages / the final notice.
          if (yield* active(sessionID)) M.markRead(run.wf, recipient, [sent.id])
        }
      })

    // ---- running ----------------------------------------------------------------------------------

    const runChild = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        yield* sessions.resume(sessionID)
        const session = yield* sessions.get(sessionID)
        const messages: any[] = yield* sessions.messages({ sessionID, order: "desc", limit: 20 })
        if (session.outcome === "failed") {
          const failed = messages.find((item) => item.type === "assistant" && item.error !== undefined)
          return yield* Effect.fail(new Error(failed?.error?.message ?? "the subagent run failed"))
        }
        if (session.outcome === "interrupted") return yield* Effect.interrupt
        const assistant = messages.find(
          (item) => item.type === "assistant" && item.time?.completed !== undefined && item.error === undefined,
        )
        return SubagentCompletion.text(assistant)
      })

    const finalize = (run: Run): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (run.finalized) return
        run.finalized = true
        const status = D.overall(run.wf)
        run.wf.status = status === "running" ? "failed" : status
        run.wf.endedAt ??= Date.now()
        yield* save(run)
        saveSpeeds()
        Store.clearCancel(run.wf.parentSessionID, run.wf.id)
        for (const [sessionID, entry] of membership) if (entry.run === run) membership.delete(sessionID)
        runs.delete(run.wf.id)
        const done = run.wf.steps.filter((step) => run.wf.state[step.id].status === "completed").length
        yield* toast(
          `"${run.wf.name}" ${run.wf.status}: ${done}/${run.wf.steps.length} steps completed`,
          run.wf.status === "completed" ? "success" : run.wf.status === "cancelled" ? "info" : "warning",
        )
        if (!run.waiter) {
          const unread = M.take(run.wf, M.MAIN, run.members)
          yield* save(run)
          yield* sessions
            .synthetic({
              sessionID: run.wf.parentSessionID as SessionSchema.ID,
              description: `Workflow ${run.wf.name} ${run.wf.status}`,
              text: D.finalText(run.wf, D.finalBudget(run.wf, run.settings.maxOutputChars), unread),
              metadata: { source: "workflow", workflowID: run.wf.id, state: run.wf.status },
              // Whoever cancelled already knows; the result is there for the next turn without waking the agent.
              ...(run.wf.status === "cancelled" || run.wf.status === "interrupted" ? { resume: false } : {}),
            })
            .pipe(Effect.catchCause((cause) => Effect.logWarning("InfiniteOC workflows: notification failed", { cause })))
        }
        ring()
        yield* Deferred.succeed(run.done, undefined)
      })

    const pump = (run: Run): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (run.finalized) return
        D.propagate(run.wf)
        if (run.wf.status === "running") {
          const counts = runningByModel()
          for (const id of D.ready(run.wf, run.settings.maxParallel, admit(run, counts)))
            yield* runStep(run, id).pipe(Effect.forkIn(scope, { startImmediately: true }))
        }
        yield* persist(run)
        ring()
        if (run.wf.steps.every((step) => D.isFinished(run.wf.state[step.id].status))) yield* finalize(run)
      })

    // A Claude Code step: the user's logged-in claude CLI, read-only, in this location's directory.
    // It has no child session; its tool calls go to state.activity for the TUI.
    const runClaude = (run: Run, step: D.StepSpec) =>
      Effect.callback<string, Error>((resume) => {
        const state = run.wf.state[step.id]
        const bin = C.findBinary()
        if (!bin) return resume(Effect.fail(new Error("the claude CLI is not on PATH")))
        const activity: C.Activity = (state.activity = { tools: 0 })
        const inbox = M.take(run.wf, step.id, run.members)
        const prompt = `${C.preamble(run.settings.claudeMode)}\n\n${D.stepPrompt({ workflow: run.wf, step, inbox, messaging: false, maxOutputChars: run.settings.maxOutputChars, file: fileFor(step), fast: run.settings.fleet })}`
        const exe = C.command(bin)
        const child = spawn(exe.file, C.args(Models.parseRef(state.model!).id, run.settings.claudeMode), { cwd: location.directory, env: C.env(process.env), stdio: ["pipe", "pipe", "pipe"], shell: exe.shell })
        const key = `${run.wf.id}/${step.id}`
        // Through cmd.exe the CLI is a grandchild: stop the whole tree.
        const stop = () => (exe.shell && child.pid ? void spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }) : void child.kill("SIGTERM"))
        kills.set(key, stop)
        let pending = ""
        let stderr = ""
        let outcome: { result: string } | { error: string } | undefined
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          pending += chunk
          for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
            outcome = C.parse(pending.slice(0, nl), activity) ?? outcome
            pending = pending.slice(nl + 1)
          }
        })
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2000)))
        child.stdin.on("error", () => {}) // EPIPE when claude exits before reading the prompt
        child.on("error", (error) => {
          kills.delete(key)
          resume(Effect.fail(error))
        })
        child.on("close", (code) => {
          kills.delete(key)
          if (outcome && "result" in outcome) resume(Effect.succeed(outcome.result))
          else resume(Effect.fail(new Error(outcome?.error ?? (stderr.trim() || `claude exited with code ${code}`))))
        })
        child.stdin.end(prompt)
        return Effect.sync(stop)
      })

    // Child sessions of each running step, "<workflowID>/<stepID>": a step with a backup run has two.
    const live = new Map<string, Set<string>>()

    /** One run of a step in its own child session; interrupting it (a lost race, a cancel) stops the session. */
    const attempt = (run: Run, step: D.StepSpec, model: string | undefined, text: string) => {
      const state = run.wf.state[step.id]
      const key = `${run.wf.id}/${step.id}`
      let childID: string | undefined
      return Effect.gen(function* () {
        const child = yield* sessions.create({
          parentID: run.wf.parentSessionID as SessionSchema.ID,
          title: `${step.title}${step.item ? `: ${step.item.slice(0, 60)}` : ""} (${run.wf.name} · ${model ? Models.parseRef(model).id : "default model"})`,
          agent: Agent.ID.make(step.agent),
          ...(model ? { model: Model.Ref.parse(model) } : {}),
        })
        childID = child.id
        state.sessionID = child.id
        live.set(key, (live.get(key) ?? new Set()).add(child.id))
        membership.set(child.id, { run, member: step.id })
        if (run.readOnly.has(step.agent)) NoSnapshot.sessions.add(child.id)
        // A cancel while the session was being created must not start it.
        if (state.status !== "running") return undefined
        yield* persist(run)
        yield* sessions.prompt({ sessionID: child.id, text, resume: false })
        if (state.status !== "running") return undefined
        yield* jobs.start({
          id: child.id,
          type: "workflow",
          title: step.title,
          metadata: { workflowID: run.wf.id, stepID: step.id },
          run: runChild(child.id),
        })
        if (state.status !== "running") {
          yield* stopSession(child.id)
          return undefined
        }
        const info = (yield* jobs.wait({ id: child.id })).info
        return info ? { ...info, sessionID: child.id, model } : undefined
      }).pipe(
        Effect.onInterrupt(() => (childID ? stopSession(childID) : Effect.void)),
        Effect.ensuring(
          Effect.sync(() => {
            if (!childID) return
            NoSnapshot.sessions.delete(childID)
            live.get(key)?.delete(childID)
          }),
        ),
      )
    }

    /**
     * When a fan-out item counts as a straggler: 2.5 × the median time of its finished siblings (3 or
     * more), else of its model, at least 4 s; 10 s while nothing is known. Re-read as siblings finish.
     * The wall time of a fan-out is its slowest step: in a measured 34-item run the median step took
     * 2.5 s and the last one 16.8 s.
     */
    const hedgeAfter = (run: Run, step: D.StepSpec, model: string | undefined) => {
      const done = run.wf.steps
        .filter((item) => item.group === step.group && run.wf.state[item.id].status === "completed")
        .map((item) => (run.wf.state[item.id].endedAt ?? 0) - (run.wf.state[item.id].startedAt ?? 0))
        .toSorted((a, b) => a - b)
      const typical = done.length >= 3 ? done[Math.floor(done.length / 2)] : model ? limits.get(model)?.ms : undefined
      return typical === undefined ? 10_000 : Math.max(4000, Math.round(typical * 2.5))
    }
    const straggling = (run: Run, step: D.StepSpec, model: string | undefined) =>
      Effect.gen(function* () {
        const started = run.wf.state[step.id].startedAt ?? Date.now()
        while (Date.now() - started < hedgeAfter(run, step, model)) yield* Effect.sleep("250 millis")
      })

    /** Adds one task to a running swarm (before its review step); returns the new step id or an error. */
    const addTask = (run: Run, task: D.SwarmTask, id = `${D.SWARM_GROUP}-${run.swarm!.next + 1}`): string | { error: string } => {
      const swarm = run.swarm!
      if (run.wf.steps.length >= run.settings.maxSteps) return { error: `the swarm reached its limit of ${run.settings.maxSteps} steps` }
      swarm.next = Math.max(swarm.next, Number(id.slice(D.SWARM_GROUP.length + 1)) || 0)
      swarm.owners.set(id, { title: task.title, files: task.files })
      const others = [...swarm.owners].filter(([other]) => other !== id).map(([other, owner]) => ({ id: other, ...owner }))
      const step: D.StepSpec = {
        id,
        title: task.title,
        agent: swarm.worker,
        prompt: D.swarmTaskPrompt({ id, goal: swarm.goal, contract: swarm.contract, task, edits: swarm.edits, others }),
        needs: [],
        kind: D.swarmKind(task, swarm.edits),
        // Best effort like a fan-out item: one failed agent does not sink the swarm, the review sees it.
        optional: true,
        group: D.SWARM_GROUP,
        item: task.title,
      }
      const state: D.StepState = { id, status: "pending" }
      const error = run.place(step, state)
      if (error) {
        swarm.owners.delete(id)
        return { error }
      }
      const review = run.wf.steps.findIndex((item) => item.id === D.SWARM_REVIEW)
      if (review === -1) run.wf.steps.push(step)
      else {
        run.wf.steps.splice(review, 0, step)
        run.wf.steps[review + 1].needs.push(id)
      }
      run.wf.state[id] = state
      run.members.push(id)
      run.dirty = true
      return id
    }
    /** The planner finished: its JSON plan becomes the swarm's tasks, all ready at once. */
    const grow = (run: Run, state: D.StepState) =>
      Effect.gen(function* () {
        const swarm = run.swarm!
        let plan: D.SwarmPlan
        try {
          plan = D.parseSwarmPlan(state.output ?? "", Math.max(1, Math.min(swarm.size, run.settings.maxSteps - run.wf.steps.length)))
        } catch (error) {
          state.status = "failed"
          state.error = message(error)
          return
        }
        swarm.contract = plan.contract
        const ids = plan.tasks.map((_, index) => `${D.SWARM_GROUP}-${swarm.next + index + 1}`)
        // Every task's prompt lists all the others, so ownership is known before any of them is built.
        plan.tasks.forEach((task, index) => swarm.owners.set(ids[index], { title: task.title, files: task.files }))
        const errors = plan.tasks.map((task, index) => addTask(run, task, ids[index])).filter((result) => typeof result !== "string")
        if (errors.length === plan.tasks.length) {
          state.status = "failed"
          state.error = `no task could start: ${errors[0].error}`
          return
        }
        state.output = D.swarmPlanSummary(plan, ids)
        yield* toast(`Swarm "${run.wf.name}": ${plan.tasks.length - errors.length} agents started`)
      })

    const runStep = (run: Run, id: string): Effect.Effect<void> => {
      const step = run.wf.steps.find((item) => item.id === id)!
      const state = run.wf.state[id]
      const body = Effect.gen(function* () {
        if (C.isClaude(state.model)) return { status: "completed" as const, output: yield* runClaude(run, step), error: undefined as string | undefined }
        const inbox = M.take(run.wf, id, run.members)
        const text = D.stepPrompt({ workflow: run.wf, step, inbox, messaging: run.messaging.has(step.agent), maxOutputChars: run.settings.maxOutputChars, file: fileFor(step), fast: run.settings.fleet })
        const primary = state.model
        // Only read-only fan-out items get a backup run: running them twice cannot corrupt anything.
        if (!step.group || !run.readOnly.has(step.agent)) return yield* attempt(run, step, primary, text)
        // A straggler gets a backup on the pool member expected to finish first (or its own model); the
        // first to complete wins and the other is stopped. A backup that fails never wins.
        const backup = straggling(run, step, primary).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (state.status !== "running") return Effect.never
              const counts = runningByModel()
              const others = (state.pool ?? []).filter((model) => model !== primary && !C.isClaude(model))
              return attempt(run, step, Pool.pick(others, (model) => counts.get(model) ?? 0, limits, Date.now()) ?? primary, text)
            }),
          ),
          Effect.flatMap((info) => (info?.status === "completed" ? Effect.succeed(info) : Effect.never)),
          Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.never)),
        )
        const winner = yield* Effect.raceFirst(attempt(run, step, primary, text), backup)
        if (winner) {
          state.sessionID = winner.sessionID
          if (winner.model) state.model = winner.model
        }
        return winner
      })
      return body.pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            // Cancelled meanwhile: cancel() already recorded the outcome.
            if (state.status !== "running") return
            const info = Exit.isSuccess(exit) ? exit.value : undefined
            if (Exit.isFailure(exit)) {
              state.status = Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : "failed"
              state.error = causeText(exit.cause)
            } else if (!info) {
              state.status = "failed"
              state.error = "the step's job disappeared"
            } else if (info.status === "completed") {
              state.status = "completed"
              state.output = D.truncate(info.output ?? SubagentCompletion.NO_TEXT, step.group ? MAX_ITEM_OUTPUT : MAX_STORED_OUTPUT)
              if (state.model) Pool.succeeded(limits, state.model, Date.now() - (state.startedAt ?? Date.now()), run.settings.maxParallel)
            } else {
              state.status = info.status === "cancelled" ? "cancelled" : "failed"
              state.error = info.error ?? info.status
            }
            // A failed fan-out item with a pool goes back in the queue (twice at most): the scheduler then
            // places it with what it has learned, on a member with room, or waits for a Claude Code slot.
            if (state.status === "failed" && step.group && (state.pool?.length ?? 0) > 1 && (state.attempts ?? 0) < 2 && run.wf.status === "running") {
              state.attempts = (state.attempts ?? 0) + 1
              state.status = "pending"
              state.lastError = state.error
              for (const key of ["error", "startedAt", "sessionID", "activity"] as const) delete state[key]
              yield* pump(run)
              return
            }
            state.endedAt = Date.now()
            if (run.settings.notify === "each" && (yield* active(run.wf.parentSessionID))) {
              yield* push(
                run.wf.parentSessionID,
                `<workflow_step workflow="${run.wf.id}" step="${id}" status="${state.status}">\n${D.stepResult(run.wf, id, 2000)}\n</workflow_step>`,
                `Workflow step ${id} ${state.status}`,
              )
            } else {
              // A /goal holding for this workflow: per-step notifications wake it, otherwise it only learns the work is alive.
              Background.signal(
                run.wf.parentSessionID,
                run.settings.notify === "each" ? "wake" : "progress",
                `step ${id} of workflow ${run.wf.id} ${state.status} (its output: workflow action "result" with stepID ${id})`,
              )
            }
            if (run.swarm && id === D.SWARM_PLANNER && state.status === "completed") yield* grow(run, state)
            yield* pump(run)
          }),
        ),
        // The plugin scope closed (location reload or shutdown): steps run as process-wide jobs, so stop
        // every running one explicitly and record the end, instead of leaving children spending tokens.
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            if (run.finalized) return
            const running = D.cancelAll(run.wf, Date.now(), "interrupted")
            run.wf.status = "interrupted"
            for (const other of running) yield* stopStep(run, other)
            yield* finalize(run)
          }),
        ),
      )
    }

    const stopSession = (sessionID: string | undefined) =>
      sessionID === undefined
        ? Effect.void
        : Effect.all([sessions.interrupt(sessionID as SessionSchema.ID), jobs.cancel(sessionID)], { discard: true })
    const stopStep = (run: Run, id: string) =>
      Effect.gen(function* () {
        kills.get(`${run.wf.id}/${id}`)?.()
        const sessionIDs = new Set([...(live.get(`${run.wf.id}/${id}`) ?? []), ...(run.wf.state[id]?.sessionID ? [run.wf.state[id].sessionID!] : [])])
        for (const sessionID of sessionIDs) yield* stopSession(sessionID)
      })

    const cancel = (run: Run, reason: string) =>
      Effect.gen(function* () {
        if (run.finalized) return
        const running = D.cancelAll(run.wf, Date.now(), reason)
        for (const id of running) yield* stopStep(run, id)
        yield* finalize(run)
      })

    const cancelStep = (run: Run, id: string) =>
      Effect.gen(function* () {
        const state = run.wf.state[id]
        if (!state) return `Unknown step "${id}".`
        if (D.isFinished(state.status)) return `Step ${id} already ${state.status}.`
        state.status = "cancelled"
        state.error = "cancelled by the starting agent"
        state.endedAt = Date.now()
        yield* stopStep(run, id)
        yield* pump(run)
        return `Cancelled step ${id}; steps that require it are skipped.`
      })

    // The TUI asks for a cancel with a marker file; one watcher per running workflow.
    const watch = (run: Run) =>
      Effect.gen(function* () {
        while (!run.finalized) {
          yield* Effect.sleep("1 second")
          if (!run.finalized && Store.cancelRequested(run.wf.parentSessionID, run.wf.id)) yield* cancel(run, "cancelled by the user")
          // A model that paused after a rate limit has room again without any step finishing to notice.
          if (!run.finalized && run.wf.steps.some((step) => run.wf.state[step.id].status === "pending")) yield* pump(run)
          if (!run.finalized && run.dirty) yield* save(run)
        }
      })

    // ---- the workflow tool ------------------------------------------------------------------------

    const owned = (sessionID: string, workflowID: string | undefined) => {
      if (!workflowID) return undefined
      const run = runs.get(workflowID)
      if (run) return run.wf.parentSessionID === sessionID ? run.wf : undefined
      try {
        return Store.loadWorkflow(sessionID, workflowID)
      } catch {
        return undefined
      }
    }

    type SwarmSpec = { goal: string; edits: boolean; size: number; worker: string }
    const start = (input: typeof Input.Type, context: { sessionID: SessionSchema.ID; agent: Agent.ID; messageID: any; id: any }, swarm?: SwarmSpec) =>
      Effect.gen(function* () {
        const current = settings()
        if (!current.enabled)
          return yield* failure('Workflows are turned off (workflows.enabled in the InfiniteOC settings). Use the subagent tool instead.')
        const plan = yield* Effect.try({
          try: () => D.validatePlan(withGlobs(input, current.maxSteps), { maxSteps: current.maxSteps }),
          catch: (error) => failure(message(error)),
        })
        if (current.fleet && !swarm && plan.steps.length < 2)
          return yield* failure('Fleet mode: a one-step workflow is not a fleet. Use action "swarm" with goal: the task (and edits: true if files change); the swarm splits it across many agents.')
        const parent = yield* sessions
          .get(context.sessionID)
          .pipe(Effect.mapError((error) => failure(`Parent session not found: ${context.sessionID}`, error)))
        let root = parent
        let depth = 0
        while (root.parentID) {
          depth++
          root = yield* sessions.get(root.parentID).pipe(Effect.mapError((error) => failure(`Parent session not found: ${root.parentID}`, error)))
        }
        const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 1
        if (depth >= limit)
          return yield* failure(`Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`)

        // Every step's agent must exist, be a subagent, and pass the same permission check the subagent tool makes.
        const resolved = new Map<string, Agent.Info>()
        for (const step of plan.steps) {
          if (resolved.has(step.agent)) continue
          const agent = yield* agents.resolve(step.agent)
          if (agent === undefined) return yield* failure(`Unknown agent "${step.agent}" in step "${step.id}".`)
          if (agent.mode === "primary") return yield* failure(`Agent ${step.agent} cannot run as a subagent (step "${step.id}").`)
          resolved.set(step.agent, agent)
        }
        if (swarm && !resolved.has(swarm.worker)) {
          const agent = yield* agents.resolve(swarm.worker)
          if (agent === undefined || agent.mode === "primary") return yield* failure(`The swarm's ${swarm.worker} agent is not available as a subagent.`)
          resolved.set(swarm.worker, agent)
        }
        for (const agent of resolved.values())
          yield* permission
            .assert({
              action: "subagent",
              resources: [agent.id],
              save: [agent.id],
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            .pipe(Effect.mapError((error) => failure(`Subagent denied: ${agent.id}`, error)))

        // Model per step, from the models the user actually has available.
        const available = (yield* models.available()).map(
          (model): Models.Candidate => ({
            providerID: model.providerID,
            id: model.id,
            family: model.family,
            status: model.status,
            released: model.time.released,
            outputCost: Number(model.cost.find((cost) => !cost.tier)?.output ?? model.cost[0]?.output ?? 0),
            tools: model.capabilities.tools,
            text:
              model.capabilities.input.some((item) => item.startsWith("text")) &&
              model.capabilities.output.some((item) => item.startsWith("text")),
            variants: model.variants.map((variant) => variant.id),
          }),
        )
        const plain = (ref: Model.Ref | undefined): Models.Ref | undefined =>
          ref ? { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) } : undefined
        // A session without its own model runs on the configured default one.
        const fallback = parent.model ? undefined : yield* models.default().pipe(Effect.orElseSucceed(() => undefined))
        const parentModel = plain(parent.model) ?? (fallback ? { providerID: fallback.providerID, id: fallback.id } : undefined)
        const smallInfo = parentModel
          ? yield* models.small(Model.Ref.parse(Models.formatRef(parentModel)).providerID).pipe(Effect.orElseSucceed(() => undefined))
          : undefined
        const small = smallInfo ? available.find((model) => model.providerID === smallInfo.providerID && model.id === smallInfo.id) : undefined

        // Fleet mode keeps the user's Claude Code limits free: claude-code/* drops out of every tier and pool.
        const claudeCode = !current.fleet && C.findBinary() !== undefined
        const workflow: D.Workflow = {
          id: `wf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          name: plan.name,
          parentSessionID: context.sessionID,
          status: "running",
          createdAt: Date.now(),
          pid: process.pid,
          steps: plan.steps,
          state: D.initialState(plan.steps),
          messages: [],
        }
        const place = (step: D.StepSpec, state: D.StepState) => {
          if (current.fleet && step.model?.includes(`${C.PROVIDER}/`)) return "fleet mode does not use Claude Code. Leave model unset."
          const choice = Models.chooseModel({
            step,
            policy: current,
            parent: parentModel,
            agentModel: plain(resolved.get(step.agent)!.model),
            available,
            small,
            claudeCode,
            claudeEdits: current.claudeMode !== "readonly",
          })
          if ("error" in choice) return choice.error
          Object.assign(state, {
            ...(choice.ref ? { model: Models.formatRef(choice.ref) } : {}),
            ...(choice.pool && choice.pool.length > 1 ? { pool: choice.pool } : {}),
            tier: choice.tier,
            kind: choice.kind,
            modelReason: choice.reason,
          })
          return undefined
        }
        for (const step of plan.steps) {
          const error = place(step, workflow.state[step.id])
          if (error) return yield* failure(`Step "${step.id}": ${error}`)
        }

        const run: Run = {
          wf: workflow,
          members: [M.MAIN, ...plan.steps.map((step) => step.id)],
          settings: current,
          done: yield* Deferred.make<void>(),
          waiter: input.wait === true,
          finalized: false,
          dirty: false,
          messaging: new Set(
            [...resolved.values()]
              .filter((agent) => Permission.evaluate("workflow_message", "*", agent.permissions).effect !== "deny")
              .map((agent) => agent.id as string),
          ),
          readOnly: new Set(
            [...resolved.values()]
              .filter((agent) => Permission.evaluate("edit", "*", agent.permissions).effect === "deny")
              .map((agent) => agent.id as string),
          ),
          place,
          spare: FREE_POOL.split(",")
            .map((ref) => ref.trim())
            .filter((ref) => available.some((model) => `${model.providerID}/${model.id}` === ref)),
          ...(swarm ? { swarm: { ...swarm, contract: "", next: 0, added: new Map(), owners: new Map() } } : {}),
        }
        runs.set(workflow.id, run)
        yield* save(run)
        yield* toast(swarm ? `Swarm "${workflow.name}": planning up to ${swarm.size} agents` : `Started "${workflow.name}" with ${plan.steps.length} steps`)
        yield* watch(run).pipe(Effect.forkIn(scope, { startImmediately: true }))
        yield* pump(run)

        if (input.wait === true) {
          // Like a foreground subagent: interrupting the waiting call stops the workflow (no wake-up follows).
          yield* Deferred.await(run.done).pipe(Effect.onInterrupt(() => cancel(run, "the starting agent was interrupted")))
          return { id: workflow.id, text: D.finalText(workflow, D.finalBudget(workflow, current.maxOutputChars), M.take(workflow, M.MAIN, run.members)) }
        }
        checks.set(`${context.sessionID}:${workflow.id}`, { key: D.progressKey([workflow]), at: Date.now() })
        const text = [
          D.statusText(workflow),
          "",
          `The workflow is running in the background (workflowID: ${workflow.id}). You will be notified automatically when it finishes.`,
          "DO NOT sleep, poll or duplicate its work; avoid the files and topics its steps own. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response; the notification wakes you (under /goal too).",
        ].join("\n")
        return { id: workflow.id, text }
      })

    /** status and list: the full view when something changed, a short "no change" when polled. */
    const status = (sessionID: string, input: typeof Input.Type) =>
      Effect.gen(function* () {
        const target = input.action === "status" ? input.workflowID : undefined
        const look = () => {
          if (!target) return Store.listWorkflows(sessionID, 20).map((saved) => runs.get(saved.id)?.wf ?? saved)
          const workflow = owned(sessionID, target)
          return workflow ? [workflow] : []
        }
        let list = look()
        if (target && list.length === 0) return yield* failure(`Unknown workflow "${target}" for this session. Use action "list".`)
        const live = () => list.some((workflow) => workflow.status === "running")
        const slot = `${sessionID}:${target ?? "*"}`
        const from = D.progressKey(list)
        let key = from
        const plan = D.statusWait({ previous: checks.get(slot), key, live: live(), wait: input.action === "status" && input.wait === true, timeout: input.timeout, now: Date.now() })
        if (plan)
          while (key === from && live() && Date.now() < plan.deadline) {
            yield* listen(plan.deadline - Date.now())
            // Listing reads the stored files; a burst of step changes should not re-read them each time.
            if (!target) yield* Effect.sleep("250 millis")
            list = look()
            key = D.progressKey(list)
          }
        checks.set(slot, { key, at: Date.now() })
        if (plan && key === from) return D.unchangedText(list, Date.now() - plan.since, plan.waited)
        return list.length ? list.map(D.statusText).join("\n\n") : "This session has no workflows."
      })

    const workflowTool = (input: typeof Input.Type, context: any) =>
      Effect.gen(function* () {
        const sessionID = context.sessionID as string
        if (input.action === "start") {
          const started = yield* start(input, context)
          return { content: started.text, metadata: { workflowID: started.id } }
        }
        if (input.action === "swarm") {
          const goal = input.goal?.trim()
          if (!goal) return yield* failure("swarm needs goal: the whole task, self-contained.")
          const size = Math.max(2, Math.min(64, Math.floor(input.size ?? settings().swarmSize)))
          const edits = input.edits === true
          const steps = [
            { id: D.SWARM_PLANNER, title: "Split the goal", agent: "explore", kind: "plan" as const, prompt: D.swarmPlannerPrompt({ goal, size, edits }) },
            ...(edits ? [{ id: D.SWARM_REVIEW, title: "Review the whole", agent: "reviewer", kind: "review" as const, needs: [D.SWARM_PLANNER], prompt: D.swarmReviewPrompt(goal) }] : []),
          ]
          const started = yield* start(
            { action: "start", name: input.name ?? "swarm", steps, ...(input.wait === undefined ? {} : { wait: input.wait }) },
            context,
            { goal, edits, size, worker: edits ? "general" : "explore" },
          )
          return { content: started.text, metadata: { workflowID: started.id } }
        }
        if (input.action === "list" || input.action === "status") return yield* status(sessionID, input)
        const workflow = owned(sessionID, input.workflowID)
        if (!workflow) return yield* failure(`Unknown workflow "${input.workflowID ?? ""}" for this session. Use action "list".`)
        if (input.action === "result") {
          if (input.stepID) {
            const state = workflow.state[input.stepID]
            if (!state) return yield* failure(`Unknown step "${input.stepID}".`)
            return state.status === "completed" ? (state.output ?? "") : `Step ${input.stepID} is ${state.status}${state.error ? `: ${state.error}` : ""}.`
          }
          return D.finalText(workflow, Math.max(settings().maxOutputChars, 4000) * 4, [])
        }
        const run = runs.get(workflow.id)
        if (!run || run.finalized) return `Workflow ${workflow.id} already ${workflow.status}.`
        if (input.stepID) return yield* cancelStep(run, input.stepID)
        yield* cancel(run, "cancelled by the starting agent")
        return D.statusText(run.wf)
      }).pipe(Effect.map((result) => (typeof result === "string" ? { content: result, metadata: { workflowID: input.workflowID } } : result)))

    // ---- messaging --------------------------------------------------------------------------------

    /** The workflows a session can talk in: its own step's, or the running ones it started. */
    const conversations = (sessionID: string, workflowID?: string) => {
      const member = membership.get(sessionID)
      if (member) return workflowID && workflowID !== member.run.wf.id ? [] : [member]
      return [...runs.values()]
        .filter((run) => run.wf.parentSessionID === sessionID && !run.finalized && (!workflowID || run.wf.id === workflowID))
        .map((run) => ({ run, member: M.MAIN }))
    }

    const sendTool = (input: typeof SendInput.Type, context: any) =>
      Effect.gen(function* () {
        const found = conversations(context.sessionID, input.workflowID)
        if (found.length === 0) return yield* failure("You are not in a running workflow, so there is nobody to message.")
        if (found.length > 1)
          return yield* failure(`Several of your workflows are running; pass workflowID (${found.map((item) => item.run.wf.id).join(", ")}).`)
        const { run, member } = found[0]
        const sent = yield* Effect.try({
          try: () => M.send(run.wf, { from: member, to: input.to, text: input.text, members: run.members }),
          catch: (error) => failure(message(error)),
        })
        yield* deliver(run, sent)
        ring()
        yield* persist(run)
        const notes = M.recipients(sent, run.members)
          .filter((recipient) => recipient !== M.MAIN)
          .map((recipient) => {
            const status = run.wf.state[recipient].status
            return status === "pending"
              ? `${recipient} has not started; it gets the message when it starts.`
              : D.isFinished(status)
                ? `${recipient} already ${status} and will not see it.`
                : undefined
          })
          .filter(Boolean)
        return { content: [`Sent message #${sent.id} to ${sent.to}.`, ...notes].join("\n") }
      })

    const swarmAddTool = (input: typeof SwarmAddInput.Type, context: any) =>
      Effect.gen(function* () {
        const entry = membership.get(context.sessionID)
        const run = entry?.run
        if (!entry || !run?.swarm || run.finalized) return yield* failure("You are not an agent of a running swarm.")
        const swarm = run.swarm
        const count = swarm.added.get(entry.member) ?? 0
        if (count >= D.SWARM_ADD_LIMIT)
          return yield* failure(`You already added ${D.SWARM_ADD_LIMIT} tasks. Finish your own task and list what is left in your reply.`)
        const prompt = input.prompt.trim()
        if (!prompt) return yield* failure("The task has no prompt.")
        const files = (input.files ?? []).map((file) => file.trim()).filter(Boolean)
        const taken = swarm.edits ? files.filter((file) => [...swarm.owners].some(([id, owner]) => id !== entry.member && owner.files.includes(file))) : []
        if (taken.length) return yield* failure(`Already owned by another agent: ${taken.join(", ")}. Message its owner instead.`)
        const title = (input.title.trim() || prompt).slice(0, 60)
        const result = addTask(run, { title, prompt, files })
        if (typeof result !== "string") return yield* failure(result.error)
        swarm.added.set(entry.member, count + 1)
        yield* pump(run)
        return { content: `Added ${result} ("${title}"); it starts on a new agent now. Message it as ${result}.` }
      })

    const readTool = (input: typeof ReadInput.Type, context: any) =>
      Effect.gen(function* () {
        const wait = Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(input.wait ?? 0)))
        const deadline = Date.now() + wait * 1000
        for (;;) {
          const found = conversations(context.sessionID, input.workflowID)
          if (found.length === 0) return { content: "You are not in a running workflow." }
          const messages = found.flatMap(({ run, member }) => {
            const taken = M.take(run.wf, member, run.members)
            if (taken.length) run.dirty = true
            return taken
          })
          if (messages.length) return { content: M.format(messages) }
          if (Date.now() >= deadline) return { content: "No new messages." }
          yield* listen(deadline - Date.now())
        }
      })

    const stored = new Map<string, { at: number; list: D.Workflow[] }>()
    // A need on a whole group shows as the group's id, not its 500 step ids.
    const needsOf = (wf: D.Workflow, step: D.StepSpec) => {
      const byID = new Map(wf.steps.map((item) => [item.id, item]))
      return [...new Set(step.needs.map((need) => byID.get(need)?.group ?? need))]
    }
    const CELL: Record<string, string> = { pending: "p", running: "r", completed: "c", failed: "f", skipped: "s", cancelled: "x" }

    // Live activity of a running OpenCode step: its latest tool call and how many it made (last 30 messages).
    const sessionActivity = (sessionID: string) =>
      sessions.messages({ sessionID: sessionID as SessionSchema.ID, order: "desc", limit: 30 }).pipe(
        Effect.map((messages: any[]) => {
          const activity: C.Activity = { tools: 0 }
          for (const item of messages)
            for (const block of (item.type === "assistant" && Array.isArray(item.content) ? item.content : []).toReversed()) {
              if (block?.type === "tool") {
                activity.tools++
                activity.tool ??= String(block.name)
                if (activity.tools === 1) activity.detail = C.describe(block.state?.input)
              } else if (block?.type === "text" && !activity.text && typeof block.text === "string" && block.text.trim())
                activity.text = block.text.replace(/\s+/g, " ").trim().slice(0, 160)
            }
          return activity
        }),
        Effect.orElseSucceed(() => undefined),
      )

    yield* ctx.rpc
      .register(contract, {
        list: (input) =>
          Effect.gen(function* () {
            let sessionID = ""
            try {
              sessionID = String(JSON.parse(String(input || "{}")).sessionID ?? "")
            } catch {}
            if (!/^[\w-]{1,128}$/.test(sessionID)) return "[]"
            // Finished workflows come from disk; a big one is megabytes, so read the list at most every 5 s.
            const cached = stored.get(sessionID)
            const saved = cached && Date.now() - cached.at < 5000 ? cached.list : Store.listWorkflows(sessionID, 6)
            if (saved !== cached?.list) stored.set(sessionID, { at: Date.now(), list: saved })
            const live = [...runs.values()].filter((run) => run.wf.parentSessionID === sessionID).map((run) => run.wf)
            const recent = [...live, ...saved.filter((wf) => !runs.has(wf.id))]
              .toSorted((a, b) => b.createdAt - a.createdAt)
              .slice(0, 6)
              .filter((wf) => wf.status === "running" || Date.now() - (wf.endedAt ?? wf.createdAt) < 15 * 60_000)
            // Live activity costs a message query per step: only for the first running ones shown.
            let lookups = 12
            const view = function* (wf: D.Workflow, step: D.StepSpec) {
              const { output, ...state } = wf.state[step.id]
              const activity =
                state.activity ?? (state.status === "running" && state.sessionID && lookups-- > 0 ? yield* sessionActivity(state.sessionID) : undefined)
              const result = output?.replace(/\s+/g, " ").trim().slice(0, 200)
              return { title: step.title, agent: step.agent, needs: needsOf(wf, step), item: step.item, ...state, ...(activity ? { activity } : {}), ...(result ? { result } : {}) }
            }
            const out = []
            for (const wf of recent) {
              const all = D.groups(wf.steps)
              const steps = []
              for (const step of wf.steps) {
                if (!step.group) {
                  steps.push(yield* view(wf, step))
                  continue
                }
                const members = all.get(step.group)!
                if (members[0] !== step) continue
                // One entry per group: a status letter per item for the grid, details for the running ones.
                const states = members.map((item) => wf.state[item.id])
                const running = members.filter((item) => wf.state[item.id].status === "running").slice(0, 6)
                const live = []
                for (const item of running) live.push(yield* view(wf, item))
                const status = states.some((item) => item.status === "running" || item.status === "pending")
                  ? states.some((item) => item.status === "running") ? "running" : "pending"
                  : states.some((item) => item.status === "failed") ? "failed" : states.every((item) => item.status === "completed") ? "completed" : "cancelled"
                const starts = states.map((item) => item.startedAt ?? 0).filter(Boolean)
                steps.push({
                  id: step.group,
                  title: step.title,
                  agent: step.agent,
                  needs: needsOf(wf, step),
                  status,
                  model: [...new Set(states.map((item) => item.model ?? ""))].join(", "),
                  group: true,
                  cells: states.map((item) => CELL[item.status] ?? "?").join(""),
                  members: live,
                  ...(starts.length ? { startedAt: Math.min(...starts) } : {}),
                  ...(status !== "running" && status !== "pending" ? { endedAt: Math.max(...states.map((item) => item.endedAt ?? 0)) } : {}),
                })
              }
              out.push({ id: wf.id, name: wf.name, status: wf.status, createdAt: wf.createdAt, endedAt: wf.endedAt, steps })
            }
            return JSON.stringify(out)
          }),
        // {key, value}: one workflows setting as applyChange knows it (preset, claudeMode, maxParallel, …).
        set: (input) =>
          Effect.sync(() => {
            try {
              const { key, value } = JSON.parse(String(input ?? "{}"))
              return JSON.stringify(Store.changeSetting(String(key), String(value)))
            } catch {
              return JSON.stringify({ error: "expected {key, value}" })
            }
          }),
      })
      .pipe(Effect.orDie)

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: TOOL,
          // Same visibility as the subagent tool: agents that may not spawn subagents never see it.
          options: { codemode: false, permission: "subagent" },
          description: [
            "The preferred way to delegate two or more tasks (instead of several subagent calls): runs subagent steps with dependencies (a DAG). Independent steps run in parallel, dependent steps in order, and each step gets the results of the steps it needs.",
            "It runs in the background by default and you are notified when it finishes, so do not poll it (wait: true returns the results in this call instead); the steps can message each other and you.",
            "Each step gets a model chosen for its kind of work unless you set one.",
            'action "swarm" with a goal runs many agents on it without you writing steps: a planner splits the goal into up to size tasks with a shared contract, all run at once, they message each other and add tasks they find; edits: true for work that changes files (then a reviewer checks the whole).',
            'Per-file or per-item work (summarize, review, check or extract from each of many files or items): ONE step with glob (e.g. "src/**/*.ts") or each: [...], and {{file}} in its prompt. Every file then gets its own small step with the file already inlined, all in parallel, done in seconds. Never split such work into a few steps that each read several files: those read one file per model round trip and are many times slower.',
          ].join("\n"),
          input: Input,
          execute: workflowTool,
        })
        editor.add({
          name: SEND,
          options: { codemode: false, permission: "workflow_message" },
          description: "Send a message to another member of your workflow: a step id, \"main\" (the agent that started it) or \"all\". Running recipients see it at their next step.",
          input: SendInput,
          execute: sendTool,
        })
        editor.add({
          name: SWARM_ADD,
          options: { codemode: false, permission: "workflow_message" },
          description: "Swarm agents only: add a task the goal needs that no agent covers. It starts at once on a new agent, with the goal and the contract.",
          input: SwarmAddInput,
          execute: swarmAddTool,
        })
        editor.add({
          name: READ,
          options: { codemode: false, permission: "workflow_message" },
          description: "Read the unread messages other members of your workflow sent you.",
          input: ReadInput,
          execute: readTool,
        })
      })
      .pipe(Effect.orDie)

    // Fleet mode: the primary agents that got FLEET_GUIDANCE, and their direct work calls since they last delegated.
    const fleetSessions = new Set<string>()
    const fleetCounts = new Map<string, number>()
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const current = settings()
        if (!current.enabled) delete event.tools[TOOL]
        const sessionID = event.sessionID as string
        const involved =
          membership.has(sessionID) || [...runs.values()].some((run) => run.wf.parentSessionID === sessionID) || event.tools[TOOL] !== undefined
        if (!involved) {
          delete event.tools[SEND]
          delete event.tools[READ]
        }
        if (!membership.get(sessionID)?.run.swarm) delete event.tools[SWARM_ADD]
        const tool = event.tools[TOOL]
        if (!tool) return
        const selected = yield* agents.resolve(event.agent)
        const available = selected
          ? (yield* agents.list())
              .filter(
                (agent) =>
                  agent.mode !== "primary" &&
                  !agent.hidden &&
                  Permission.evaluate("subagent", agent.id, selected.permissions).effect !== "deny",
              )
              .toSorted((a, b) => a.id.localeCompare(b.id))
          : []
        tool.description = [
          tool.description,
          "",
          // The subagent tool in the same request already describes each agent; repeat only the names then.
          ...(event.tools.subagent
            ? [`Agents for steps (described in the subagent tool): ${available.map((agent) => agent.id).join(", ")}.`]
            : ["Agents for steps:", ...available.map((agent) => `- ${agent.id}: ${agent.description ?? "Use only when explicitly requested."}`)]),
          "",
          `Model tiers now: fast = ${current.models.fast}, strong = ${current.models.strong}, default = ${current.models.default}. At most ${current.maxParallel} steps run at once (Claude Code: ${current.claudeParallel}), ${current.maxSteps} steps per workflow after expanding each.`,
          ...(!current.fleet && C.findBinary()
            ? [
                `${C.MODELS.map((id) => `${C.PROVIDER}/${id}`).join(", ")} run a step on the user's Claude Code` +
                  (current.claudeMode === "readonly"
                    ? ", read-only (search, read, web): only for steps that do not edit."
                    : " with full tools (edits, shell); give parallel ones disjoint files."),
              ]
            : []),
        ].join("\n")
        // Compaction and side generations get the same tools and guidance as the session's requests, so
        // their prompt prefix matches and they reuse its cache instead of re-reading the conversation.
        event.system.push(SystemPart.make(GUIDANCE))
        if (current.fleet && selected?.mode !== "subagent" && !membership.has(sessionID)) {
          event.system.push(SystemPart.make(FLEET_GUIDANCE))
          fleetSessions.add(sessionID)
        } else fleetSessions.delete(sessionID)
      })
    // Budgets the prompts alone do not hold on small models: a swarm planner gets PLANNER_TOOL_BUDGET tool
    // calls, and a fleet orchestrator's work tools are refused after FLEET_BLOCK_AT calls until it delegates.
    const plannerCalls = new Map<string, number>()
    yield* ctx.tool.hook("execute.before", (event) => {
      const sessionID = event.sessionID as string
      const entry = membership.get(sessionID)
      if (entry?.run.swarm && entry.member === D.SWARM_PLANNER) {
        const calls = (plannerCalls.get(sessionID) ?? 0) + 1
        plannerCalls.set(sessionID, calls)
        if (calls > D.PLANNER_TOOL_BUDGET)
          return Effect.fail(new Tool.Error({ message: `Refused: your planning budget of ${D.PLANNER_TOOL_BUDGET} tool calls is used. Reply now with only the JSON plan.` }))
        return Effect.void
      }
      if (!fleetSessions.has(sessionID) || !settings().fleet) return Effect.void
      const refusal = D.fleetBlock(fleetCounts, sessionID, event.tool)
      return refusal ? Effect.fail(new Tool.Error({ message: refusal })) : Effect.void
    })
    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed" || !fleetSessions.has(event.sessionID) || !settings().fleet) return Effect.void
      const note = D.fleetNudge(fleetCounts, event.sessionID, event.tool)
      if (!note) return Effect.void
      const content = event.result.content
      event.result = { ...event.result, content: [...(typeof content === "string" ? [{ type: "text" as const, text: content }] : (content ?? [])), { type: "text" as const, text: note }] }
      return Effect.void
    })
    // Several subagent calls from one message are a workflow done by hand: say so in the second result.
    const nudges = new Map<string, D.NudgeState>()
    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== "subagent" || event.status !== "completed" || !settings().enabled) return Effect.void
      const note = D.subagentNudge(nudges, event.sessionID, event.messageID)
      if (!note) return Effect.void
      const content = event.result.content
      event.result = { ...event.result, content: [...(typeof content === "string" ? [{ type: "text" as const, text: content }] : (content ?? [])), { type: "text" as const, text: note }] }
      return Effect.void
    })

    // A throttled step (429, 503, overload): its model's learned limit drops (pool.ts), a step with a pool
    // moves to another member, and a rate-limited one with nowhere to go (or a fleet orchestrator) waits longer.
    yield* ctx.session.hook("retry", (event) =>
      Effect.gen(function* () {
        const entry = membership.get(event.sessionID)
        if ((!entry && !fleetSessions.has(event.sessionID)) || !Pool.throttled(event.error)) return
        // A rate limit lasts longer than the default 2-10 s backoff: wait it out, growing up to a minute.
        const rated = Pool.rateLimit(event.error)
        const wait = rated ? Pool.rateLimitDelay(event.attempt, event.decision.retry ? event.decision.delay : 0) : 0
        const backOff = () => {
          if (rated && event.decision.retry) event.decision = { retry: true, delay: wait }
        }
        if (!entry) return backOff()
        const state = entry.run.wf.state[entry.member]
        const from = state.model
        if (!from || state.status !== "running") return
        const counts = runningByModel()
        const now = Date.now()
        Pool.limited(limits, from, counts.get(from) ?? 1, now, Pool.exhausted(event.error) ? Pool.QUOTA_PAUSE_MS : rated ? wait : Pool.PAUSE_MS)
        // A rate limit is usually per account: the provider's other pool members (the free OpenCode models
        // share one) pause too, so new steps do not start into it. Capacity errors (503, overload) stay per model.
        if (rated)
          for (const sibling of state.pool ?? [])
            if (sibling !== from && sibling.split("/")[0] === from.split("/")[0]) Pool.limited(limits, sibling, counts.get(sibling) ?? 1, now, wait)
        // A spent allowance (a quota, the free tier's daily limit) is final, so upstream does not retry it, but only
        // on this model: the step moves to another pool member or, without a pool, to a free model with an allowance
        // of its own, and the run's waiting steps on this model may start there too. Other errors that are not
        // retried (a bad request) end the step.
        const spent = Pool.exhausted(event.error)
        if (!event.decision.retry && !spent) return
        const members = state.pool?.length ? state.pool : spent ? entry.run.spare : []
        if (spent && !state.pool?.length && members.length)
          for (const other of Object.values(entry.run.wf.state))
            if (other.status === "pending" && other.model === from && !other.pool?.length) other.pool = [from, ...members.filter((model) => model !== from)]
        const others = members.filter((model) => model !== from && !C.isClaude(model))
        const to = others.length ? Pool.pick(others, (model) => counts.get(model) ?? 0, limits, now) : undefined
        if (!to) return backOff()
        yield* ctx.session.switchModel({ sessionID: event.sessionID, model: Model.Ref.parse(to) })
        state.model = to
        entry.run.dirty = true
        event.decision = { retry: true, delay: 200 }
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("InfiniteOC workflows: reroute failed", { cause }))),
    )

    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
})
