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
import { SystemPart, ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { TuiEvent } from "@opencode/schema/tui-event"
import { Cause, Deferred, Effect, Exit, Schema, Scope } from "effect"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Job } from "../job.js"
import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { Session } from "../session.js"
import { SessionSchema } from "../session/schema.js"
import { SubagentCompletion } from "../session/subagent-completion.js"
import * as Background from "../infiniteoc/background.js"
import * as D from "./dag.ts"
import * as M from "./mailbox.ts"
import * as Models from "./models.ts"
import { KINDS, type Settings } from "./settings.ts"
import * as Store from "./store.ts"

export const TOOL = "workflow"
export const SEND = "send_message"
export const READ = "read_messages"
const MAX_STORED_OUTPUT = 100_000
const MAX_WAIT_SECONDS = 120

export const GUIDANCE = `[Workflows]
The workflow tool is your default way to delegate more than one task. Use it whenever you would otherwise make two or more subagent calls, or one subagent call followed by a review. One call runs them all: independent steps in parallel, dependent steps in order, each on a model chosen for its kind of work, with one notification at the end. One quick task: the plain subagent tool.
- Steps: id, agent, title, a self-contained prompt (the worker starts with no context), needs (the ids it depends on; their results are passed in, or place one with {{steps.<id>}}). Mark a step optional when the rest can go on without it. Never give two steps the same files to edit.
- Shapes that pay off: parallel explore/researcher steps on separate questions; general steps on disjoint files followed by a reviewer step that needs them all; explore, then general, then reviewer for one change in unfamiliar code.
- Fast: keep each step narrow, split a broad search into parallel steps rather than one long one, set kind (search and summarize run on the fast model) and leave model unset (set it only when the user asks for a model).
- When its result is the only thing you need next, start it with wait: true: the results come back in that call, with no extra wake-up turn. Otherwise it runs in the background: keep working on non-overlapping tasks, or tell the user what you launched and end your turn; that notification wakes you, also under /goal. Do not poll: a status check that finds nothing new only says so.
- Check status only for a reason: the user asks, it has been silent far longer than its steps should take, or you need one step's result early (then status with wait: true blocks once until something changes, instead of repeated checks). "cancel" stops it.
- Steps can talk: send_message(to, text) to a step id, "main" (you) or "all", and read_messages.
- Results are claims: check the important ones before reporting.`

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
})

