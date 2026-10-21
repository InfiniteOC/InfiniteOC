// InfiniteOC: Claude Code in the model picker (claude-code/haiku, sonnet, opus), when `claude` is on PATH.
// Within Anthropic's terms: each turn runs the user's own installed and logged-in Claude Code CLI as
// itself, with its own system prompt, tools and login. InfiniteOC never reads Claude Code's credentials,
// never calls the Anthropic API, and passes neither its system prompt nor its tools; it shows Claude
// Code's replies and tool calls (provider-executed, never run here). workflows.claudeMode (/fleet claude)
// sets what Claude Code may do, as for workflow steps. Written to
// packages/core/src/plugin/infiniteoc-claude-code.ts by mods/workflows.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Option } from "effect"
import { Location } from "../location.js"
import { Model } from "../model.js"
import * as C from "./claude.ts"
import * as Store from "./store.ts"

const PACKAGE = "infiniteoc-claude-code"
const NAMES: Record<string, string> = { haiku: "Claude Haiku", sonnet: "Claude Sonnet", opus: "Claude Opus" }
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

export const ClaudeCodePlugin = define({
  id: "infiniteoc.provider.claude-code",
  effect: Effect.fn(function* (ctx) {
    const bin = C.findBinary()
    if (!bin) return
    const location = yield* Effect.serviceOption(Location.Service)
    const directory = Option.isSome(location) ? location.value.directory : process.cwd()
    yield* ctx.provider.transform((providers) => {
      providers.update(C.PROVIDER, (provider) => {
        provider.name = "Claude Code"
        provider.activation = "enabled"
        provider.package = `aisdk:${PACKAGE}`
        provider.settings = {}
        provider.integrationID = undefined
      })
      for (const id of C.MODELS)
        providers.models.update(C.PROVIDER, Model.ID.make(id), (model) => {
          model.modelID = Model.ID.make(id)
          model.name = `${NAMES[id]} (Claude Code)`
          model.family = Model.Family.make("claude")
          model.capabilities = { tools: true, input: ["text"], output: ["text"] }
          model.variants = EFFORTS.map((effort) => ({ id: Model.VariantID.make(effort), settings: { effort } }))
        })
    })
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        if (evt.package !== PACKAGE) return
        const effort = typeof evt.options.effort === "string" ? evt.options.effort : undefined
        evt.sdk = { languageModel: (id: string) => language(bin, id, directory, effort) }
      }),
    )
  }),
})

function language(bin: string, modelId: string, directory: string, effort: string | undefined): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: C.PROVIDER,
    modelId,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("Claude Code models only stream")),
    doStream: async (options) => {
      const sessionID = options.headers?.["x-opencode-session-id"]
      // Agent turns (and compaction) carry tools, ignored: Claude Code uses its own. A session title has none
      // and is not sent to Claude Code, which treats any prompt as a coding task: it is the first line.
      if (sessionID === undefined || !options.tools?.length) {
        const title = C.titleOf(options.prompt)
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              for (const part of [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: title },
                { type: "text-end", id: "t" },
                C.finish(),
              ] as LanguageModelV3StreamPart[])
                controller.enqueue(part)
              controller.close()
            },
          }),
        }
      }
      const input = C.chatInput(options.prompt, Store.loadChats()[sessionID])
      const mode = Store.readSettings().claudeMode
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          const run = (resume: string | undefined, text: string) => {
            const child = spawn(bin, C.chatArgs(modelId, mode, { resume, effort }), { cwd: directory, env: C.env(process.env), stdio: ["pipe", "pipe", "pipe"] })
            options.abortSignal?.addEventListener("abort", () => child.kill(), { once: true })
            const state = C.stream()
            let stderr = ""
            child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)))
            child.stdin.end(text)
            createInterface({ input: child.stdout }).on("line", (line) => {
              let event: unknown
              try {
                event = JSON.parse(line)
              } catch {
                return
              }
              const parts = C.toParts(event, state)
              if (state.session) {
                Store.saveChat(sessionID, { claude: state.session, users: input.users })
                state.session = undefined
              }
              for (const part of parts) controller.enqueue(part)
            })
            child.on("error", (error) => controller.error(error))
            child.on("close", (code) => {
              if (state.done || options.abortSignal?.aborted) return controller.close()
              // A deleted Claude Code session: start over with the conversation as text.
              if (resume && state.message === 0 && /no conversation found/i.test(stderr)) return run(undefined, C.transcript(options.prompt))
              controller.enqueue({ type: "error", error: new Error(`Claude Code exited (${code}): ${stderr.trim() || "no output"}`) })
              controller.close()
            })
          }
          run(input.resume, input.text)
        },
      })
      return { stream }
    },
  }
}
