// InfiniteOC agent display: the agent's own isolated screen (Xvfb, never the
// user's :0/Wayland session). Written to packages/core/src/plugin/infiniteoc-agent-display.ts
// by mods/agent-display next to infiniteoc-agent-display-lib.ts (the pure helpers).
import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { TuiEvent } from "@opencode/schema/tui-event"
import { Effect, Schema } from "effect"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { Bus } from "../bus.js"
import { Permission } from "../permission.js"
import * as desktop from "./infiniteoc-agent-display-desktop.js"
import * as lib from "./infiniteoc-agent-display-lib.js"
import { VIEWER } from "./infiniteoc-agent-display-viewer.js"

export const TOOL = lib.TOOL

const num = (description: string) => Schema.optionalKey(Schema.Finite).annotate({ description })
const str = (description: string) => Schema.optionalKey(Schema.String).annotate({ description })
// One input op: the fields of `win`, and each item of `steps`.
const OpFields = {
  window: str("Window id from list, or a title/class fragment (regex). Omit to work in screen pixels. screenshot/show: capture just this window."),
  x: num("Pointer x: screen pixels without window, window-relative with window. move: new left edge (screen)."),
  y: num("Pointer y: screen pixels without window, window-relative with window. move: new top edge (screen)."),
  x2: num("drag: end x (same coordinates as x)."),
  y2: num("drag: end y (same coordinates as y)."),
  w: num("resize: width."),
  h: num("resize: height."),
  button: num("click/mousedown/mouseup: 1 left (default), 2 middle, 3 right. scroll: 4 up, 5 down (default), 6 left, 7 right."),
  count: num("click: repeats (2 = double click). scroll: notches (default 3). key: repeats."),
  text: str("type: text to type (newlines press Return)."),
  keys: str('key/keydown/keyup: X keysyms, space separated, e.g. "Return", "ctrl+l", "ctrl+a BackSpace".'),
  ms: num("sleep: milliseconds (default 500, max 10000)."),
  label: str('click/mousemove/scroll: visible text to act on instead of x/y, read off the screen (OCR), e.g. "Consent", "Sign in". find: the text to locate. wait: text to wait for.'),
  nth: num("With label: which match when the text appears several times (1 = best: standalone text such as a button, then top to bottom)."),
  timeout: num("wait: seconds until the window appears (1-25, default 10). exec: seconds to wait for the app's first window (0-25, default 10, 0 skips)."),
}
const Step = Schema.Struct({ op: Schema.Literals(lib.WIN_OPS).annotate({ description: "The input op." }), ...OpFields })

const Input = Schema.Struct({
  action: Schema.Literals(["status", "start", "stop", "exec", "kill", "win", "steps", "screenshot", "show", "stream"]).annotate({
    description:
      "exec: start a program and wait for its window; steps: run many input ops in one call; win: one op; screenshot: see the screen; show: screenshot plus a note for the user; status: apps and windows; kill: stop a spawned app; stream: live watch page for the user; start/stop: manage the display.",
  }),
  op: Schema.optionalKey(Schema.Literals(lib.WIN_OPS)).annotate({ description: "win: the op to run (see steps for the list)." }),
  ...OpFields,
  steps: Schema.optionalKey(Schema.Array(Step)).annotate({
    description:
      'steps: ops run in order, stopping at the first failure, e.g. [{ op: "click", x: 640, y: 120 }, { op: "type", text: "cats" }, { op: "key", keys: "Return" }, { op: "sleep", ms: 800 }].',
  }),
  screenshot: Schema.optionalKey(Schema.Boolean).annotate({ description: "exec/win/steps: also return a screenshot of the whole screen afterwards (saves a call)." }),
  command: str('exec: executable on PATH (e.g. "chromium").'),
  args: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "exec: arguments (max 32)." }),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({ description: "exec: extra environment variables (DISPLAY/WAYLAND_DISPLAY stay managed)." }),
  pid: num("kill: pid of a spawned app (from status)."),
  note: str('show: what the user should look at (e.g. "the failing dialog").'),
  live: Schema.optionalKey(Schema.Boolean).annotate({ description: "show: also start the live watch page and open it for the user." }),
})

const failure = (message: string, error?: unknown) => new ToolFailure({ message, ...(error === undefined ? {} : { error }) })
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
// execFile errors repeat the whole command line; keep what the tool printed, briefly.
const brief = (error: unknown) => message(error).replace(/^Command failed: [^\n]*\n?/, "").trim().split("\n").slice(0, 3).join(" ").slice(0, 300) || message(error)
const missing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"

type Owned = { pid: number; child: ChildProcess }
let owned: Owned | undefined

type Ran = { ok: boolean; stdout: string; error?: unknown }
let ocrCount = 0
// Never fails: a non-zero exit still carries what the command printed before it stopped.
const runRaw = (command: string, args: string[], env: Record<string, string>, timeout = 30_000) =>
  Effect.promise(
    () =>
      new Promise<Ran>((resolve) => {
        execFile(command, args, { env: env as NodeJS.ProcessEnv, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
          resolve(error ? { ok: false, stdout: String(stdout ?? ""), error } : { ok: true, stdout: String(stdout) }),
        )
      }),
  )
const runFile = (command: string, args: string[], env: Record<string, string>, timeout?: number) =>
  runRaw(command, args, env, timeout).pipe(Effect.flatMap((ran) => (ran.ok ? Effect.succeed(ran.stdout) : Effect.fail(ran.error))))

const onPath = (name: string) =>
  (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    try {
      accessSync(path.join(dir, name), constants.X_OK)
      return true
    } catch {
      return false
    }
  })

