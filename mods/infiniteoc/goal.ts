// InfiniteOC /goal: keep working until the goal is done and verified.
// Written to packages/core/src/plugin/infiniteoc-goal.ts by mods/infiniteoc.
// State lives in the transcript (control messages starting with "[InfiniteOC goal"), so it
// needs no storage and a restarted server picks it up again. Notes posted with resume: false wait in
// the inbox and land before the user's next message, so a toast announces the end right away.
// While background work the agent started is still running (a workflow, a background subagent), a
// turn end does not re-prompt: the goal holds until that work wakes the session, signals the agent,
// or nothing has moved for HOLD_TIMEOUT_MS. Holding adds no control message, so it costs no turn.
import { define } from "@opencode/plugin/effect/plugin"
import { TuiEvent } from "@opencode/schema/tui-event"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { Session } from "@opencode/schema/session"
import { Effect, Scope, Stream } from "effect"
import { Bus } from "../bus.js"
import { Job } from "../job.js"
import { Session as SessionService } from "../session.js"
import * as Background from "../infiniteoc/background.js"

export const MAX_CONTINUATIONS = 20
/** A held goal resumes anyway after this long without any progress from the work it waits for. */
export const HOLD_TIMEOUT_MS = 5 * 60_000
/** Work that ended without waking the session (a cancel, a lost notice) resumes the goal after this. */
export const HOLD_SETTLE_MS = 5_000
const MAX_VERIFICATIONS = 2
const START = "[InfiniteOC goal]"
const CONTINUE = "[InfiniteOC goal: continue]"
const VERIFY = "[InfiniteOC goal: verify]"
const STOPPED = "[InfiniteOC goal: stopped]"
const FINISHED = "[InfiniteOC goal: finished]"
const PAUSED = "[InfiniteOC goal: paused]"

const protocol = [
  "Work on this autonomously until it is completely done; you will be prompted to continue after each turn.",
  "Done means implemented, tested and verified: run the relevant tests, type checks and build after your last edit, exercise the real behavior, and review your own diff.",
  "When everything is done and verified, end your reply with a line `GOAL COMPLETE: <evidence: what you ran and what passed>`.",
  "If you cannot continue without the user (missing access, a decision only they can make), end with `GOAL BLOCKED: <exactly what you need>`.",
  "Never claim completion you have not verified.",
  "If you started background work (a workflow, a background subagent) and have nothing else to do, end your turn instead of checking on it: the goal waits and continues when it finishes.",
].join("\n")

export const startText = (goal: string) => `${START}\nGoal: ${goal}\n\n${protocol}`

export const continueText = (goal: string, turn: number, note?: string) =>
  `${CONTINUE}\nGoal: ${goal}\n\nContinuation ${turn} of ${MAX_CONTINUATIONS}.${note ? ` ${note}` : ""} The goal is not marked complete yet. Keep going: pick the next concrete step, do it, and check the result. ${protocol}`

export const verifyText = (goal: string) =>
  `${VERIFY}\nGoal: ${goal}\n\nYou marked the goal complete. Verify that independently before finishing: re-read the requirements, re-run the tests, type checks and build, exercise the actual behavior, and for nontrivial changes ask the reviewer subagent to review the diff. Fix anything you find. If it is truly done, end with \`GOAL VERIFIED: <evidence>\`; otherwise keep working and report \`GOAL COMPLETE\` again when it is.`

type Kind = "start" | "continue" | "verify" | "stopped" | "finished" | "paused"
const kinds: ReadonlyArray<readonly [string, Kind]> = [
  [CONTINUE, "continue"],
  [VERIFY, "verify"],
  [STOPPED, "stopped"],
  [FINISHED, "finished"],
  [PAUSED, "paused"],
  [START, "start"],
]

const messageText = (message: SessionMessage.Info) =>
  message.type === "user" || message.type === "synthetic"
    ? message.text
    : message.type === "assistant"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      : ""

const controlKind = (message: SessionMessage.Info): Kind | undefined => {
  if (message.type !== "user" && message.type !== "synthetic") return undefined
  return kinds.find(([marker]) => message.text.startsWith(marker))?.[1]
}

export type Decision =
  | { readonly action: "none" }
  | { readonly action: "continue" | "verify"; readonly goal: string; readonly turn: number }
  | { readonly action: "pause"; readonly goal: string; readonly note: string }
  | { readonly action: "finish"; readonly note: string }

