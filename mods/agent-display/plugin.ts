// InfiniteOC agent display: the agent's own isolated screen (Xvfb, never the
// user's :0/Wayland session). Written to packages/core/src/plugin/infiniteoc-agent-display.ts
// by mods/agent-display next to infiniteoc-agent-display-lib.ts (the pure helpers).
import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { TuiEvent } from "@opencode/schema/tui-event"
import { Effect, Schema } from "effect"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { openSync, closeSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import http from "node:http"
import * as lib from "./infiniteoc-agent-display-lib.js"

export const TOOL = lib.TOOL

export const GUIDANCE = `[Agent display]
The agent has its own isolated screen (Xvfb, default :99), separate from the user's session. It never touches the user's :0/Wayland display: spawned programs get DISPLAY=:99 with WAYLAND_DISPLAY unset.
- Use the agent_display tool: status (is it running, what apps, is the live view on), exec (spawn a program there; runs in the project directory), win (list, focus, move, resize, click, type, key, close windows via title or id), screenshot (see the screen; costs image tokens, use sparingly), show (screenshot plus a user-visible note so the user can view the frame with <leader>i), stream (live watch page on this machine only), start/stop.
- exec, win, stream and show with live go through the normal shell permission, so /readonly, allow-lists and yolo apply. Screenshots are PNG frames: take one when a claim depends on what is actually on the screen, then read it before describing it. The live page is for the user to watch, not for the agent to see.
- Chromium on a Wayland box still tries Wayland: pass --ozone-platform=x11. There is no window manager, so focusing warns but move/resize/click/type work.`

const Input = Schema.Struct({
  action: Schema.Literals(["status", "start", "stop", "exec", "win", "screenshot", "show", "stream"]).annotate({
    description: "status: is the display running, what apps, is live on; start/stop: manage Xvfb; exec: spawn a program on it; win: drive windows; screenshot: see the screen; show: screenshot plus a user-visible note; stream: live watch page (this machine only).",
  }),
  command: Schema.optionalKey(Schema.String).annotate({ description: 'exec: executable on PATH (e.g. "chromium").' }),
  args: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "exec: arguments (max 32)." }),
  op: Schema.optionalKey(Schema.String).annotate({ description: "win: list, focus, move, resize, click, type, key, close." }),
  window: Schema.optionalKey(Schema.String).annotate({ description: "win: window id from list, or a title fragment." }),
  x: Schema.optionalKey(Schema.Number).annotate({ description: "win move: left edge." }),
  y: Schema.optionalKey(Schema.Number).annotate({ description: "win move: top edge." }),
  w: Schema.optionalKey(Schema.Number).annotate({ description: "win resize: width." }),
  h: Schema.optionalKey(Schema.Number).annotate({ description: "win resize: height." }),
  button: Schema.optionalKey(Schema.Number).annotate({ description: "win click: 1 left, 2 middle, 3 right." }),
  text: Schema.optionalKey(Schema.String).annotate({ description: "win type: text to type into the window." }),
  keys: Schema.optionalKey(Schema.String).annotate({ description: 'win key: keystroke like "ctrl+q".' }),
  note: Schema.optionalKey(Schema.String).annotate({ description: 'show: what the user should look at (e.g. "the failing dialog").' }),
  live: Schema.optionalKey(Schema.Boolean).annotate({ description: "show: also start the live watch page and open it for the user." }),
})

const failure = (message: string, error?: unknown) => new ToolFailure({ message, ...(error === undefined ? {} : { error }) })
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type Owned = { pid: number; child: ChildProcess }
let owned: Owned | undefined
type Stream = { server: http.Server; port: number; display: string }
let stream: Stream | undefined

const runFile = (command: string, args: string[], env: Record<string, string>) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        execFile(command, args, { env: env as NodeJS.ProcessEnv, timeout: 30_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
      }),
    catch: (error) => error,
  })