// The desktop (openbox, tint2, wallpaper) once per X server; INFINITEOC_AGENT_DESKTOP=0 keeps it bare.
const desktopTried = new Set<number>()
const startDesktop = (display: string, xvfb: number) =>
  Effect.gen(function* () {
    if (process.env.INFINITEOC_AGENT_DESKTOP === "0" || desktopTried.has(xvfb) || !onPath(desktop.WM)) return undefined
    desktopTried.add(xvfb)
    const data = lib.dataDir()
    const files = desktop.desktopFiles(data)
    const env = desktop.desktopEnv(lib.appEnv(display), data)
    const written = yield* Effect.sync(() => {
      try {
        mkdirSync(path.dirname(files.theme), { recursive: true, mode: 0o700 })
        writeFileSync(files.theme, desktop.openboxTheme())
        writeFileSync(files.openbox, desktop.openboxConfig())
        writeFileSync(files.tint2, desktop.tint2Config())
        return true
      } catch {
        return false
      }
    })
    if (!written) return undefined
    if (!existsSync(files.wallpaper) && onPath("magick")) yield* runRaw("magick", desktop.wallpaperArgs(files.wallpaper, lib.WIDTH, lib.HEIGHT), env, 20_000)
    // ImageMagick's display sets the root background and still exits 1; the picture is what counts.
    if (existsSync(files.wallpaper) && onPath("display")) yield* runRaw("display", ["-window", "root", files.wallpaper], env, 10_000)
    const wm = spawn(desktop.WM, ["--config-file", files.openbox], { env, stdio: "ignore" })
    wm.on("error", () => {})
    wm.unref()
    if (wm.pid === undefined) return undefined
    // Managing once it advertises itself on the root window; without xprop, give it a moment.
    const started = Date.now()
    while (Date.now() - started < 2500) {
      yield* Effect.sleep(100)
      if (!lib.pidAlive(wm.pid)) return undefined
      if (!onPath("xprop")) {
        yield* Effect.sleep(300)
        break
      }
      if (/window id/.test((yield* runRaw("xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"], env, 2000)).stdout)) break
    }
    let panel: ChildProcess | undefined
    if (onPath(desktop.PANEL)) {
      panel = spawn(desktop.PANEL, ["-c", files.tint2], { env, stdio: "ignore" })
      panel.on("error", () => {})
      panel.unref()
    }
    return { wm: wm.pid, ...(panel?.pid ? { panel: panel.pid } : {}) }
  })

// A window manager decides focus and closing; without one, the tool does it itself.
const managed = () => {
  const wm = lib.readStatus().desktop?.wm
  return wm !== undefined && lib.pidAlive(wm)
}

const startDisplay = (display: string) =>
  Effect.gen(function* () {
    const current = lib.sweepStatus(lib.readStatus())
    if (current.running) {
      // A display from before the desktop existed (or whose desktop died) gets one now, once.
      if (current.pid !== undefined && !(current.desktop && lib.pidAlive(current.desktop.wm))) {
        const started = yield* startDesktop(display, current.pid)
        if (started) current.desktop = started
      }
      const next = lib.ensureCamera(current)
      lib.writeStatus(next)
      return next
    }
    if (process.platform !== "linux") return yield* failure("The agent display needs Linux (Xvfb); this machine runs " + process.platform + ".")
    const spawnedAt = Date.now()
    const child = yield* Effect.try({
      try: () => spawn("Xvfb", lib.xvfbArgs(display), { stdio: "ignore", detached: false }),
      catch: (error) => failure("Could not start Xvfb (is it installed? e.g. the xorg-server-xvfb package): " + message(error), error),
    })
    const pid = child.pid
    if (pid === undefined) return yield* failure("Xvfb did not report a pid.")
    // Ready once Xvfb creates its socket (~100ms); a leftover socket from an older server does not count.
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          const done = (error?: Error) => {
            clearInterval(timer)
            child.off("exit", exited)
            child.off("error", done)
            error ? reject(error) : resolve()
          }
          const exited = (code: number | null) => done(new Error(`Xvfb exited immediately (code ${code}); is ${display} already taken? (INFINITEOC_AGENT_DISPLAY picks another)`))
          child.once("exit", exited)
          child.once("error", done)
          const timer = setInterval(() => {
            try {
              if (statSync(lib.displaySocket(display)).ctimeMs >= spawnedAt - 100) return done()
            } catch {}
            if (Date.now() - spawnedAt > 5000) done(new Error(`Xvfb did not open ${display} within 5s`))
          }, 25)
        }),
      catch: (error) => failure("Could not start Xvfb on " + display + ": " + message(error), error),
    })
    child.unref()
    owned = { pid, child }
    const session = yield* startDesktop(display, pid)
    const status: lib.Status = {
      display,
      running: true,
      pid,
      resolution: `${lib.WIDTH}x${lib.HEIGHT}x${lib.DEPTH}`,
      startedAt: Date.now(),
      apps: [],
      ...(session ? { desktop: session } : {}),
    }
    // The virtual camera follows the display when the user turned it on in /display.
    const next = lib.ensureCamera(status)
    lib.writeStatus(next)
    return next
  })