export const Input = Schema.Struct({
  action: Schema.Literals(["start", "status", "result", "cancel", "list"]).annotate({
    description: "start a workflow; status / result / cancel one (workflowID); list this session's workflows.",
  }),
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
  /** Agents whose rules leave send_message/read_messages visible; the step prompt mentions them only then. */
  messaging: Set<string>
}

// Process-wide: workflows started in any location of this server, and which child session is which step.
const runs = new Map<string, Run>()
const membership = new Map<string, { run: Run; member: string }>()
let swept = false

// mods/infiniteoc's /goal asks this before re-prompting a turn that ended, and holds while a session's
// background workflows run (a waiting start blocks its turn, so it never needs a hold).
Background.register((sessionID) =>
  [...runs.values()]
    .filter((run) => run.wf.parentSessionID === sessionID && !run.finalized && !run.waiter)
    .map((run) => ({ label: `workflow "${run.wf.name}"` })),
)

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
    const persist = (run: Run) =>
      Effect.sync(() => {
        try {
          Store.saveWorkflow(run.wf)
        } catch {}
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
        yield* persist(run)
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
          yield* persist(run)
          yield* sessions
            .synthetic({
              sessionID: run.wf.parentSessionID as SessionSchema.ID,
              description: `Workflow ${run.wf.name} ${run.wf.status}`,
              text: D.finalText(run.wf, Math.max(run.settings.maxOutputChars, 4000) * 2, unread),
              metadata: { source: "workflow", workflowID: run.wf.id, state: run.wf.status },
              // Whoever cancelled already knows; the result is there for the next turn without waking the agent.
              ...(run.wf.status === "cancelled" || run.wf.status === "interrupted" ? { resume: false } : {}),
            })
            .pipe(Effect.catchCause((cause) => Effect.logWarning("InfiniteOC workflows: notification failed", { cause })))
        }
        yield* Deferred.succeed(run.done, undefined)
      })

    const pump = (run: Run): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (run.finalized) return
        D.propagate(run.wf)
        if (run.wf.status === "running")
          for (const id of D.ready(run.wf, run.settings.maxParallel)) {
            const state = run.wf.state[id]
            // Another fiber's pump may have started it between our forks.
            if (state.status !== "pending") continue
            state.status = "running"
            state.startedAt = Date.now()
            yield* runStep(run, id).pipe(Effect.forkIn(scope, { startImmediately: true }))
          }
        yield* persist(run)
        if (run.wf.steps.every((step) => D.isFinished(run.wf.state[step.id].status))) yield* finalize(run)
      })

    const runStep = (run: Run, id: string): Effect.Effect<void> => {
      const step = run.wf.steps.find((item) => item.id === id)!
      const state = run.wf.state[id]
      const body = Effect.gen(function* () {
        const child = yield* sessions.create({
          parentID: run.wf.parentSessionID as SessionSchema.ID,
          title: `${step.title} (${run.wf.name} · ${state.model ? Models.parseRef(state.model).id : "default model"})`,
          agent: Agent.ID.make(step.agent),
          ...(state.model ? { model: Model.Ref.parse(state.model) } : {}),
        })
        state.sessionID = child.id
        membership.set(child.id, { run, member: id })
        // A cancel while the session was being created must not start it.
        if (state.status !== "running") return undefined
        const inbox = M.take(run.wf, id, run.members)
        yield* persist(run)
        yield* sessions.prompt({
          sessionID: child.id,
          text: D.stepPrompt({ workflow: run.wf, step, inbox, messaging: run.messaging.has(step.agent), maxOutputChars: run.settings.maxOutputChars }),
          resume: false,
        })
        if (state.status !== "running") return undefined
        yield* jobs.start({
          id: child.id,
          type: "workflow",
          title: step.title,
          metadata: { workflowID: run.wf.id, stepID: id },
          run: runChild(child.id),
        })
        if (state.status !== "running") {
          yield* stopSession(child.id)
          return undefined
        }
        return (yield* jobs.wait({ id: child.id })).info
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
              state.output = D.truncate(info.output ?? SubagentCompletion.NO_TEXT, MAX_STORED_OUTPUT)
            } else {
              state.status = info.status === "cancelled" ? "cancelled" : "failed"
              state.error = info.error ?? info.status
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
            for (const other of running) yield* stopSession(run.wf.state[other].sessionID)
            yield* finalize(run)
          }),
        ),
      )
    }

    const stopSession = (sessionID: string | undefined) =>
      sessionID === undefined
        ? Effect.void
        : Effect.all([sessions.interrupt(sessionID as SessionSchema.ID), jobs.cancel(sessionID)], { discard: true })

    const cancel = (run: Run, reason: string) =>
      Effect.gen(function* () {
        if (run.finalized) return
        const running = D.cancelAll(run.wf, Date.now(), reason)
        for (const id of running) yield* stopSession(run.wf.state[id].sessionID)
        yield* finalize(run)
      })

    const cancelStep = (run: Run, id: string) =>
      Effect.gen(function* () {
        const state = run.wf.state[id]
        if (!state) return `Unknown step "${id}".`
        if (D.isFinished(state.status)) return `Step ${id} already ${state.status}.`
        const sessionID = state.sessionID
        state.status = "cancelled"
        state.error = "cancelled by the starting agent"
        state.endedAt = Date.now()
        yield* stopSession(sessionID)
        yield* pump(run)
        return `Cancelled step ${id}; steps that require it are skipped.`
      })

    // The TUI asks for a cancel with a marker file; one watcher per running workflow.
    const watch = (run: Run) =>
      Effect.gen(function* () {
        while (!run.finalized) {
          yield* Effect.sleep("1 second")
          if (!run.finalized && Store.cancelRequested(run.wf.parentSessionID, run.wf.id)) yield* cancel(run, "cancelled by the user")
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

    const start = (input: typeof Input.Type, context: { sessionID: SessionSchema.ID; agent: Agent.ID; messageID: any; id: any }) =>
      Effect.gen(function* () {
        const current = settings()
        if (!current.enabled)
          return yield* failure('Workflows are turned off (workflows.enabled in the InfiniteOC settings). Use the subagent tool instead.')
        const plan = yield* Effect.try({
          try: () => D.validatePlan(input, { maxSteps: current.maxSteps }),
          catch: (error) => failure(message(error)),
        })
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
        for (const step of plan.steps) {
          const choice = Models.chooseModel({
            step,
            policy: current,
            parent: parentModel,
            agentModel: plain(resolved.get(step.agent)!.model),
            available,
            small,
          })
          if ("error" in choice) return yield* failure(`Step "${step.id}": ${choice.error}`)
          Object.assign(workflow.state[step.id], {
            ...(choice.ref ? { model: Models.formatRef(choice.ref) } : {}),
            tier: choice.tier,
            kind: choice.kind,
            modelReason: choice.reason,
          })
        }

        const run: Run = {
          wf: workflow,
          members: [M.MAIN, ...plan.steps.map((step) => step.id)],
          settings: current,
          done: yield* Deferred.make<void>(),
          waiter: input.wait === true,
          finalized: false,
          messaging: new Set(
            [...resolved.values()]
              .filter((agent) => Permission.evaluate("workflow_message", "*", agent.permissions).effect !== "deny")
              .map((agent) => agent.id as string),
          ),
        }
        runs.set(workflow.id, run)
        yield* persist(run)
        yield* toast(`Started "${workflow.name}" with ${plan.steps.length} steps`)
        yield* watch(run).pipe(Effect.forkIn(scope, { startImmediately: true }))
        yield* pump(run)

        if (input.wait === true) {
          // Like a foreground subagent: interrupting the waiting call stops the workflow (no wake-up follows).
          yield* Deferred.await(run.done).pipe(Effect.onInterrupt(() => cancel(run, "the starting agent was interrupted")))
          return { id: workflow.id, text: D.finalText(workflow, Math.max(current.maxOutputChars, 4000) * 2, M.take(workflow, M.MAIN, run.members)) }
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
            yield* Effect.sleep("1 second")
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

    const readTool = (input: typeof ReadInput.Type, context: any) =>
      Effect.gen(function* () {
        const wait = Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(input.wait ?? 0)))
        const deadline = Date.now() + wait * 1000
        for (;;) {
          const found = conversations(context.sessionID, input.workflowID)
          if (found.length === 0) return { content: "You are not in a running workflow." }
          const messages = found.flatMap(({ run, member }) => {
            const taken = M.take(run.wf, member, run.members)
            if (taken.length)
              try {
                Store.saveWorkflow(run.wf)
              } catch {}
            return taken
          })
          if (messages.length) return { content: M.format(messages) }
          if (Date.now() >= deadline) return { content: "No new messages." }
          yield* Effect.sleep("1 second")
        }
      })

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
          name: READ,
          options: { codemode: false, permission: "workflow_message" },
          description: "Read the unread messages other members of your workflow sent you.",
          input: ReadInput,
          execute: readTool,
        })
      })
      .pipe(Effect.orDie)

    const hook = (kind: "context" | "compaction" | "generate") => (event: SessionHooks["context"]) =>
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
          "Agents for steps:",
          ...available.map((agent) => `- ${agent.id}: ${agent.description ?? "Use only when explicitly requested."}`),
          "",
          `Model tiers now: fast = ${current.models.fast}, strong = ${current.models.strong}, default = ${current.models.default}. At most ${current.maxParallel} steps run at once, ${current.maxSteps} steps per workflow.`,
        ].join("\n")
        // Compaction and side generations keep the same tool list (cache-stable) but not the guidance.
        if (kind === "context") event.system.push(SystemPart.make(GUIDANCE))
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

    yield* ctx.session.hook("context", hook("context"))
    yield* ctx.session.hook("compaction", hook("compaction"))
    yield* ctx.session.hook("generate", hook("generate"))
  }),
})