const startDisplay = (display: string) =>
  Effect.gen(function* () {
    const current = lib.sweepStatus(lib.readStatus())
    if (current.running) {
      lib.writeStatus(current)
      return current
    }
    if (process.platform !== "linux") return yield* failure("The agent display needs Linux (Xvfb); this machine runs " + process.platform + ".")
    const child = yield* Effect.try({
      try: () => spawn("Xvfb", lib.xvfbArgs(display), { stdio: "ignore", detached: false }),
      catch: (error) => failure("Could not start Xvfb (is it installed? e.g. the xorg-server-xvfb package): " + message(error), error),
    })
    const pid = child.pid
    if (pid === undefined) return yield* failure("Xvfb did not report a pid.")
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Xvfb did not stay up (is " + display + " already taken? check INFINITEOC_AGENT_DISPLAY)")), 2000)
          child.once("error", (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.once("exit", (code) => {
            clearTimeout(timer)
            reject(new Error(`Xvfb exited immediately (code ${code}); is ${display} already taken?`))
          })
          setTimeout(() => {
            clearTimeout(timer)
            resolve()
          }, 800)
        }),
      catch: (error) => failure("Could not start Xvfb on " + display + ": " + message(error), error),
    })
    child.unref()
    owned = { pid, child }
    const status: lib.Status = {
      display,
      running: true,
      pid,
      resolution: `${lib.WIDTH}x${lib.HEIGHT}x${lib.DEPTH}`,
      startedAt: Date.now(),
      apps: [],
    }
    lib.writeStatus(status)
    return status
  })

const stopStream = () =>
  Effect.sync(() => {
    if (!stream) return
    try {
      stream.server.close()
    } catch {}
    stream = undefined
    const status = lib.sweepStatus(lib.readStatus())
    const next = { ...status }
    delete next.streamPort
    delete next.streamStartedAt
    lib.writeStatus(next)
  })