// The live view: one ffmpeg capture shared by every open page, running only while someone watches.
type Live = {
  server: http.Server
  port: number
  display: string
  viewers: Set<http.ServerResponse>
  listeners: Set<http.ServerResponse>
  feed?: ChildProcess
  last?: Buffer
  idle?: ReturnType<typeof setTimeout>
  keepalive: ReturnType<typeof setInterval>
}
let live: Live | undefined

/** The user turned on realistic input in /display: it moves like a person instead of instantly. Read per op. */
const realistic = () => lib.readSettings().realistic
/** Tells open pages what the agent is doing (captions, click marks, typing). */
const emit = (event: Record<string, unknown>) => {
  if (!live) return
  const data = `data: ${JSON.stringify(event)}\n\n`
  for (const listener of live.listeners) listener.write(data)
}

const part = (frame: Buffer) => [`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`, frame, "\r\n"] as const
const sendFrame = (viewer: http.ServerResponse, frame: Buffer) => {
  // A viewer that cannot keep up skips frames instead of falling behind real time.
  if (viewer.writableNeedDrain || viewer.writableLength > 2 * 1024 * 1024) return
  for (const piece of part(frame)) viewer.write(piece)
}

const startFeed = (state: Live) => {
  clearTimeout(state.idle)
  if (state.feed) return
  const feed = spawn("ffmpeg", lib.ffmpegStreamArgs(state.display), { env: lib.appEnv(state.display), stdio: ["ignore", "pipe", "ignore"] })
  state.feed = feed
  feed.on("error", () => {})
  feed.stdout.on(
    "data",
    lib.mpjpegFrames((frame) => {
      state.last = frame
      for (const viewer of state.viewers) sendFrame(viewer, frame)
    }),
  )
  // The display went away (or ffmpeg failed): end the streams; open pages reconnect on their own.
  feed.on("exit", () => {
    if (state.feed === feed) state.feed = undefined
    for (const viewer of state.viewers) viewer.end()
    state.viewers.clear()
  })
}
const stopFeedSoon = (state: Live) => {
  clearTimeout(state.idle)
  state.idle = setTimeout(() => {
    if (state.viewers.size || !state.feed) return
    state.feed.kill("SIGTERM")
    state.feed = undefined
  }, 5000)
}

const stopStream = () =>
  Effect.sync(() => {
    if (!live) return
    const state = live
    live = undefined
    clearTimeout(state.idle)
    clearInterval(state.keepalive)
    state.feed?.kill("SIGTERM")
    for (const response of [...state.viewers, ...state.listeners]) response.end()
    try {
      state.server.close()
    } catch {}
    const status = lib.sweepStatus(lib.readStatus())
    const next = { ...status }
    delete next.streamPort
    delete next.streamStartedAt
    lib.writeStatus(next)
  })

