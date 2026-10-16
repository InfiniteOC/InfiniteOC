// InfiniteOC device: work on paired InfiniteOC servers and switch between them mid-session. Written to
// packages/core/src/plugin/infiniteoc-devices.ts by mods/devices.
// Pairing is the user's CLI job (`infiniteoc device add`); this tool only uses paired devices. Reads (list,
// sessions, read) run silently; open/prompt execute remotely and ask first, like any remote execution.
import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Permission } from "../permission.js"
import * as Devices from "./infiniteoc-devices-lib.mjs"

export const TOOL = "device"

const Input = Schema.Struct({
  action: Schema.Literals(["list", "sessions", "read", "open", "prompt"]).annotate({
    description: "list: paired devices. sessions: a device's sessions. read: messages of a device session. open: start a session at a directory on a device. prompt: send it work and wait for the result.",
  }),
  device: Schema.optionalKey(Schema.String).annotate({ description: "sessions/read/open/prompt: the paired device name (list shows them)." }),
  session: Schema.optionalKey(Schema.String).annotate({ description: "read/prompt: the session id on the device." }),
  directory: Schema.optionalKey(Schema.String).annotate({ description: "open: an absolute directory on the device to work in." }),
  title: Schema.optionalKey(Schema.String).annotate({ description: "open: a title for the new session." }),
  text: Schema.optionalKey(Schema.String).annotate({ description: "prompt: the work to send the device." }),
  limit: Schema.optionalKey(Schema.Number).annotate({ description: "sessions/read: max items (default 50)." }),
})

export const Plugin = define({
  id: "infiniteoc.devices",
  effect: Effect.fn(function* (ctx) {
    const permission = yield* Permission.Service

    const ask = (device: { name: string }, what: string, context: { sessionID: string; agent: string; messageID: unknown; id: unknown }) =>
      permission.assert({
        action: "device",
        resources: [`device:${device.name}:${what}`],
        save: [`device:${device.name}/*`],
        metadata: { device: device.name, what },
        sessionID: context.sessionID as never,
        agent: context.agent as never,
        source: { type: "tool", messageID: context.messageID as never, id: context.id as never },
      })

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: TOOL,
          options: { codemode: false },
          description: [
            "Work on paired InfiniteOC servers (your other devices) and switch between them mid-session.",
            "list shows paired devices; sessions/read inspect a device; open starts a session at a directory there; prompt sends it work, waits for the result and reports back, so this run can alternate devices and keep local context.",
            "Pairing is the user's job (infiniteoc device add); this tool only uses paired devices. open/prompt ask first.",
          ].join("\n"),
          input: Input,
          execute: (input: typeof Input.Type, context: { sessionID: string; agent: string; messageID: unknown; id: unknown }) =>
            Effect.gen(function* () {
              if (input.action === "list") {
                const all = yield* Effect.promise(() => Devices.listDevices())
                if (!all.length) return { content: "No devices paired. Pair one with: infiniteoc device add NAME URL (the other device's infiniteoc serve/host address)." }
                return { content: all.map((item) => `- ${item.name}: ${item.url}`).join("\n") }
              }
              if (!input.device?.trim()) return yield* Effect.fail(new ToolFailure({ message: `${input.action} needs a device name (find them with action "list").` }))
              const device = yield* Effect.try({ try: () => Devices.resolveDevice(input.device!), catch: (error) => new ToolFailure({ message: (error as Error).message }) })
              if (input.action === "sessions") return { content: Devices.formatDeviceSessions(device, yield* Effect.promise(() => Devices.deviceSessions(device, { limit: input.limit }))) }
              if (input.action === "read") {
                if (!input.session?.trim()) return yield* Effect.fail(new ToolFailure({ message: "read needs a session id (find them with action \"sessions\")." }))
                const messages = yield* Effect.promise(() => Devices.deviceMessages(device, input.session!, { limit: input.limit }))
                return { content: Devices.formatDeviceMessages(device, input.session!, messages) }
              }
              if (input.action === "open") {
                if (!input.directory?.trim()) return yield* Effect.fail(new ToolFailure({ message: "open needs an absolute directory on the device." }))
                yield* ask(device, `open ${input.directory}`, context)
                const created = yield* Effect.try({ try: () => Devices.deviceOpen(device, { directory: input.directory!, title: input.title }), catch: (error) => new ToolFailure({ message: (error as Error).message }) })
                return { content: `Opened session ${created?.id} on device "${device.name}" at ${input.directory}. Send it work with action "prompt".` }
              }
              if (!input.text?.trim()) return yield* Effect.fail(new ToolFailure({ message: "prompt needs text to send (and a session id)." }))
              if (!input.session?.trim()) return yield* Effect.fail(new ToolFailure({ message: "prompt needs a session id (open one with action \"open\")." }))
              yield* ask(device, `prompt session ${input.session}`, context)
              const result = yield* Effect.try({ try: () => Devices.devicePrompt(device, { sessionID: input.session!, text: input.text! }), catch: (error) => new ToolFailure({ message: (error as Error).message }) })
              return { content: `Device "${device.name}" session ${result.sessionID} finished:\n${result.text}` }
            }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: `device ${input.action}: ${error instanceof Error ? error.message : String(error)}`, error })))),
        })
      })
      .pipe(Effect.orDie)
  }),
})
