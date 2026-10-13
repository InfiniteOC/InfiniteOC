// InfiniteOC /goal: keep working until the goal is done and verified.
// Written to packages/core/src/plugin/infiniteoc-goal.ts by mods/infiniteoc.
// State lives in the transcript (control messages starting with "[InfiniteOC goal"), so it
// needs no storage and a restarted server picks it up again. Notes posted with resume: false wait in
// the inbox and land before the user's next message, so a toast announces the end right away.
import { define } from "@opencode/plugin/effect/plugin"
import { TuiEvent } from "@opencode/schema/tui-event"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { Session } from "@opencode/schema/session"
import { Effect, Stream } from "effect"
import { Bus } from "../bus.js"

export const MAX_CONTINUATIONS = 20
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
].join("\n")

export const startText = (goal: string) => `${START}\nGoal: ${goal}\n\n${protocol}`

export const continueText = (goal: string, turn: number) =>
  `${CONTINUE}\nGoal: ${goal}\n\nContinuation ${turn} of ${MAX_CONTINUATIONS}. The goal is not marked complete yet. Keep going: pick the next concrete step, do it, and check the result. ${protocol}`

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
  // A paused goal restarts on the user's next message and stays dormant
  // otherwise, so answering a question never silently drops it, and silence
  // never silently resumes it.
  if (last.kind === "paused" && !after.some((message) => message.type === "user" && !controlKind(message))) return { action: "none" }
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

export const Plugin = define({
  id: "infiniteoc.goal",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const busy = new Set<string>()
    const note = (sessionID: Session.ID, kind: string, text: string) =>
      ctx.session.synthetic({ sessionID, text: `${kind}\n${text}`, description: text, resume: false })

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "work until a goal is done and verified · /goal resume|stop",
        execute: (input) => {
          const goal = input.prompt.text.trim()
          if (/^(stop|off|cancel)$/i.test(goal)) return note(input.sessionID, STOPPED, "Goal stopped.").pipe(Effect.asVoid)
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

    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
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
              return bus
                .publish(TuiEvent.ToastShow, {
                  title: "Goal paused",
                  message: `${decision.note} The goal stays resumable; nothing was discarded.`,
                  variant: "warning",
                  duration: 8000,
                })
                .pipe(Effect.andThen(note(sessionID, PAUSED, `${decision.note}\nGoal: ${decision.goal}`)))
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
            return ctx.session.synthetic({ sessionID, text, description, resume: true })
          }),
          Effect.catchCause((cause) => Effect.logWarning("InfiniteOC goal check failed", { sessionID, cause })),
          Effect.ensuring(Effect.sync(() => busy.delete(sessionID))),
        )
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