const startStream = (display: string) =>
  Effect.gen(function* () {
    if (live) return live
    if (process.platform !== "linux") return yield* failure("The live view needs Linux (ffmpeg x11grab); this machine runs " + process.platform + ".")
    let state: Live | undefined
    const server = http.createServer((request, response) => {
      // Loopback only, and only under its own name: a web page that rebinds a domain to 127.0.0.1 gets nothing.
      const host = String(request.headers.host ?? "")
      if (!state || !new RegExp(`^(127\\.0\\.0\\.1|localhost):${state.port}$`).test(host)) {
        response.writeHead(403, { "content-type": "text/plain" })
        return void response.end("forbidden")
      }
      const url = (request.url ?? "/").split("?")[0]
      if (url === "/stream.mjpg") {
        response.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame", "cache-control": "no-store", connection: "close" })
        state.viewers.add(response)
        // The last frame right away, so a new page never starts black.
        if (state.last) sendFrame(response, state.last)
        startFeed(state)
        const current = state
        request.on("close", () => {
          current.viewers.delete(response)
          if (!current.viewers.size) stopFeedSoon(current)
        })
        return
      }
      if (url === "/events") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
        response.write("retry: 1000\n\n")
        state.listeners.add(response)
        const current = state
        request.on("close", () => current.listeners.delete(response))
        return
      }
      if (url !== "/") {
        response.writeHead(404, { "content-type": "text/plain" })
        return void response.end("not found")
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      response.end(lib.viewerHtml(VIEWER, display))
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
    // SSE comments keep idle event connections from being closed by the browser or a proxy.
    const keepalive = setInterval(() => {
      for (const listener of state?.listeners ?? []) listener.write(": keepalive\n\n")
    }, 20_000)
    keepalive.unref?.()
    state = { server, port, display, viewers: new Set(), listeners: new Set(), keepalive }
    live = state
    const status = lib.sweepStatus(lib.readStatus())
    lib.writeStatus({ ...status, display, running: true, streamPort: port, streamStartedAt: Date.now() })
    return state
  })

const captureFrame = (display: string, windowId?: string) =>
  Effect.gen(function* () {
    const file = lib.frameFile()
    const env = lib.appEnv(display)
    if (windowId !== undefined) {
      yield* runFile("import", lib.importWindowArgs(windowId, file).args, env).pipe(
        Effect.mapError((error) => failure("Window capture failed (needs ImageMagick `import`): " + brief(error), error)),
      )
    } else {
      const first = lib.importArgs(display, file)
      const fallback = lib.ffmpegArgs(display, file)
      const attempt = yield* runFile(first.command, first.args, env).pipe(
        Effect.map(() => true),
        Effect.orElseSucceed(() => false),
      )
      if (!attempt) yield* runFile(fallback.command, fallback.args, env).pipe(Effect.mapError((error) => failure("Screenshot failed (need ImageMagick `import` or ffmpeg with x11grab): " + brief(error), error)))
    }
    const size = yield* Effect.tryPromise({
      try: () => stat(file).then((info) => info.size),
      catch: (error) => failure("Screenshot taken but the frame file is unreadable: " + message(error), error),
    })
    if (size > lib.MAX_FRAME_BYTES) return yield* failure(`Screenshot is ${(size / 1048576).toFixed(1)}MB (over the 5MB cap); stop large windows and retry.`)
    const base64 = yield* Effect.tryPromise({
      try: () => readFile(file).then((bytes) => bytes.toString("base64")),
      catch: (error) => failure("Screenshot taken but the frame could not be read: " + message(error), error),
    })
    lib.writeStatus({ ...lib.sweepStatus(lib.readStatus()), display, running: true, lastFrameAt: Date.now(), framePath: file })
    return { file, base64 }
  })

const frameContent = (text: string, base64: string) => [
  { type: "text" as const, text },
  { type: "file" as const, uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "agent-display.png" },
]

// Windows and input on one display: xdotool calls that never touch the user's session.
const screenOf = (display: string) => {
  const env = lib.appEnv(display)
  const xdo = (args: string[], timeout?: number) => runFile("xdotool", args, env, timeout)
  // One xdotool call per window; the chain stops early for windows without WM_CLASS.
  const windowInfo = (id: string) =>
    runRaw("xdotool", ["getwindowgeometry", "--shell", id, "getwindowname", id, "getwindowclassname", id], env).pipe(
      Effect.map((ran) => {
        const info = lib.parseWindowInfo(id, ran.stdout, ran.ok)
        return info.geometry ? info : undefined
      }),
    )
  const listWindows = (pattern = "") =>
    Effect.gen(function* () {
      const ran = yield* runRaw("xdotool", ["search", "--onlyvisible", pattern], env)
      if (!ran.ok && missing(ran.error)) return yield* failure("xdotool is not installed (the xdotool package); window control and input need it.")
      const ids = [...new Set(ran.stdout.split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line)))]
      const infos = yield* Effect.forEach(ids, windowInfo, { concurrency: 8 })
      return infos.filter((info): info is lib.WindowInfo => !!info && lib.isRealWindow(info))
    })
  const windowsText = () =>
    listWindows().pipe(Effect.map((all) => (all.length ? `Windows (id: title | class | WxH+X+Y):\n${lib.formatWindowList(all)}` : "No windows are open.")))
  const screenText = () =>
    Effect.gen(function* () {
      const pointer = lib.parsePointer((yield* runRaw("xdotool", ["getmouselocation", "--shell"], env)).stdout)
      const windows = yield* windowsText().pipe(Effect.orElseSucceed(() => ""))
      return `Screen ${display} ${lib.WIDTH}x${lib.HEIGHT}: without window, x/y are this image's pixels.${pointer ? ` Pointer at ${pointer.x},${pointer.y}.` : ""}${windows ? `\n${windows}` : ""}`
    })
  const resolveWindow = (target: string) =>
    Effect.gen(function* () {
      const found = /^\d+$/.test(target) ? yield* windowInfo(target) : lib.pickWindow(yield* listWindows(target))
      if (found) return found
      const now = yield* windowsText().pipe(Effect.orElseSucceed(() => ""))
      return yield* failure(`${/^\d+$/.test(target) ? `No window ${target}` : `No visible window matches ${JSON.stringify(target)}`} on ${display}. ${now}`)
    })
  const waitWindow = (plan: lib.WinPlan) =>
    Effect.gen(function* () {
      const started = Date.now()
      for (;;) {
        const found = /^\d+$/.test(plan.window) ? yield* windowInfo(plan.window) : lib.pickWindow(yield* listWindows(plan.window))
        if (found) return { found, after: Date.now() - started }
        if (Date.now() - started >= plan.timeout * 1000) {
          const now = yield* windowsText().pipe(Effect.orElseSucceed(() => ""))
          return yield* failure(`No window matching ${JSON.stringify(plan.window)} appeared within ${plan.timeout}s. ${now}`)
        }
        yield* Effect.sleep(250)
      }
    })
  // Reads the screen's text with tesseract (two passes: as is, and light text on color/dark).
  const ocrScreen = () =>
    Effect.gen(function* () {
      if (!onPath("tesseract"))
        return yield* failure("label and find read the screen's text with OCR, which needs tesseract (the tesseract and tesseract-data-eng packages); use x/y meanwhile.")
      const base = path.join(lib.dataDir(), `ocr-${process.pid}-${++ocrCount}`)
      const files = { raw: `${base}.png`, plain: `${base}-plain.png`, light: `${base}-light.png` }
      return yield* Effect.gen(function* () {
        yield* runFile("import", ["-window", "root", files.raw], env).pipe(Effect.mapError((error) => failure("Could not capture the screen to read it: " + brief(error), error)))
        const scaled = onPath("magick") && (yield* runRaw("magick", lib.ocrScaleArgs(files.raw, files.plain), env)).ok
        const plainFile = scaled ? files.plain : files.raw
        const lightOk = onPath("magick") && (yield* runRaw("magick", lib.ocrLightArgs(plainFile, files.light), env)).ok
        const [plain, light] = yield* Effect.all(
          [runRaw("tesseract", lib.tesseractArgs(plainFile), env), lightOk ? runRaw("tesseract", lib.tesseractArgs(files.light), env) : Effect.succeed({ ok: false, stdout: "" } as Ran)],
          { concurrency: 2 },
        )
        if (!plain.ok) return yield* failure("Reading the screen (tesseract) failed: " + brief(plain.error), plain.error)
        const scale = scaled ? lib.OCR_SCALE : 1
        return lib.ocrLines(lib.mergeOcrWords(lib.parseOcrTsv(plain.stdout, scale), light.ok ? lib.parseOcrTsv(light.stdout, scale) : []))
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const file of Object.values(files))
              try {
                unlinkSync(file)
              } catch {}
          }),
        ),
      )
    })
  // A window's box, to keep label matches and text listings inside it.
  const windowBox = (plan: lib.WinPlan) =>
    Effect.gen(function* () {
      if (!plan.window) return undefined
      const geometry = (yield* resolveWindow(plan.window)).geometry
      return geometry ? { left: geometry.x, top: geometry.y, width: geometry.w, height: geometry.h } : undefined
    })
  const inside = (box: lib.Box | undefined) => (line: lib.OcrWord[]) => {
    if (!box) return true
    const around = lib.union(line)
    const x = around.left + around.width / 2
    const y = around.top + around.height / 2
    return x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height
  }
  const quote = (text: string) => `“${text}”`

  // One op; returns a short line saying what happened.
  const runPlan = (requested: lib.WinPlan) =>
    Effect.gen(function* () {
      let plan = requested
      if (plan.op === "find") {
        const box = yield* windowBox(plan)
        const lines = (yield* ocrScreen()).filter(inside(box))
        if (!plan.label) return `Visible text${box ? " in that window" : ""} (center x,y in screen pixels; click with label or these x/y):\n${lib.formatText(lines) || "(none readable)"}`
        const matches = lib.matchLabel(lines, plan.label, box)
        if (!matches.length) return `No visible text matches ${quote(plan.label)}${box ? " in that window" : ""}. Visible text:\n${lib.formatText(lines, 60) || "(none readable)"}`
        return `${quote(plan.label)}: ${matches.map((match, index) => `${index + 1}. ${quote(match.text)} at ${match.x},${match.y}`).join("; ")}`
      }
      if (plan.op === "wait" && plan.label) {
        const box = yield* windowBox(plan)
        const started = Date.now()
        for (;;) {
          const lines = yield* ocrScreen()
          const match = lib.matchLabel(lines, plan.label, box)[0]
          if (match) return `found ${quote(match.text)} at ${match.x},${match.y} after ${((Date.now() - started) / 1000).toFixed(1)}s`
          if (Date.now() - started >= plan.timeout * 1000)
            return yield* failure(`${quote(plan.label)} did not appear within ${plan.timeout}s. Visible text now:\n${lib.formatText(lines.filter(inside(box)), 60) || "(none readable)"}`)
          yield* Effect.sleep(300)
        }
      }
      // label: find the text, then act on its center in screen pixels, as if x/y had been given.
      let found = ""
      if (plan.label) {
        const box = yield* windowBox(plan)
        const lines = yield* ocrScreen()
        const matches = lib.matchLabel(lines, plan.label, box)
        const match = matches[plan.nth - 1]
        if (!match)
          return yield* failure(
            matches.length
              ? `${quote(plan.label)} matches ${matches.length} place${matches.length === 1 ? "" : "s"}, so there is no #${plan.nth}: ${matches.map((item) => `${quote(item.text)} ${item.x},${item.y}`).join("; ")}.`
              : `No visible text matches ${quote(plan.label)}${box ? " in that window" : ""}. Visible text (center x,y):\n${lib.formatText(lines.filter(inside(box)), 60) || "(none readable)"}`,
          )
        const others = matches.filter((item) => item !== match).slice(0, 3)
        found = ` → ${quote(match.text)} at ${match.x},${match.y}${others.length ? ` (others: ${others.map((item) => `${quote(item.text)} ${item.x},${item.y}`).join(", ")}; nth picks one)` : ""}`
        plan = { ...plan, window: "", label: undefined, x: match.x, y: match.y }
      }
      if (plan.op === "list") {
        const all = yield* listWindows(plan.window)
        if (all.length) return `Windows${plan.window ? ` matching ${JSON.stringify(plan.window)}` : ""} (id: title | class | WxH+X+Y):\n${lib.formatWindowList(all)}`
        return plan.window ? `No visible window matches ${JSON.stringify(plan.window)}.` : `No windows on ${display} yet; exec a program first.`
      }
      if (plan.op === "wait") {
        const { found, after } = yield* waitWindow(plan)
        return `found ${lib.formatWindowList([found])} after ${(after / 1000).toFixed(1)}s`
      }
      if (plan.op === "sleep") {
        yield* Effect.sleep(plan.ms ?? 500)
        return `slept ${plan.ms}ms`
      }
      const target = plan.window ? yield* resolveWindow(plan.window) : undefined
      const origin = target?.geometry ? { x: target.geometry.x, y: target.geometry.y } : { x: 0, y: 0 }
      // Realistic: glide from where the pointer really is, at human pace. Otherwise straight to the target.
      const human = realistic()
      const from = human ? lib.parsePointer((yield* runRaw("xdotool", ["getmouselocation", "--shell"], env)).stdout) : undefined
      const mode: lib.InputMode = { managed: managed(), ...(human && from ? { human: { from, origin } } : {}) }
      const args = lib.winArgs(plan, target?.id, mode)
      const glide = args.filter((arg) => arg === lib.GLIDE_STEP).length * 12
      const where = lib.screenPoint(plan, origin)
      emit({
        kind: "action",
        op: plan.op,
        caption: lib.caption(requested, target?.title),
        at: where.at ?? (plan.op === "click" || plan.op === "scroll" || plan.op === "mousedown" ? from : undefined),
        to: where.to,
        button: plan.button,
        ...(plan.op === "type" ? { text: plan.text, charDelay: mode.human && plan.text!.length <= 400 ? 38 : 12 } : {}),
        ...(plan.keys ? { keys: plan.keys.join(" ") } : {}),
        delay: mode.human ? glide + 70 : 0,
      })
      const typing = plan.op === "type" ? (plan.text?.length ?? 0) * (mode.human ? 45 : 25) : 0
      yield* xdo(args, 30_000 + typing + glide).pipe(
        Effect.mapError((error) =>
          missing(error) ? failure("xdotool is not installed (the xdotool package); window control and input need it.", error) : failure(`${lib.describePlan(requested)}${found} failed: ${brief(error)}`, error),
        ),
      )
      const after = lib.focusAfterArgs(plan, target?.id, mode)
      if (after) yield* xdo(after).pipe(Effect.ignore)
      return `${lib.describePlan(requested)}${found}${target && target.id !== plan.window ? ` (window ${target.id})` : ""}`
    })
  return { listWindows, windowsText, screenText, resolveWindow, runPlan }
}