/** Pure: control messages in order. Esc pauses instead of killing the goal. */
const controlList = (messages: ReadonlyArray<SessionMessage.Info>) =>
  messages.flatMap((message, index) => {
    const kind = controlKind(message)
    return kind ? [{ kind, index, message }] : []
  })

const controlGoal = (message: SessionMessage.Info) =>
  /^Goal: (.*)$/m.exec(messageText(message))?.[1]?.trim()

/** Pure: resume a paused goal, or undefined when the transcript has none. */
export function resumeDecision(messages: ReadonlyArray<SessionMessage.Info>): { goal: string; turn: number } | undefined {
  const controls = controlList(messages)
  const last = controls.at(-1)
  if (!last || last.kind !== "paused") return undefined
  const goal = controlGoal(last.message)
  if (!goal) return undefined
  const start = controls.findLast((control) => control.kind === "start")?.index ?? -1
  const turn = controls.filter((control) => control.index > start && control.kind === "continue").length + 1
  return { goal, turn }
}

/** Pure: what to do when a session run ends, given its transcript. */
export function decide(messages: ReadonlyArray<SessionMessage.Info>): Decision {
  const controls = controlList(messages)
  const last = controls.at(-1)
  if (!last || last.kind === "stopped" || last.kind === "finished") return { action: "none" }
  const goal = controlGoal(last.message)
  if (!goal) return { action: "none" }
  const after = messages.slice(last.index + 1)
  // A paused goal restarts on user input after its last active control and
  // stays dormant otherwise, so answering a question never silently drops it,
  // and silence never silently resumes it. Anchoring on the active control
  // (not the pause note) also covers the race where the pause note lands
  // after a message typed during the interrupt.
  if (last.kind === "paused") {
    const anchor = controls.findLast((control) => control.kind === "start" || control.kind === "continue" || control.kind === "verify")?.index ?? -1
    if (!messages.slice(anchor + 1).some((message) => message.type === "user" && !controlKind(message))) return { action: "none" }
  }
  const reply = after.findLast((message) => message.type === "assistant")
  // Our own request is queued but its run has not produced a reply yet.
  if (!reply) return { action: "none" }
  const idle = after.findLast((message) => message.type === "idle")
  if (idle?.type === "idle" && idle.outcome === "interrupted") return { action: "pause", goal, note: "Goal paused: Esc stopped this turn. /goal resume to continue, /goal stop to end it." }
  if (idle?.type === "idle" && idle.outcome === "failed") return { action: "finish", note: "Goal stopped after an error. Fix it, then run /goal again." }
  const text = messageText(reply)
  const start = controls.findLast((control) => control.kind === "start")?.index ?? -1
  const since = controls.filter((control) => control.index > start)
  const continues = since.filter((control) => control.kind === "continue").length
  const verifies = since.filter((control) => control.kind === "verify").length
  if (/GOAL BLOCKED/.test(text)) return { action: "pause", goal, note: "Goal paused: the agent needs your input (see GOAL BLOCKED above). Answer it, then /goal resume." }
  if (/GOAL VERIFIED/.test(text) || (/GOAL COMPLETE/.test(text) && verifies >= MAX_VERIFICATIONS))
    return { action: "finish", note: "Goal finished: completed and verified." }
  if (/GOAL COMPLETE/.test(text)) return { action: "verify", goal, turn: verifies + 1 }
  if (continues >= MAX_CONTINUATIONS)
    return { action: "finish", note: `Goal paused after ${MAX_CONTINUATIONS} continuation turns without verified completion. Run /goal again to keep going.` }
  return { action: "continue", goal, turn: continues + 1 }
}

export type Hold = {
  readonly goal: string
  readonly turn: number
  /** The session's run count when the hold began; any later run decides for itself. */
  readonly generation: number
  /** Background signals up to this sequence number are already accounted for. */
  readonly cursor: number
  readonly deadline: number
  readonly work: ReadonlyArray<string>
  /** When the awaited work was first seen finished without the session waking up. */
  readonly settledAt?: number
}

export type HoldStep =
  | { readonly action: "drop" }
  | { readonly action: "wait"; readonly hold: Hold }
  | { readonly action: "resume"; readonly note: string }

