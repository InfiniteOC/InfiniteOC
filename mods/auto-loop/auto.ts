// InfiniteOC autonomy: the agent-loop features around a session run.
// Written to packages/core/src/plugin/infiniteoc-auto.ts by mods/auto-loop.
//   at the end of a run: auto-verify, self-critique, second-opinion review, model escalation, queue
//   around tool calls:  stuck detection, plan-approval and ask-first gates
//   before a request:   persona and ask-first instructions
//   commands:           /loop /queue /timebox /plan /askfirst /why /macro /auto
// Pure decisions live in infiniteoc-auto-logic.ts (tested); files and processes in infiniteoc-auto-project.ts.
import { Message } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Model } from "@opencode/schema/model"
import type { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { TuiEvent } from "@opencode/schema/tui-event"
import { Effect, Stream } from "effect"
import path from "path"
import { Bus } from "../bus.js"
import { decide as goalDecide } from "./infiniteoc-goal.js"
import * as L from "./infiniteoc-auto-logic.js"
import { changeSetting, gitDiff, projectCheck, readMacros, readSettings, runCommand, writeMacros } from "./infiniteoc-auto-project.js"

// Marks prompts this plugin sends, so macro recording does not capture its own replays.
const AUTO = { infiniteocAuto: true }
const SKIP = new Set(["explore", "researcher", "reviewer", "general", "title", "compaction", "summary"])

type Variant = "info" | "success" | "warning" | "error"

export const Plugin = define({
  id: "infiniteoc.auto",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const busy = new Set<string>()
    const queues = new Map<string, string[]>()
    const loops = new Map<string, { ms: number; prompt: string; next: number }>()
    const boxes = new Map<string, { until: number; label: string }>()
    const recording = new Map<string, { name: string; prompts: string[] }>()
    const stuck = new Map<string, { counts: Map<string, number>; blocked: Set<string>; tripped: boolean }>()
    const wrapped = new Set<string>()
    const passedAt = new Map<string, number>()
    const settled = new Map<string, string>()
    const working = new Set<string>()

    const toast = (message: string, variant: Variant = "info", title = "Autonomy") =>
      bus.publish(TuiEvent.ToastShow, { title, message, variant, duration: 6000 }).pipe(Effect.asVoid)
    const warn = (what: string, sessionID?: string) => (cause: unknown) => Effect.logWarning(`InfiniteOC autonomy: ${what} failed`, { sessionID, cause })
    // A new user turn. "queue" delivery runs after whatever is in flight instead of cutting in.
    const send = (sessionID: Session.ID, text: string, delivery: "queue" | "steer" = "queue") => {
      busy.add(sessionID)
      return ctx.session.prompt({ sessionID, text, delivery, metadata: AUTO }).pipe(
        Effect.asVoid,
        Effect.tapCause(() => Effect.sync(() => busy.delete(sessionID))),
      )
    }
    const nudge = (sessionID: Session.ID, text: string, description: string) => {
      busy.add(sessionID)
      return ctx.session.synthetic({ sessionID, text, description, resume: true }).pipe(Effect.asVoid)
    }
    const note = (sessionID: Session.ID, text: string, description: string) =>
      ctx.session.synthetic({ sessionID, text, description, resume: false }).pipe(Effect.asVoid)
    const directory = (session: Session.Info) => path.join(session.location.directory, session.subpath ?? "")

    const pump = (sessionID: Session.ID) => {
      const queue = queues.get(sessionID)
      const next = queue?.shift()
      if (next === undefined) return Effect.void
      return toast(`Running the next queued prompt (${queue!.length} left): ${next.slice(0, 80)}`).pipe(Effect.andThen(send(sessionID, next)))
    }

    // ---- end of a run ------------------------------------------------------------------------------

    /** Verify, critique, second opinion and escalation, in that order. True when a follow-up turn was started. */
    const afterRun = (session: Session.Info, messages: ReadonlyArray<any>) =>
      Effect.gen(function* () {
        const sessionID = session.id
        const settings = readSettings()
        const cwd = directory(session)
        const start = L.turnStart(messages)
        const edited = L.editedFiles(messages, start).length > 0
        const model = L.refString(messages.findLast((message) => message.type === "assistant")?.model)
        const tripped = stuck.get(sessionID)?.tripped ?? false

        const escalate = (why: string) =>
          Effect.gen(function* () {
            if (!settings.escalateModel || !model || L.escalatedFrom(messages)) return
            yield* ctx.session.switchModel({ sessionID, model: Model.Ref.parse(settings.escalateModel) })
            yield* note(sessionID, L.escalatedText(model, settings.escalateModel, why), `Escalated to ${settings.escalateModel}`)
            yield* toast(`${why}. Switched to ${settings.escalateModel} for the fix-up; it drops back once the work passes.`, "warning", "Escalating model")
          }).pipe(Effect.catchCause(warn("model escalation", sessionID)))

        if (settings.verify && edited) {
          const plan = L.verifyPlan(messages, settings.verifyRetries, passedAt.get(sessionID))
          const command = settings.verifyCommand || projectCheck(cwd)
          if (plan.run && command) {
            const result = yield* Effect.promise(() => runCommand(command, cwd, settings.verifyTimeout * 1000))
            if (result.code === 0) {
              passedAt.set(sessionID, messages.length)
              yield* toast(`Checks passed: ${command}`, "success", "Auto-verify")
            } else {
              const attempt = plan.attempt + 1
              const output = result.timedOut ? `(timed out after ${settings.verifyTimeout}s)\n${result.output}` : result.output
              if (attempt >= 2 || tripped) yield* escalate(attempt >= 2 ? `The check failed ${attempt} times` : "The agent got stuck")
              yield* toast(`${command} failed; asking the agent to fix it (${attempt}/${settings.verifyRetries}).`, "warning", "Auto-verify")
              yield* nudge(sessionID, L.verifyFailText(command, output, attempt, settings.verifyRetries), `Auto-verify: fix ${attempt}/${settings.verifyRetries}`)
              return true
            }
          }
        }

        if (tripped && settings.escalateModel && !L.escalatedFrom(messages)) {
          yield* escalate("The agent got stuck repeating a failing call")
          yield* nudge(sessionID, `${L.MARK.escalated.slice(0, -1)}: continue]\nYour last attempt got stuck repeating a failing call, so you are now on a stronger model. Re-read the error, take a different approach and continue the original task.`, "Stuck: continue on a stronger model")
          return true
        }

        const turn = messages[start]?.id as string | undefined
        const done = turn !== undefined && settled.get(sessionID) === turn
        if (edited && !done) {
          if (settings.critique && !messages.slice(start + 1).some((message) => message.type === "synthetic" && message.text.startsWith(L.MARK.critique))) {
            yield* nudge(sessionID, L.critiqueText, "Self-critique before done")
            return true
          }
          if (settings.reviewerModel && !messages.slice(start + 1).some((message) => message.type === "synthetic" && message.text.startsWith(L.MARK.review))) {
            const diff = yield* Effect.promise(() => gitDiff(cwd))
            if (diff) {
              const request = L.textOf(messages[start]).slice(0, 3000)
              const reply = yield* ctx.generate.text({ prompt: L.reviewPrompt(request, diff), model: Model.Ref.parse(settings.reviewerModel) }).pipe(
                Effect.map((result) => result.text),
                Effect.catchCause((cause) => warn("second-opinion review", sessionID)(cause).pipe(Effect.as(""))),
              )
              if (reply && !L.reviewClean(reply)) {
                yield* toast(`${settings.reviewerModel} found issues in the diff; asking the agent to check them.`, "warning", "Second opinion")
                yield* nudge(sessionID, L.reviewText(settings.reviewerModel, reply), "Second-opinion review")
                return true
              }
              if (reply) yield* toast(`${settings.reviewerModel} found no defects in the diff.`, "success", "Second opinion")
            }
          }
          if (turn !== undefined) settled.set(sessionID, turn)
        }

        // Drop back to the original model once the work is passing again.
        const from = L.escalatedFrom(messages)
        if (from && !tripped) {
          yield* ctx.session.switchModel({ sessionID, model: Model.Ref.parse(from) }).pipe(Effect.catchCause(warn("model restore", sessionID)))
          yield* note(sessionID, L.restoredText(from), `Model restored to ${from}`)
          yield* toast(`Back on ${from}.`, "info", "Model restored")
        }
        return false
      })

    const onRunEnd = (event: { type: string; data: { sessionID: Session.ID; reason?: string } }) => {
      const sessionID = event.data.sessionID
      busy.delete(sessionID)
      if (event.type === "session.execution.interrupted" && (event.data.reason === "shutdown" || event.data.reason === "superseded")) return Effect.void
      if (working.has(sessionID)) return Effect.void
      working.add(sessionID)
      return Effect.gen(function* () {
        if (wrapped.delete(sessionID)) return
        if (event.type !== "session.execution.succeeded") return
        const session = yield* ctx.session.get({ sessionID })
        if (session.parentID) return
        const messages = yield* ctx.session.context({ sessionID })
        // A goal that will prompt again owns the next turn.
        const goal = goalDecide(messages).action
        if (goal === "continue" || goal === "verify") return
        if (yield* afterRun(session, messages)) return
        yield* pump(sessionID)
      }).pipe(
        Effect.catchCause(warn("end-of-run checks", sessionID)),
        Effect.ensuring(Effect.sync(() => (working.delete(sessionID), stuck.delete(sessionID)))),
      )
    }

    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        if (event.type === "session.execution.started") return Effect.sync(() => void busy.add(event.data.sessionID))
        if (event.type !== "session.execution.succeeded" && event.type !== "session.execution.failed" && event.type !== "session.execution.interrupted") return Effect.void
        return onRunEnd(event as any)
      }),
      Effect.forkScoped({ startImmediately: true }),
    )

    // ---- timers: /loop and /timebox ----------------------------------------------------------------

    const expire = (sessionID: Session.ID, label: string) =>
      Effect.gen(function* () {
        loops.delete(sessionID)
        queues.delete(sessionID)
        if (!busy.has(sessionID)) return yield* toast(`The ${label} timebox ended; the agent was idle. Loop and queue for this session were cleared.`, "warning", "Timebox")
        const messages = yield* ctx.session.context({ sessionID })
        if (L.goalActive(messages)) yield* note(sessionID, "[InfiniteOC goal: stopped]\nGoal stopped: the timebox ended.", "Goal stopped: timebox ended")
        wrapped.add(sessionID)
        yield* toast(`The ${label} timebox is up; the agent is wrapping up.`, "warning", "Timebox")
        yield* ctx.session.prompt({ sessionID, text: L.timeboxText(label), delivery: "steer", metadata: AUTO })
      }).pipe(Effect.catchCause(warn("timebox", sessionID)))

    const tick = Effect.gen(function* () {
      const now = Date.now()
      for (const [sessionID, box] of [...boxes]) {
        if (now < box.until) continue
        boxes.delete(sessionID)
        yield* expire(sessionID as Session.ID, box.label)
      }
      for (const [sessionID, loop] of [...loops]) {
        if (now < loop.next || busy.has(sessionID) || queues.get(sessionID)?.length) continue
        loop.next = now + loop.ms
        yield* send(sessionID as Session.ID, loop.prompt).pipe(
          Effect.catchCause((cause) => (loops.delete(sessionID), warn("loop", sessionID)(cause))),
        )
      }
    })
    yield* Effect.sleep(1000).pipe(Effect.andThen(tick), Effect.forever, Effect.forkScoped({ startImmediately: true }))

    // ---- gates around tool calls -------------------------------------------------------------------

    // Whether the request last built for a session could contain a plan or ask-first marker. Without
    // one neither gate can refuse, so an edit skips loading the whole transcript (slow in long sessions).
    const gated = new Map<string, boolean>()
    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        const state = stuck.get(event.sessionID)
        if (state && readSettings().stuck && state.blocked.has(L.callKey(event.tool, event.input)))
          return yield* Effect.fail(new Tool.Error({ message: L.stuckRefusal(event.tool) }))
        const files = L.targets(event.tool, event.input)
        if (files.length === 0 || gated.get(event.sessionID) === false) return
        const messages = yield* ctx.session.context({ sessionID: event.sessionID }).pipe(
          // Fail open: an unreadable transcript must not block editing.
          Effect.catchCause((cause) => warn("gate check", event.sessionID)(cause).pipe(Effect.as([] as ReadonlyArray<any>))),
        )
        if (L.planState(messages) === "planning") return yield* Effect.fail(new Tool.Error({ message: L.planRefusal }))
        if (L.askFirstOn(messages) && L.askFirstGate(messages, files)) return yield* Effect.fail(new Tool.Error({ message: L.askFirstRefusal }))
      }),
    )

    yield* ctx.tool.hook("execute.after", (event) => {
      if (!readSettings().stuck) return Effect.void
      const exit = event.status === "completed" ? event.result.metadata?.exit : undefined
      const failed = event.status === "error" || (event.tool === "shell" && typeof exit === "number" && exit !== 0)
      const output = event.status === "error" ? event.error.message : JSON.stringify(event.result.content ?? "")
      const state = stuck.get(event.sessionID) ?? { counts: new Map(), blocked: new Set<string>(), tripped: false }
      stuck.set(event.sessionID, state)
      const key = L.callKey(event.tool, event.input)
      const count = L.bump(state.counts, `${key}\n${output.slice(-300)}`, failed)
      if (!failed || count < L.STUCK_AT) return Effect.void
      state.blocked.add(key)
      state.tripped = true
      const text = L.stuckNote(event.tool)
      if (event.status === "error") {
        event.error = new Tool.Error({ message: `${event.error.message}\n\n${text}`, error: event.error.error, metadata: event.error.metadata })
      } else {
        const content = event.result.content
        event.result = { ...event.result, content: [...(typeof content === "string" ? [{ type: "text" as const, text: content }] : (content ?? [])), { type: "text" as const, text }] }
      }
      return toast(`The agent repeated the same failing ${event.tool} call ${L.STUCK_AT} times. Told it to change approach or ask.`, "warning", "Stuck detection")
    })

    // ---- instructions before a request -------------------------------------------------------------

    yield* ctx.session.hook("context", (event) => {
      gated.set(
        event.sessionID,
        event.messages.some((message) => message.role === "user" && message.content.some((part) => part.type === "text" && (part.text.includes(L.MARK.plan) || part.text.includes(L.MARK.askOn)))),
      )
      if (SKIP.has(event.agent)) return Effect.void
      const settings = readSettings()
      const transcript = event.messages.map((message) => ({
        type: message.role === "user" ? "user" : "other",
        text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      }))
      const blocks = [settings.persona && L.personas[settings.persona], L.askFirstOn(transcript) && L.askFirstBlock].filter((block): block is string => !!block)
      if (blocks.length === 0) return Effect.void
      const last = event.messages.findLastIndex((message) => message.role === "user")
      event.messages.splice(last === -1 ? event.messages.length : last, 0, Message.user(blocks.join("\n\n")))
      return Effect.void
    })

    // Macro recording: user prompts typed while recording, in order.
    yield* ctx.session.hook("prompt", (event) => {
      const recorder = recording.get(event.sessionID)
      const text = event.prompt.text.trim()
      if (recorder && text && !event.metadata?.infiniteocAuto && !text.startsWith("[InfiniteOC")) recorder.prompts.push(text)
      return Effect.void
    })

    // ---- commands ----------------------------------------------------------------------------------

    yield* ctx.command.transform((editor) => {
      const add = (name: string, description: string, run: (sessionID: Session.ID, args: string, input: any) => Effect.Effect<void, unknown>) =>
        editor.add({ name, description, execute: (input) => run(input.sessionID, input.prompt.text.trim(), input) })

      add("loop", "re-run a prompt on a schedule: /loop 5m <prompt> · /loop stop", (sessionID, args) => {
        const command = L.parseLoop(args)
        if (command.action === "error") return toast(command.message, "warning", "Loop")
        if (command.action === "stop") return toast(loops.delete(sessionID) ? "Loop stopped." : "No loop is running in this session.", "info", "Loop")
        if (command.action === "status") {
          const loop = loops.get(sessionID)
          return toast(loop ? `Every ${L.formatDuration(loop.ms)}: ${loop.prompt}. Next in ${L.formatDuration(Math.max(0, loop.next - Date.now()))}. /loop stop to end.` : "No loop. Start one with /loop 5m <prompt>.", "info", "Loop")
        }
        loops.set(sessionID, { ms: command.ms, prompt: command.prompt, next: Date.now() + command.ms })
        return toast(`Running now, then every ${L.formatDuration(command.ms)}: ${command.prompt}. /loop stop to end.`, "success", "Loop").pipe(Effect.andThen(send(sessionID, command.prompt)))
      })

      add("queue", "queue prompts that run one after another: /queue <prompt> · list · clear", (sessionID, args) => {
        const queue = queues.get(sessionID) ?? []
        if (!args || /^list$/i.test(args))
          return toast(queue.length ? queue.map((item, index) => `${index + 1}. ${item.slice(0, 100)}`).join("\n") : "The queue is empty. Add with /queue <prompt>.", "info", "Queue")
        if (/^clear$/i.test(args)) {
          queues.delete(sessionID)
          return toast(`Cleared ${queue.length} queued prompt${queue.length === 1 ? "" : "s"}.`, "info", "Queue")
        }
        queue.push(args)
        queues.set(sessionID, queue)
        // Idle: start now. Busy: it runs when the current run (and any goal) is done.
        if (!busy.has(sessionID)) return pump(sessionID)
        return toast(`Queued (${queue.length} waiting). It runs after the current work.`, "success", "Queue")
      })

      add("timebox", "wrap up and summarize after a time: /timebox 30m · /timebox stop", (sessionID, args) => {
        if (!args) {
          const box = boxes.get(sessionID)
          return toast(box ? `${L.formatDuration(Math.max(0, box.until - Date.now()))} left of the ${box.label} timebox.` : "No timebox. Start one with /timebox 30m.", "info", "Timebox")
        }
        if (/^(stop|off|cancel|clear)$/i.test(args)) return toast(boxes.delete(sessionID) ? "Timebox cancelled." : "No timebox is running.", "info", "Timebox")
        const ms = L.parseDuration(args)
        if (!ms || ms < 10_000) return toast("Usage: /timebox <duration>, at least 10s (for example 45m or 1h30m). /timebox stop cancels.", "warning", "Timebox")
        boxes.set(sessionID, { until: Date.now() + ms, label: L.formatDuration(ms) })
        return toast(`In ${L.formatDuration(ms)} the agent stops starting work and summarizes. The loop and queue for this session end then too.`, "success", "Timebox")
      })

      add("plan", "plan first, approve or edit, then execute with a checklist: /plan <task>", (sessionID, args, input) => {
        if (!args) return toast("Usage: /plan <task>. The agent writes a checklist and asks you to approve before it edits anything.", "warning", "Plan")
        return note(sessionID, L.planText(args), `Plan mode: ${args}`).pipe(
          // The marker is in the history now: the next edit of a step already running must look.
          Effect.tap(() => Effect.sync(() => gated.delete(sessionID))),
          Effect.andThen(ctx.session.prompt({ ...input.prompt, sessionID, text: args, delivery: input.delivery }).pipe(Effect.asVoid)),
        )
      })

      add("askfirst", "ask one clarifying question before multi-file changes: /askfirst on|off", (sessionID, args) =>
        Effect.gen(function* () {
          const messages = yield* ctx.session.context({ sessionID })
          const current = L.askFirstOn(messages)
          if (/^status$/i.test(args)) return yield* toast(`Ask-first is ${current ? "on" : "off"}.`, "info", "Ask first")
          const want = /^(on|true)$/i.test(args) ? true : /^(off|false)$/i.test(args) ? false : !current
          yield* note(sessionID, want ? L.MARK.askOn : L.MARK.askOff, `Ask-first mode ${want ? "on" : "off"}`)
          gated.delete(sessionID)
          yield* toast(want ? "Ask-first is on: the agent asks one question before changing more than one file." : "Ask-first is off.", "info", "Ask first")
        }),
      )

      add("why", "the agent explains its last action and the evidence", (sessionID, args, input) =>
        ctx.session.prompt({ ...input.prompt, sessionID, text: L.whyText(args), delivery: input.delivery }).pipe(Effect.asVoid),
      )

      add("macro", "record and replay prompts: /macro record <name> · stop · run <name> · list · delete <name>", (sessionID, args) => {
        const [verb = "", name = ""] = args.split(/\s+/)
        const macros = readMacros()
        const valid = /^[\w-]{1,40}$/.test(name)
        if (/^record$/i.test(verb)) {
          if (!valid) return toast("Usage: /macro record <name> (letters, digits, - and _).", "warning", "Macro")
          recording.set(sessionID, { name, prompts: [] })
          return toast(`Recording "${name}". Your next prompts are captured; /macro stop saves it. Slash commands are not captured.`, "success", "Macro")
        }
        if (/^stop$/i.test(verb)) {
          const recorder = recording.get(sessionID)
          if (!recorder) return toast("Not recording. Start with /macro record <name>.", "info", "Macro")
          recording.delete(sessionID)
          if (recorder.prompts.length === 0) return toast("Nothing was recorded; the macro was not saved.", "warning", "Macro")
          return Effect.try(() => writeMacros({ ...macros, [recorder.name]: recorder.prompts })).pipe(
            Effect.andThen(toast(`Saved "${recorder.name}" with ${recorder.prompts.length} prompt${recorder.prompts.length === 1 ? "" : "s"}. Replay with /macro run ${recorder.name}.`, "success", "Macro")),
            Effect.catchCause((cause) => toast("Could not save the macro file.", "error", "Macro").pipe(Effect.andThen(warn("macro save", sessionID)(cause)))),
          )
        }
        if (/^run$/i.test(verb)) {
          const prompts = valid ? macros[name] : undefined
          if (!prompts) return toast(`No macro "${name}". /macro list shows them.`, "warning", "Macro")
          const queue = queues.get(sessionID) ?? []
          queue.push(...prompts)
          queues.set(sessionID, queue)
          return toast(`Replaying "${name}": ${prompts.length} prompt${prompts.length === 1 ? "" : "s"}, one after another.`, "success", "Macro").pipe(Effect.andThen(busy.has(sessionID) ? Effect.void : pump(sessionID)))
        }
        if (/^delete$/i.test(verb)) {
          if (!valid || !macros[name]) return toast(`No macro "${name}".`, "warning", "Macro")
          const { [name]: _gone, ...left } = macros
          return Effect.try(() => writeMacros(left)).pipe(Effect.andThen(toast(`Deleted "${name}".`, "info", "Macro")), Effect.catchCause(warn("macro delete", sessionID)))
        }
        if (!verb || /^list$/i.test(verb)) {
          const names = Object.entries(macros).map(([key, prompts]) => `${key} (${prompts.length})`)
          return toast(names.length ? names.join(", ") : "No macros yet. /macro record <name> starts one.", "info", "Macro")
        }
        return toast("Usage: /macro record <name> · stop · run <name> · list · delete <name>", "warning", "Macro")
      })

      add("auto", "autonomy settings: /auto [verify|verifycmd|retries|stuck|critique|reviewer|escalate|persona] <value>", (_sessionID, args) => {
        if (!args) return toast(L.describeSettings(readSettings()), "info", "Autonomy settings")
        const [key, ...value] = args.split(/\s+/)
        return Effect.try(() => changeSetting(key, value.join(" ").trim())).pipe(
          Effect.flatMap((result) => ("error" in result ? toast(result.error, "warning", "Autonomy settings") : toast(L.describeSettings(result.settings), "success", "Autonomy settings"))),
          Effect.catchCause((cause) => toast("Could not write the settings file.", "error", "Autonomy settings").pipe(Effect.andThen(warn("settings write")(cause)))),
        )
      })
    })
  }),
})