export const Plugin = define({
  id: "infiniteoc.agent-display",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const permission = yield* Permission.Service
    const directory = String(ctx.location.directory)
    const toast = (title: string, text: string) =>
      bus.publish(TuiEvent.ToastShow, { title, message: text, variant: "info", duration: 8000 }).pipe(Effect.ignore)
    // `save` is what "always allow" remembers: a pattern, so one approval covers the agent's later
    // input on its own screen instead of asking again for every new coordinate.
    const assertShell = (resource: string, save: string, context: any, what: string) =>
      permission
        .assert({
          action: "shell",
          resources: [resource],
          save: [save],
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
        const screen = screenOf(display)
        // exec/win/steps with screenshot: true hand the screen back in the same call.
        const reply = (text: string, settle = 300) =>
          Effect.gen(function* () {
            if (input.screenshot !== true) return { content: text }
            yield* Effect.sleep(settle)
            emit({ kind: "screenshot", caption: "Looking at the screen" })
            const frame = yield* captureFrame(display)
            return { content: frameContent(`${text}\n\n${yield* screen.screenText()}`, frame.base64) }
          })
        const assertInput = (plans: lib.WinPlan[]) => {
          const acting = plans.filter((plan) => !lib.LOOK_OPS.includes(plan.op))
          if (!acting.length) return Effect.void
          const summary = acting.map(lib.describePlan).join("; ")
          return assertShell(`agent display input ${summary.length > 400 ? `${summary.slice(0, 399)}…` : summary}`, "agent display input *", context, "Agent display input")
        }

        if (input.action === "status") {
          const status = lib.sweepStatus(lib.readStatus())
          lib.writeStatus(status)
          const windows = status.running ? yield* screen.windowsText().pipe(Effect.orElseSucceed(() => "")) : ""
          return { content: `${lib.describeStatus(status)}${windows ? `\n${windows}` : ""}` }
        }
        if (input.action === "start") {
          const status = yield* startDisplay(display)
          return { content: `Agent display ${display} running (pid ${status.pid}, ${lib.WIDTH}x${lib.HEIGHT}). Start programs with { action: "exec", command }.` }
        }
        if (input.action === "stop") {
          yield* stopStream()
          const status = lib.sweepStatus(lib.readStatus())
          // SIGINT lets ffmpeg finish the recording's file before its screen goes away.
          if (status.recording) {
            try {
              process.kill(status.recording.pid, "SIGINT")
            } catch {}
            yield* Effect.sleep(800)
          }
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
          yield* assertShell(`agent display live view on ${display}`, "agent display live view *", context, "Agent display stream")
          yield* startDisplay(display)
          const view = yield* startStream(display)
          return {
            content: `Live view of ${display} on this machine only: http://${lib.streamHost}:${view.port}/ (~${lib.streamRate}fps, with what you do captioned; /?clean is just the screen, for screen sharing); stop ends it.`,
          }
        }
        if (input.action === "exec") {
          const parsed = lib.validateExec({ command: input.command, args: input.args, env: input.env })
          if ("error" in parsed) return yield* failure(parsed.error)
          const wait = input.timeout === undefined ? 10 : input.timeout
          if (!Number.isInteger(wait) || wait < 0 || wait > 25) return yield* failure("exec timeout must be an integer 0-25 (seconds to wait for a window; 0 skips).")
          const full = `${parsed.command} ${parsed.args.join(" ")}`.trim()
          yield* assertShell(full, `${parsed.command} *`, context, "Agent display exec")
          yield* startDisplay(display)
          emit({ kind: "exec", caption: `Opening ${path.basename(parsed.command)}` })
          const before = new Set((yield* screen.listWindows().pipe(Effect.orElseSucceed(() => [] as lib.WindowInfo[]))).map((info) => info.id))
          const log = lib.appLog(process.pid)
          const child = yield* Effect.try({
            try: () => {
              const fd = openSync(log, "a")
              try {
                return spawn(parsed.command, parsed.args, {
                  cwd: directory,
                  env: { ...desktop.CURSOR, ...lib.appEnv(display), ...parsed.env },
                  detached: true,
                  stdio: ["ignore", fd, fd],
                })
              } finally {
                closeSync(fd)
              }
            },
            catch: (error) => failure(`Could not spawn ${parsed.command}: ` + message(error), error),
          })
          let exit: string | undefined
          let spawnError: Error | undefined
          child.once("exit", (code, signal) => void (exit = code === null ? `signal ${signal}` : `code ${code}`))
          child.once("error", (error) => void (spawnError = error))
          child.unref()
          const pid = child.pid
          if (pid !== undefined) {
            const status = lib.sweepStatus(lib.readStatus())
            lib.writeStatus({ ...status, display, running: true, apps: [...status.apps, { pid, command: full, startedAt: Date.now(), log }].slice(-20) })
          }
          const tail = () =>
            Effect.promise(() => readFile(log, "utf8").catch(() => "")).pipe(Effect.map((text) => (lib.logTail(text) ? `\nLast log lines (${log}):\n${lib.logTail(text)}` : `\nLog: ${log} (empty)`)))
          const started = Date.now()
          let fresh: lib.WindowInfo[] = []
          let exitedAt: number | undefined
          while (wait > 0 && Date.now() - started < wait * 1000) {
            yield* Effect.sleep(200)
            if (spawnError) break
            fresh = (yield* screen.listWindows()).filter((info) => !before.has(info.id))
            if (fresh.length) break
            if (exit !== undefined) {
              // A launcher that hands off to a running instance exits 0; its window may still come. A crash will not.
              if (exit !== "code 0") break
              exitedAt ??= Date.now()
              if (Date.now() - exitedAt > 3000) break
            }
          }
          if (spawnError) return yield* failure(`Could not start ${parsed.command}: ${missing(spawnError) ? "not found on PATH" : spawnError.message}`, spawnError)
          if (fresh.length) {
            // Let the first frame settle so the geometry is the real one, not the initial map size.
            yield* Effect.sleep(300)
            const settled = (yield* screen.listWindows()).filter((info) => !before.has(info.id))
            const windows = settled.length ? settled : fresh
            const handoff = exit !== undefined ? ` The process exited (${exit}); the window belongs to an instance that was already running.` : ""
            return yield* reply(
              `Started ${full} on ${display} (pid ${pid}). New window${windows.length > 1 ? "s" : ""} after ${((Date.now() - started) / 1000).toFixed(1)}s (id: title | class | WxH+X+Y):\n${lib.formatWindowList(windows)}${handoff}\nOutput: ${log}`,
            )
          }
          if (exit !== undefined && exit !== "code 0") return yield* failure(`${full} exited (${exit}) on ${display} before showing a window.${yield* tail()}`)
          if (wait === 0) return yield* reply(`Started ${full} on ${display} (pid ${pid}); not waiting for a window. Output: ${log}`)
          return yield* reply(
            `Started ${full} on ${display} (pid ${pid}${exit ? `, exited ${exit}` : ", still running"}), but no new window appeared within ${wait}s; it may be slow or windowless (wait op, or exec timeout up to 25).${yield* tail()}`,
          )
        }
        if (input.action === "kill") {
          const parsed = lib.validateKill({ pid: input.pid })
          if ("error" in parsed) return yield* failure(parsed.error)
          yield* assertShell(`agent display kill pid ${parsed.pid} on ${display}`, "agent display kill *", context, "Agent display kill")
          const status = lib.sweepStatus(lib.readStatus())
          const target = status.apps.find((app) => app.pid === parsed.pid)
          if (!target) return yield* failure(`No tracked app with pid ${parsed.pid} on ${display} (status shows current Apps).`)
          try {
            process.kill(parsed.pid, "SIGTERM")
          } catch {
            // Already gone; still prune it below.
          }
          yield* Effect.sleep(500)
          const alive = lib.pidAlive(parsed.pid)
          lib.writeStatus({ ...status, apps: status.apps.filter((app) => app.pid !== parsed.pid) })
          return {
            content: alive
              ? `Signalled pid ${parsed.pid} (${target.command}) but it is still alive; its output is in ${target.log}. Removed from Apps.`
              : `Killed pid ${parsed.pid} (${target.command}); removed from Apps.`,
          }
        }
        if (input.action === "win" || input.action === "steps") {
          const plans =
            input.action === "steps"
              ? lib.validateSteps(input.steps)
              : (() => {
                  const plan = lib.validateWin(input)
                  return "error" in plan ? plan : [plan]
                })()
          if ("error" in plans) return yield* failure(plans.error)
          yield* assertInput(plans)
          yield* startDisplay(display)
          if (input.action === "win") return yield* reply(yield* screen.runPlan(plans[0]), 250)
          const done: string[] = []
          for (const [index, plan] of plans.entries()) {
            // Realistic: a beat between actions, so each one reads before the next starts.
            if (index && realistic() && !lib.LOOK_OPS.includes(plan.op)) yield* Effect.sleep(220)
            const line = yield* screen.runPlan(plan).pipe(
              Effect.mapError((error) =>
                failure(`Step ${index + 1} of ${plans.length} failed: ${message(error)}${done.length ? `\nDone before it:\n${done.join("\n")}` : "\nNothing ran before it."}`, error),
              ),
            )
            done.push(`${index + 1}. ${line}`)
          }
          return yield* reply(`Ran ${plans.length} step${plans.length === 1 ? "" : "s"} on ${display}:\n${done.join("\n")}`, 250)
        }
        // screenshot and show: the whole screen, or one window (id or fragment); show also toasts the user.
        yield* startDisplay(display)
        let target: lib.WindowInfo | undefined
        if (input.window !== undefined) {
          const fragment = typeof input.window === "string" ? input.window.trim() : ""
          if (!fragment || fragment.length > 200 || fragment.includes("\0")) return yield* failure("screenshot/show window needs a window id or title fragment (list shows them).")
          target = yield* screen.resolveWindow(fragment)
        }
        emit({ kind: "screenshot", caption: input.action === "show" ? `Showing you the screen${input.note ? `: ${input.note}` : ""}` : "Looking at the screen" })
        const frame = yield* captureFrame(display, target?.id)
        const about = target
          ? `Window ${lib.formatWindowList([target])}: with window "${target.id}", x/y are this image's pixels.`
          : yield* screen.screenText()
        if (input.action === "show") {
          const status = lib.sweepStatus(lib.readStatus())
          lib.writeStatus({ ...status, showRequestedAt: Date.now(), ...(input.note ? { showNote: input.note } : {}) })
          let liveUrl = ""
          if (input.live === true) {
            yield* assertShell(`agent display live view on ${display}`, "agent display live view *", context, "Agent display live view")
            const view = yield* startStream(display)
            liveUrl = ` Live: http://${lib.streamHost}:${view.port}/ (this machine only).`
            yield* Effect.tryPromise({
              try: () =>
                new Promise<void>((resolve) => {
                  const viewer = spawn("xdg-open", [`http://${lib.streamHost}:${view.port}/`], {
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
          yield* toast("Agent display", `The agent shared its screen${input.note ? `: ${input.note}` : ""}.${liveUrl ? " Live view opened." : ""} The frame is in the transcript; <leader>i views images.`)
          return { content: frameContent(`Shared with the user (they were notified)${input.note ? `: ${input.note}` : ""}.${liveUrl}\n${about}`, frame.base64) }
        }
        return { content: frameContent(about, frame.base64) }
      }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : failure(message(error), error))))

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: TOOL,
          options: { codemode: false, permission: "agent_display" },
          description: [
            "Your own isolated screen (Xvfb, 1280x800, never the user's display): a small desktop (openbox title bars, taskbar in the bottom 36px) where you run GUI programs, drive them like a user and look at them.",
            'Fast loop: exec starts a program and waits for its window (returns id and geometry); steps runs many ops in one call; screenshot: true on exec/win/steps returns the screen in the same call. Example: { action: "steps", steps: [{ op: "click", label: "Search" }, { op: "type", text: "cats" }, { op: "key", keys: "Return" }, { op: "wait", label: "Images" }], screenshot: true }.',
            'Click text by its label, not by guessing pixels: { op: "click", label: "Consent" } reads the screen (OCR, ~1s) and clicks the center of that text; standalone text (a button, a link) beats the same word in a sentence, nth picks another match. find lists visible text with x,y (cheaper than a screenshot); wait with label waits for text to appear. Use x/y for things without text (icons, canvas, games).',
            "Coordinates: without window, x/y are screen pixels, the pixels of a full screenshot. With window (id or title/class fragment), x/y are relative to that window, the pixels of a screenshot of it.",
            'Ops: click (label or x/y, button, count 2 = double), find (visible text and where), mousedown, mouseup, mousemove, scroll (button 4 up / 5 down / 6 left / 7 right, count), drag (x,y to x2,y2), type (text), key (keys like "ctrl+l" or "ctrl+a BackSpace", count), keydown, keyup, focus, move, resize, close, list, wait (until a window appears), sleep (ms).',
            "Input is real (XTEST): a click hits whatever is on top at that point and moves keyboard focus there; type/key go to the focused window, or focus window first when given.",
            "Also: status (apps and windows), screenshot/show (window captures one window; show tells the user), kill (pid from status), stream (live watch page on 127.0.0.1 for the user), start/stop. exec, kill, stream and input ops ask through the normal shell permission. Screenshots cost image tokens.",
            "Chromium: pass --ozone-platform=x11 and a fresh --user-data-dir per spawn, or it picks Wayland or reuses another instance. Read the frame before describing the screen; the live page is for the user to watch, not for you.",
          ].join("\n"),
          input: Input,
          execute,
        })
      })
      .pipe(Effect.orDie)
  }),
})