const startStream = (display: string) =>
  Effect.gen(function* () {
    if (stream) return stream
    if (process.platform !== "linux") return yield* failure("The live view needs Linux (ffmpeg x11grab); this machine runs " + process.platform + ".")
    const server = http.createServer((request, response) => {
      if (request.url === "/stream.mjpg") {
        response.writeHead(200, {
          "content-type": "multipart/x-mixed-replace; boundary=frame",
          "cache-control": "no-store",
          connection: "close",
        })
        const feed = spawn("ffmpeg", lib.ffmpegStreamArgs(display), { stdio: ["ignore", "pipe", "ignore"] })
        feed.stdout.on("data", (chunk: Buffer) => {
          if (!response.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${chunk.length}\r\n\r\n`)) return
          response.write(chunk)
          response.write("\r\n")
        })
        const done = () => {
          try {
            feed.kill("SIGTERM")
          } catch {}
          try {
            response.end()
          } catch {}
        }
        request.on("close", done)
        feed.on("exit", () => {
          try {
            response.end()
          } catch {}
        })
        return
      }
      const page = lib.viewerPage(display)
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      response.end(page)
    })
    const port = yield* Effect.tryPromise({
      try: () =>
        new Promise<number>((resolve, reject) => {
          server.once("error", reject)
          server.listen(0, lib.streamHost, () => {
            const address = server.address()
            if (address && typeof address === "object") resolve(address.port)
            else reject(new Error("The live view did not bind a port."))
          })
        }),
      catch: (error) => failure("Could not start the live view: " + message(error), error),
    })
    stream = { server, port, display }
    const status = lib.sweepStatus(lib.readStatus())
    lib.writeStatus({ ...status, display, running: true, streamPort: port, streamStartedAt: Date.now() })
    return stream
  })

const captureFrame = (display: string) =>
  Effect.gen(function* () {
    const file = lib.frameFile()
    const env = { ...process.env, DISPLAY: display } as Record<string, string>
    const first = lib.importArgs(display, file)
    const fallback = lib.ffmpegArgs(display, file)
    const attempt = yield* runFile(first.command, first.args, env).pipe(
      Effect.map(() => true),
      Effect.orElseSucceed(() => false),
    )
    if (!attempt) yield* runFile(fallback.command, fallback.args, env).pipe(Effect.mapError((error) => failure("Screenshot failed (need ImageMagick `import` or ffmpeg with x11grab): " + message(error), error)))
    const size = yield* Effect.tryPromise({
      try: () => stat(file).then((info) => info.size),
      catch: (error) => failure("Screenshot taken but the frame file is unreadable: " + message(error), error),
    })
    if (size > lib.MAX_FRAME_BYTES) return yield* failure(`Screenshot is ${(size / 1048576).toFixed(1)}MB (over the 5MB cap); stop large windows and retry.`)
    const base64 = yield* Effect.tryPromise({
      try: () => readFile(file).then((bytes) => bytes.toString("base64")),
      catch: (error) => failure("Screenshot taken but the frame could not be read: " + message(error), error),
    })
    return { file, base64 }
  })

const frameContent = (text: string, base64: string) => [
  { type: "text" as const, text },
  { type: "file" as const, uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "agent-display.png" },
]

export const Plugin = define({
  id: "infiniteoc.agent-display",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const permission = yield* Permission.Service
    const directory = String(ctx.location.directory)
    const toast = (title: string, text: string) =>
      bus.publish(TuiEvent.ToastShow, { title, message: text, variant: "info", duration: 8000 }).pipe(Effect.ignore)
    const assertShell = (resource: string, context: any, what: string) =>
      permission
        .assert({
          action: "shell",
          resources: [resource],
          save: [resource],
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
        })
        .pipe(Effect.mapError((error) => failure(`${what} denied: ${resource}`, error)))

    const execute = (input: typeof Input.Type, context: any) =>
      Effect.gen(function* () {
        const display = yield* Effect.try({
          try: () => lib.resolveDisplay(),
          catch: (error) => failure(message(error), error),
        })
        if (input.action === "status") {
          const status = lib.sweepStatus(lib.readStatus())
          lib.writeStatus(status)
          return { content: lib.describeStatus(status) }
        }
        if (input.action === "start") {
          const status = yield* startDisplay(display)
          return { content: `Agent display ${display} running (pid ${status.pid}). Spawn programs with { action: "exec", command }.` }
        }
        if (input.action === "stop") {
          yield* stopStream()
          const status = lib.sweepStatus(lib.readStatus())
          const pid = status.pid
          if (pid !== undefined && lib.pidAlive(pid)) {
            if (owned?.pid === pid) {
              owned.child.kill("SIGTERM")
              owned = undefined
            } else {
              try {
                process.kill(pid, "SIGTERM")
              } catch (error) {
                return yield* failure(`Could not stop Xvfb pid ${pid}: ` + message(error), error)
              }
            }
          }
          lib.writeStatus({ ...lib.blankStatus(display), apps: [] })
          return { content: `Agent display ${display} stopped (live view off).` }
        }
        if (input.action === "stream") {
          yield* assertShell(`agent display live view on ${display}`, context, "Agent display stream")
          yield* startDisplay(display)
          const live = yield* startStream(display)
          return { content: `Live view of ${display} on this machine only: http://${lib.streamHost}:${live.port}/ (MJPEG ~${lib.streamRate}fps; stop ends it).` }
        }
        if (input.action === "exec") {
          const parsed = lib.validateExec({ command: input.command, args: input.args })
          if ("error" in parsed) return yield* failure(parsed.error)
          const full = `${parsed.command} ${parsed.args.join(" ")}`.trim()
          yield* assertShell(full, context, "Agent display exec")
          yield* startDisplay(display)
          const log = lib.appLog(process.pid)
          const child = yield* Effect.try({
            try: () => {
              const fd = openSync(log, "a")
              try {
                return spawn(parsed.command, parsed.args, {
                  cwd: directory,
                  env: lib.appEnv(display),
                  detached: true,
                  stdio: ["ignore", fd, fd],
                })
              } finally {
                closeSync(fd)
              }
            },
            catch: (error) => failure(`Could not spawn ${parsed.command}: ` + message(error), error),
          })
          child.unref()
          const status = lib.sweepStatus(lib.readStatus())
          const next: lib.Status = {
            ...status,
            display,
            running: true,
            apps: [...status.apps, { pid: child.pid ?? -1, command: full, startedAt: Date.now(), log }].slice(-20),
          }
          lib.writeStatus(next)
          return { content: `Spawned ${full} on ${display} (pid ${child.pid}). Screenshot to see it; win moves, focuses and drives its windows; output goes to ${log}.` }
        }
        if (input.action === "win") {
          const parsed = lib.validateWin({ op: input.op, window: input.window, x: input.x, y: input.y, w: input.w, h: input.h, button: input.button, text: input.text, keys: input.keys })
          if ("error" in parsed) return yield* failure(parsed.error)
          yield* assertShell(`xdotool ${parsed.args.join(" ")} on ${display}`, context, "Agent display win")
          yield* startDisplay(display)
          const env = { ...process.env, DISPLAY: display } as Record<string, string>
          const output = yield* runFile("xdotool", parsed.args, env).pipe(
            Effect.mapError((error) => failure("Window action failed (is xdotool installed, is the window there? `win list` shows ids): " + message(error), error)),
          )
          if (parsed.op === "list") {
            const rows = output.trim() ? output.trim().split("\n").length : 0
            return { content: rows ? `Visible windows on ${display}:\n${output.trim()}` : `No visible windows on ${display} yet; exec a program first.` }
          }
          return { content: `Window ${parsed.op} on ${display} done${output.trim() ? `: ${output.trim().slice(0, 500)}` : "."}` }
        }
        // screenshot and show: ensure the display, capture, show also toasts the user.
        yield* startDisplay(display)
        const frame = yield* captureFrame(display)
        const status = lib.sweepStatus(lib.readStatus())
        const note = input.action === "show" && input.note ? ` ${input.note}` : ""
        lib.writeStatus({
          ...status,
          display,
          running: true,
          lastFrameAt: Date.now(),
          framePath: frame.file,
          ...(input.action === "show" ? { showRequestedAt: Date.now(), ...(input.note ? { showNote: input.note } : {}) } : {}),
        })
        if (input.action === "show") {
          let liveUrl = ""
          if (input.live === true) {
            yield* assertShell(`agent display live view on ${display}`, context, "Agent display live view")
            const live = yield* startStream(display)
            liveUrl = ` Live: http://${lib.streamHost}:${live.port}/ (this machine only).`
            yield* Effect.tryPromise({
              try: () =>
                new Promise<void>((resolve) => {
                  const viewer = spawn("xdg-open", [`http://${lib.streamHost}:${live.port}/`], {
                    env: { ...process.env, DISPLAY: lib.USER_DISPLAY },
                    stdio: "ignore",
                    detached: true,
                  })
                  viewer.on("error", () => resolve())
                  viewer.unref()
                  setTimeout(() => resolve(), 1500)
                }),
              catch: () => failure("unreachable"),
            }).pipe(Effect.ignore)
          }
          yield* toast("Agent display", `The agent shared its screen${note ? `: ${input.note}` : ""}.${liveUrl ? " Live view opened." : ""} The frame is in the transcript; <leader>i views images.`)
          return { content: frameContent(`Screen ${display}${note ? ` (${input.note})` : ""}: shared with the user (they were notified).${liveUrl}`, frame.base64) }
        }
        return { content: frameContent(`Screen ${display}:`, frame.base64) }
      }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : failure(message(error), error))))

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: TOOL,
          options: { codemode: false, permission: "agent_display" },
          description: [
            "The agent's own isolated screen (Xvfb, never the user's display): status, start/stop, exec programs on it, drive their windows, screenshot it, show a frame to the user, stream a live watch page.",
            "exec, win, stream and show with live run through the normal shell permission. Screenshots cost image tokens: take one only when a claim depends on what is actually on the screen.",
            "show notifies the user and puts the frame in the transcript (they view it with <leader>i). stream serves MJPEG on 127.0.0.1 only; show with live also opens it in the user's browser.",
          ].join("\n"),
          input: Input,
          execute,
        })
      })
      .pipe(Effect.orDie)
  }),
})
