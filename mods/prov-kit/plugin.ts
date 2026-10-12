// InfiniteOC prov-kit server plugin: /budget, model routing, provider fallback, offline mode, Docker
// awareness and the free_port / env_diff tools. Written to packages/core/src/plugin/infiniteoc-prov.ts
// by mods/prov-kit next to infiniteoc-prov-lib.ts (the pure helpers; see lib.ts).
import { Message } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Model } from "@opencode/schema/model"
import type { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { TuiEvent } from "@opencode/schema/tui-event"
import { Effect, Stream } from "effect"
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import path from "node:path"
import { Bus } from "../bus.js"
import * as lib from "./infiniteoc-prov-lib.js"

// Cheap model: search and housekeeping agents. Strong model: agents that implement or judge changes.
const CHEAP = ["explore", "title", "summary"]
const STRONG = ["general", "reviewer"]
// Agents whose requests are not the user's work: no environment notes.
const QUIET = new Set(["title", "summary", "compaction"])
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]
const OFFLINE_NOTE =
  "The network appears to be offline. Do not use webfetch, websearch or package installs; work from local files and installed dependencies, and say so when a task needs the network."

const failure = (error: unknown) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) })

export const Plugin = define({
  id: "infiniteoc.prov",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const toast = (title: string, message: string, variant: "info" | "success" | "warning" | "error" = "info", duration = 6000) =>
      bus.publish(TuiEvent.ToastShow, { title, message, variant, duration }).pipe(Effect.asVoid)
    const directory = String(ctx.location.directory)

    // ---- budget ----
    // The limit lives in the transcript as a note, like /goal's state, so it survives restarts.
    const limits = new Map<string, number | null>()
    const limitOf = (sessionID: Session.ID) =>
      Effect.gen(function* () {
        const cached = limits.get(sessionID)
        if (cached !== undefined) return cached ?? undefined
        const limit = lib.budgetLimit(yield* ctx.session.context({ sessionID }))
        limits.set(sessionID, limit ?? null)
        return limit
      })
    // The nearest session (itself or a parent of a subagent session) with a limit, and what the chain spent.
    const budgetOf = (sessionID: Session.ID) =>
      Effect.gen(function* () {
        let spent = 0
        let id: Session.ID | undefined = sessionID
        for (let depth = 0; id && depth < 6; depth++) {
          const info: Session.Info = yield* ctx.session.get({ sessionID: id })
          spent += info.cost
          const limit = yield* limitOf(id)
          if (limit !== undefined) return { limit, spent }
          id = info.parentID
        }
        return undefined
      })
    const note = (sessionID: Session.ID, text: string) =>
      ctx.session.synthetic({ sessionID, text, description: text.split("\n")[2] ?? text.split("\n")[1] ?? "", resume: false }).pipe(Effect.asVoid)

    // ---- commands ----
    const routing = (text: string) =>
      Effect.gen(function* () {
        const [first, second] = text.split(/\s+/)
        const keys = lib.MODEL_KEYS as ReadonlyArray<string>
        const settings = lib.readSettings()
        if (!first) {
          const row = (key: lib.ModelKey) => `${key}: ${lib.configuredModel(settings, key) ?? "not set"}`
          return yield* toast("Model routing", [...lib.MODEL_KEYS.map(row), "Set with /routing <cheap|strong|fallback|local> <provider/model>, clear with /routing off <key>."].join("\n"), "info", 12000)
        }
        const off = first === "off" || first === "clear"
        const key = off ? second : first
        if (!keys.includes(key)) return yield* toast("Model routing", `Unknown key "${key ?? ""}". Use cheap, strong, fallback or local.`, "warning")
        if (!off) {
          if (!second || !lib.isModelRef(second)) return yield* toast("Model routing", `Use /routing ${key} <provider/model>.`, "warning")
          const known = yield* ctx.model.list().pipe(Effect.map((out) => out.data.some((item) => `${item.providerID}/${item.id}` === second.split("#")[0])), Effect.orElseSucceed(() => true))
          if (!known) return yield* toast("Model routing", `${second.split("#")[0]} is not an available model. Check /models.`, "warning")
        }
        yield* Effect.try({ try: () => lib.writeModelSetting(key as lib.ModelKey, off ? undefined : second), catch: (error) => error }).pipe(
          Effect.flatMap(() => ctx.agent.reload()),
          Effect.flatMap(() => toast("Model routing", off ? `${key} cleared.` : `${key} set to ${second}.`, "success")),
          Effect.catch((error) => toast("Model routing", error instanceof Error ? error.message : "Could not save the setting.", "error")),
        )
      })

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "budget",
        description: "per-session spending limit in dollars · /budget 5, /budget off",
        execute: (input) =>
          Effect.gen(function* () {
            const text = input.prompt.text.trim()
            if (!text) {
              const budget = yield* budgetOf(input.sessionID)
              const spent = (yield* ctx.session.get({ sessionID: input.sessionID })).cost
              return yield* toast("Budget", budget ? `${lib.money(budget.spent)} of ${lib.money(budget.limit)} spent` : `No limit set (${lib.money(spent)} spent). Use /budget <amount>.`)
            }
            const off = /^(off|none|clear)$/i.test(text)
            const limit = off ? undefined : lib.parseAmount(text)
            if (!off && limit === undefined) return yield* toast("Budget", "Use /budget <dollars> (for example /budget 5) or /budget off.", "warning")
            limits.set(input.sessionID, limit ?? null)
            yield* note(input.sessionID, lib.budgetNote(limit))
            yield* toast("Budget", limit === undefined ? "Limit removed." : `Limit ${lib.money(limit)} for this session. Tool calls stop and /goal pauses when it is reached.`, "success")
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("InfiniteOC /budget failed", { cause })))
      })
      editor.add({
        name: "routing",
        description: "cheap, strong, fallback and local models · /routing cheap provider/model",
        execute: (input) => routing(input.prompt.text.trim()).pipe(Effect.catchCause((cause) => Effect.logWarning("InfiniteOC /routing failed", { cause }))),
      })
    })

    // ---- model routing ----
    yield* ctx.agent.transform((editor) => {
      const settings = lib.readSettings()
      for (const [ids, key] of [[CHEAP, "cheap"], [STRONG, "strong"]] as const) {
        const ref = lib.configuredModel(settings, key)
        if (ref) for (const id of ids) editor.update(id, (agent) => { agent.model = Model.Ref.parse(ref) })
      }
    })

    // ---- tools ----
    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "free_port",
        options: { codemode: false },
        description: "Returns a TCP port that is free on this machine right now. Use it for every dev server or listener you start (pass it as PORT or --port) instead of assuming 3000 or 8080, and tell the user the URL.",
        input: { type: "object", properties: {} },
        execute: () =>
          Effect.tryPromise({ try: () => lib.freePort(), catch: failure }).pipe(
            Effect.map((port) => ({ content: `Free port: ${port}. Start the server with PORT=${port} (or --port ${port}) and report http://localhost:${port}.` })),
          ),
      })
      editor.add({
        name: "env_diff",
        options: { codemode: false },
        description: "Compares the project's .env.example (or .env.sample/.env.template) with .env and reports missing, empty and extra variable NAMES. It never returns values; use it instead of reading .env.",
        input: {
          type: "object",
          properties: {
            example: { type: "string", description: "Template file, relative to the project (default .env.example)" },
            env: { type: "string", description: "Env file, relative to the project (default .env)" },
          },
        },
        execute: (raw: unknown) =>
          Effect.try({
            try: () => {
              const input = raw as { example?: string; env?: string }
              const pick = (names: string[], given?: string) => {
                const candidates = given ? [given] : names
                const file = candidates.find((name) => existsSync(path.resolve(directory, name)))
                const resolved = path.resolve(directory, file ?? candidates[0])
                // Only dotenv-style files inside the project; the output is names, but the input must still be one of them.
                if (path.relative(directory, resolved).startsWith("..") || !path.basename(resolved).startsWith(".env")) throw new Error(`${given} is not an .env file inside the project`)
                return { name: path.relative(directory, resolved), resolved }
              }
              const example = pick([".env.example", ".env.sample", ".env.template"], input?.example)
              const env = pick([".env", ".env.local"], input?.env)
              if (!existsSync(example.resolved)) throw new Error(`No ${example.name} in the project`)
              if (!existsSync(env.resolved)) return { content: `${env.name} does not exist; every key in ${example.name} is missing: ${[...lib.envKeys(readFileSync(example.resolved, "utf8")).keys()].join(", ")}` }
              return { content: lib.formatEnvDiff(lib.envDiff(readFileSync(example.resolved, "utf8"), readFileSync(env.resolved, "utf8")), { example: example.name, env: env.name }) }
            },
            catch: failure,
          }),
      })
    })

    // ---- budget enforcement: refuse tool calls at the limit and pause the run ----
    // A model that ignores the refusal would otherwise keep paying for turns, so the run is interrupted too.
    const paused = new Set<string>()
    yield* ctx.tool.hook("execute.before", (event) =>
      budgetOf(event.sessionID).pipe(
        // Fail open: an unreadable transcript must not block work.
        Effect.catchCause((cause) => Effect.logWarning("InfiniteOC budget check failed", { cause }).pipe(Effect.as(undefined))),
        Effect.flatMap((budget) => {
          if (!budget || !lib.overBudget(budget.limit, budget.spent)) return Effect.void
          const pause = paused.has(event.sessionID)
            ? Effect.void
            : Effect.sync(() => {
                paused.add(event.sessionID)
                // After the refusal is returned; resume: false keeps queued input from starting a new run.
                Effect.runFork(Effect.sleep("200 millis").pipe(Effect.andThen(ctx.session.interrupt({ sessionID: event.sessionID, resume: false })), Effect.ignore))
              }).pipe(Effect.andThen(toast("Budget", `${lib.money(budget.spent)} of ${lib.money(budget.limit)} spent: run paused. Raise it with /budget <amount>.`, "warning", 10000)))
          return pause.pipe(Effect.andThen(Effect.fail(new Tool.Error({ message: lib.budgetRefusal(budget.limit, budget.spent) }))))
        }),
      ),
    )

    // ---- model switches that end with the run: fallback and offline ----
    const switched = new Map<string, Model.Ref>()
    const switchTo = (sessionID: Session.ID, from: Model.Ref, to: string) =>
      Effect.gen(function* () {
        const target = Model.Ref.parse(to)
        if (`${from.providerID}/${from.id}` === `${target.providerID}/${target.id}`) return false
        if (!switched.has(sessionID)) switched.set(sessionID, from)
        yield* ctx.session.switchModel({ sessionID, model: target })
        return true
      })

    yield* ctx.session.hook("retry", (event) =>
      Effect.gen(function* () {
        const backup = lib.configuredModel(lib.readSettings(), "fallback")
        if (!backup || !event.decision.retry || !lib.failsOver(event.error)) return
        // The run reloads the session's model before each retry, so the switch applies to the next attempt.
        if (yield* switchTo(event.sessionID, event.model, backup)) {
          event.decision = { retry: true, delay: 500 }
          yield* toast("Fallback", `${event.model.providerID}/${event.model.id} failed (${event.error.status ?? event.error.type}); retrying on ${backup} for this run.`, "warning", 8000)
        }
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("InfiniteOC fallback failed", { cause }))),
    )

    // Offline with a local model configured: this run uses it.
    yield* ctx.session.hook("prompt", (event) =>
      Effect.gen(function* () {
        const local = lib.configuredModel(lib.readSettings(), "local")
        if (!local || !lib.offline(networkInterfaces())) return
        const info = yield* ctx.session.get({ sessionID: event.sessionID })
        const current = info.model ?? (yield* ctx.model.default()).data
        if (current && (yield* switchTo(event.sessionID, current, local))) yield* toast("Offline", `No network: using the local model ${local} for this run.`, "info", 8000)
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("InfiniteOC offline model failed", { cause }))),
    )

    // ---- environment notes ----
    let docker: { at: number; text?: string } | undefined
    const dockerNote = () =>
      Effect.promise(
        () =>
          new Promise<string | undefined>((resolve) => {
            if (docker && Date.now() - docker.at < 30_000) return resolve(docker.text)
            const done = (text?: string) => resolve((docker = { at: Date.now(), text }).text)
            if (!COMPOSE_FILES.some((name) => existsSync(path.join(directory, name)))) return done()
            execFile("docker", ["compose", "ps", "--format", "json"], { cwd: directory, timeout: 4000 }, (error, stdout) => done(error ? undefined : lib.dockerNote(lib.composeServices(stdout))))
          }),
      )

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        if (QUIET.has(event.agent)) return
        const notes = [...(lib.offline(networkInterfaces()) ? [OFFLINE_NOTE] : []), ...[yield* dockerNote()].filter((text): text is string => !!text)]
        if (!notes.length) return
        const last = event.messages.findLastIndex((message) => message.role === "user")
        event.messages.splice(last === -1 ? event.messages.length : last, 0, Message.user(`[InfiniteOC environment]\n${notes.join("\n")}`))
      }),
    )

    // ---- run end: pause /goal at the budget, undo temporary model switches ----
    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        if (event.type !== "session.execution.succeeded" && event.type !== "session.execution.failed" && event.type !== "session.execution.interrupted") return Effect.void
        if (event.type === "session.execution.interrupted" && (event.data.reason === "shutdown" || event.data.reason === "superseded")) return Effect.void
        const sessionID = event.data.sessionID
        return Effect.gen(function* () {
          paused.delete(sessionID)
          const original = switched.get(sessionID)
          if (original) {
            switched.delete(sessionID)
            yield* ctx.session.switchModel({ sessionID, model: original })
          }
          const limit = yield* limitOf(sessionID)
          if (limit === undefined) return
          const spent = (yield* ctx.session.get({ sessionID })).cost
          if (!lib.overBudget(limit, spent) || !lib.goalActive(yield* ctx.session.context({ sessionID }))) return
          yield* toast("Budget", `${lib.money(spent)} of ${lib.money(limit)} spent: /goal paused. Raise it with /budget <amount>.`, "warning", 10000)
          yield* note(sessionID, lib.stopGoalNote(limit, spent))
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("InfiniteOC run-end check failed", { sessionID, cause })))
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