const minutes = (ms: number) => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? "" : "s"}`

/** Pure: one tick of a held goal. */
export function holdStep(
  hold: Hold,
  input: {
    readonly now: number
    readonly generation: number
    readonly active: boolean
    readonly signals: ReadonlyArray<Background.Signal>
    readonly work: ReadonlyArray<string>
  },
): HoldStep {
  // A run started (the completion notice woke it, the user typed): its own end decides again.
  if (input.active || input.generation !== hold.generation) return { action: "drop" }
  const fresh = input.signals.filter((item) => item.seq > hold.cursor)
  const wake = fresh.filter((item) => item.kind === "wake")
  if (wake.length) return { action: "resume", note: `Resumed while background work runs: ${wake.map((item) => item.reason).join("; ")}.` }
  const cursor = fresh.at(-1)?.seq ?? hold.cursor
  // Progress (a step finished) proves the work is alive, so the no-progress clock starts over.
  const deadline = fresh.length ? Math.max(hold.deadline, input.now + HOLD_TIMEOUT_MS) : hold.deadline
  if (input.work.length === 0) {
    const settledAt = hold.settledAt ?? input.now
    if (input.now - settledAt >= HOLD_SETTLE_MS)
      return { action: "resume", note: "The background work you were waiting for has ended; its result is in this conversation (or ask the workflow tool for it)." }
    return { action: "wait", hold: { ...hold, cursor, deadline, settledAt } }
  }
  if (input.now >= deadline)
    return {
      action: "resume",
      note: `Background work is still running (${input.work.join(", ")}) and nothing changed for ${minutes(HOLD_TIMEOUT_MS)}. Check its status once: cancel it if it is stuck; otherwise work on something else or end your turn, and the goal keeps waiting for it.`,
    }
  return { action: "wait", hold: { ...hold, cursor, deadline, work: input.work, settledAt: undefined } }
}

export const Plugin = define({
  id: "infiniteoc.goal",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const jobs = yield* Job.Service
    const sessions = yield* SessionService.Service
    const scope = yield* Scope.Scope
    const busy = new Set<string>()
    // Per session: runs started so far, and the hold waiting for background work (one at most).
    const generations = new Map<string, number>()
    const holds = new Map<string, Hold>()
    const note = (sessionID: Session.ID, kind: string, text: string) =>
      ctx.session.synthetic({ sessionID, text: `${kind}\n${text}`, description: text, resume: false })

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "work until a goal is done and verified · /goal resume|stop",
        execute: (input) => {
          const goal = input.prompt.text.trim()
          if (/^(stop|off|cancel)$/i.test(goal)) {
            holds.delete(input.sessionID)
            return note(input.sessionID, STOPPED, "Goal stopped.").pipe(Effect.asVoid)
          }
          if (/^(resume|continue|retry)$/i.test(goal))
            return ctx.session.context({ sessionID: input.sessionID }).pipe(
              Effect.flatMap((messages) => {
                const resumed = resumeDecision(messages)
                if (!resumed)
                  return bus.publish(TuiEvent.ToastShow, {
                    title: "Goal",
                    message: "No paused goal to resume. Start one with /goal <what done means>.",
                    variant: "info",
                    duration: 6000,
                  })
                return ctx.session.synthetic({
                  sessionID: input.sessionID,
                  text: continueText(resumed.goal, resumed.turn),
                  description: `Goal: resume ${resumed.turn}/${MAX_CONTINUATIONS}`,
                  resume: true,
                })
              }),
              Effect.catchCause((cause) => Effect.logWarning("InfiniteOC goal resume failed", { cause })),
              Effect.asVoid,
            )
          if (!goal) return note(input.sessionID, STOPPED, "Usage: /goal <what done means>, /goal resume to continue a paused goal, and /goal stop to end it.").pipe(Effect.asVoid)
          return ctx.session
            .prompt({ ...input.prompt, sessionID: input.sessionID, text: startText(goal), delivery: input.delivery })
            .pipe(Effect.asVoid)
        },
      })
    })

    /** Labels of the background work this session started that is still running. */
    const backgroundWork = (sessionID: string) =>
      Effect.gen(function* () {
        const labels = Background.running(sessionID).map((work) => work.label)
        for (const item of yield* jobs.pendingBackground) {
          if (item.status !== "running" || item.recovery.kind !== "subagent" || item.recovery.parentSessionID !== sessionID) continue
          // The stored record can outlive the job (a crash); trust only a job that is running now.
          if ((yield* jobs.get(item.id))?.status === "running") labels.push(`background subagent "${item.recovery.description}"`)
        }
        return labels
      }).pipe(Effect.catchCause(() => Effect.succeed([] as string[])))

    const resumeHeld = (sessionID: Session.ID, hold: Hold, note: string) =>
      ctx.session.synthetic({
        sessionID,
        text: continueText(hold.goal, hold.turn, note),
        description: `Goal: continue ${hold.turn}/${MAX_CONTINUATIONS}`,
        resume: true,
      })

    const watchHold = (sessionID: Session.ID, initial: Hold) =>
      Effect.gen(function* () {
        let hold = initial
        while (holds.get(sessionID) === hold) {
          yield* Effect.sleep("2 seconds")
          if (holds.get(sessionID) !== hold) return
          const step = holdStep(hold, {
            now: Date.now(),
            generation: generations.get(sessionID) ?? 0,
            active: (yield* sessions.active).has(sessionID),
            signals: Background.since(sessionID, hold.cursor),
            work: yield* backgroundWork(sessionID),
          })
          if (holds.get(sessionID) !== hold) return
          if (step.action === "wait") {
            holds.set(sessionID, step.hold)
            hold = step.hold
            continue
          }
          holds.delete(sessionID)
          Background.forget(sessionID)
          if (step.action === "resume") yield* resumeHeld(sessionID, hold, step.note)
          return
        }
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("InfiniteOC goal hold failed", { sessionID, cause })))

    const startHold = (sessionID: Session.ID, decision: { goal: string; turn: number }, work: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const hold: Hold = {
          goal: decision.goal,
          turn: decision.turn,
          generation: generations.get(sessionID) ?? 0,
          cursor: Background.cursor(),
          deadline: Date.now() + HOLD_TIMEOUT_MS,
          work,
        }
        holds.set(sessionID, hold)
        yield* watchHold(sessionID, hold).pipe(Effect.forkIn(scope, { startImmediately: true }))
        yield* bus
          .publish(TuiEvent.ToastShow, {
            title: "Goal",
            message: `Waiting for ${work.join(", ")}; the goal continues when it finishes.`,
            variant: "info",
            duration: 5000,
          })
          .pipe(Effect.ignore)
      })

    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        if (event.type === "session.execution.started") {
          generations.set(event.data.sessionID, (generations.get(event.data.sessionID) ?? 0) + 1)
          holds.delete(event.data.sessionID)
          return Effect.void
        }
        // One terminal event per busy period. Shutdown resumes on restart and superseded runs are followed by another.
        if (event.type !== "session.execution.succeeded" && event.type !== "session.execution.failed" && event.type !== "session.execution.interrupted") return Effect.void
        if (event.type === "session.execution.interrupted" && (event.data.reason === "shutdown" || event.data.reason === "superseded")) return Effect.void
        const sessionID = event.data.sessionID
        if (busy.has(sessionID)) return Effect.void
        busy.add(sessionID)
        return ctx.session.context({ sessionID }).pipe(
          Effect.flatMap((messages) => {
            const decision = decide(messages)
            if (decision.action === "none") return Effect.void
            if (decision.action === "pause")
              // No toast: the transcript note and the footer carry the state.
              // Pausing is quiet by design; finishing and errors still toast.
              return note(sessionID, PAUSED, `${decision.note}\nGoal: ${decision.goal}`)
            if (decision.action === "finish")
              return bus
                .publish(TuiEvent.ToastShow, {
                  title: "Goal",
                  message: decision.note,
                  variant: decision.note.startsWith("Goal finished") ? "success" : "warning",
                  duration: 8000,
                })
                .pipe(Effect.andThen(note(sessionID, FINISHED, decision.note)))
            const text = decision.action === "verify" ? verifyText(decision.goal) : continueText(decision.goal, decision.turn)
            const description = decision.action === "verify" ? "Goal: verify completion" : `Goal: continue ${decision.turn}/${MAX_CONTINUATIONS}`
            const prompt = ctx.session.synthetic({ sessionID, text, description, resume: true })
            if (decision.action === "verify") return prompt
            // Nothing to do but wait for background work: hold instead of prompting a turn that would
            // only check on it again. Its completion notice wakes the session and the goal goes on.
            return backgroundWork(sessionID).pipe(
              Effect.flatMap((pending) => (pending.length ? startHold(sessionID, decision, pending) : prompt.pipe(Effect.asVoid))),
            )
          }),
          Effect.catchCause((cause) => Effect.logWarning("InfiniteOC goal check failed", { sessionID, cause })),
          Effect.ensuring(Effect.sync(() => busy.delete(sessionID))),
        )
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
