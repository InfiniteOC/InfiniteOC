import type { FeatureContext } from "./api"
import {
  CAMERA_LABEL,
  describeStatus,
  ensureCamera,
  findCamera,
  frameFile,
  loadCamera,
  pidAlive,
  readSettings,
  readStatus,
  recordArgs,
  recordingFile,
  spawnFfmpeg,
  sweepStatus,
  videosDir,
  writeSettings,
  writeStatus,
} from "./agent-display-store"
import { mkdirSync } from "node:fs"

// /display: the agent's isolated screen. Reads the status file the server plugin
// writes; stopping here only stops the virtual display, never user sessions.
export async function run(ctx: FeatureContext) {
  for (;;) {
    const status = sweepStatus(readStatus())
    const settings = readSettings()
    const choice = await ctx.ui.select({
      title: `Agent display · ${status.display} · ${status.running ? "running" : "stopped"}`,
      options: [
        { title: "Status", value: "status", description: status.running ? `${status.apps.length} app${status.apps.length === 1 ? "" : "s"}` : "the virtual screen is stopped" },
        { title: "Latest frame", value: "frame", description: status.lastFrameAt ? new Date(status.lastFrameAt).toISOString() : "no screenshot yet (the agent takes one)" },
        {
          title: `Realistic input: ${settings.realistic ? "on" : "off"}`,
          value: "realistic",
          description: settings.realistic
            ? "The pointer glides, typing is human speed, steps pause. Select to go back to instant input"
            : "Instant input. Select to make the agent move and type like a person (slower)",
        },
        {
          title: `Virtual camera: ${settings.camera ? "on" : "off"}`,
          value: "camera",
          description: settings.camera
            ? `“${CAMERA_LABEL}” shows the screen in Discord, OBS and browsers while the display runs. Select to turn off`
            : `Show the screen as a webcam (“${CAMERA_LABEL}”) for Discord, OBS, browsers`,
        },
        {
          title: status.recording ? "Stop recording" : "Record the screen",
          value: "record",
          description: status.recording
            ? `Recording since ${new Date(status.recording.startedAt).toLocaleTimeString()} to ${status.recording.file}`
            : status.running
              ? `MP4 in ${videosDir()}`
              : "the display is not running yet (it starts when the agent uses it)",
        },
        ...(status.apps.length
          ? [{ title: "Apps", value: "apps", description: status.apps.map((app) => `${app.command} (pid ${app.pid})`).join(", ") }]
          : []),
        ...(status.running ? [{ title: "Stop display", value: "stop", description: "Stops Xvfb and forgets spawned apps; user sessions keep going" }] : []),
      ],
    })
    if (!choice) return
    if (choice === "status") {
      await ctx.ui.alert({ title: `Agent display ${status.display}`, message: describeStatus(status) })
      continue
    }
    if (choice === "realistic") {
      // Applies from the agent's next action; the server reads it every time.
      try {
        writeSettings({ ...settings, realistic: !settings.realistic })
      } catch (error) {
        await ctx.ui.alert({ title: "Realistic input", message: `Could not save the setting: ${error instanceof Error ? error.message : String(error)}` })
      }
      continue
    }
    if (choice === "camera") {
      try {
        if (settings.camera) {
          writeSettings({ ...settings, camera: false })
          if (status.camera) {
            try {
              process.kill(status.camera.pid, "SIGTERM")
            } catch {}
            const next = { ...sweepStatus(readStatus()) }
            delete next.camera
            writeStatus(next)
          }
          ctx.toast.show({ variant: "success", title: "Agent display", message: "Virtual camera off." })
          continue
        }
        let device = findCamera()
        if (!device) {
          const load = await ctx.ui.confirm({
            title: "Virtual camera",
            message: `The camera needs the v4l2loopback kernel module, loaded as root once per boot. Load it now? Your desktop asks for your password (pkexec).`,
            label: { confirm: "Load it", cancel: "Not now" },
          })
          if (!load) continue
          const loaded = await loadCamera()
          if ("error" in loaded) {
            await ctx.ui.alert({ title: "Virtual camera", message: loaded.error })
            continue
          }
          device = loaded.device
        }
        writeSettings({ ...settings, camera: true })
        const next = ensureCamera(sweepStatus(readStatus()))
        writeStatus(next)
        await ctx.ui.alert({
          title: "Virtual camera on",
          message: `${device} is “${CAMERA_LABEL}”. In Discord: Settings → Voice & Video → Camera, or turn on your camera in a call. OBS: Video Capture Device. It shows the agent's screen (16:9, 30fps) ${next.camera ? "now" : "as soon as the display starts"}, and comes back whenever the display restarts.`,
        })
      } catch (error) {
        await ctx.ui.alert({ title: "Virtual camera", message: error instanceof Error ? error.message : String(error) })
      }
      continue
    }
    if (choice === "record") {
      try {
        if (status.recording) {
          // SIGINT lets ffmpeg finish the file.
          try {
            process.kill(status.recording.pid, "SIGINT")
          } catch {}
          const next = { ...sweepStatus(readStatus()) }
          delete next.recording
          writeStatus(next)
          const seconds = Math.round((Date.now() - status.recording.startedAt) / 1000)
          await ctx.ui.alert({ title: "Recording saved", message: `${status.recording.file}\n${Math.floor(seconds / 60)}m ${seconds % 60}s of the agent's screen.` })
          continue
        }
        if (!status.running) {
          await ctx.ui.alert({ title: "Record the screen", message: "The agent display is not running. It starts when the agent uses it; record then." })
          continue
        }
        const dir = videosDir()
        mkdirSync(dir, { recursive: true })
        const file = recordingFile(dir)
        const pid = spawnFfmpeg(recordArgs(status.display, file), status.display)
        if (!pid) {
          await ctx.ui.alert({ title: "Record the screen", message: "ffmpeg could not start (is it installed?)." })
          continue
        }
        writeStatus({ ...sweepStatus(readStatus()), recording: { pid, file, startedAt: Date.now() } })
        ctx.toast.show({ variant: "success", title: "Recording the agent's screen", message: `${file} · /display → Stop recording ends it.` })
      } catch (error) {
        await ctx.ui.alert({ title: "Record the screen", message: error instanceof Error ? error.message : String(error) })
      }
      continue
    }
    if (choice === "frame") {
      const live = status.streamPort
        ? `\nLive: http://127.0.0.1:${status.streamPort}/ (this machine only); http://127.0.0.1:${status.streamPort}/?clean is just the screen, for Discord Go Live or OBS`
        : ""
      const message = status.lastFrameAt
        ? `Taken ${new Date(status.lastFrameAt).toISOString()}${status.showNote ? `\nAgent note: ${status.showNote}` : ""}\nFile: ${status.framePath ?? frameFile()}${live}\nFrames the agent shares appear in the session transcript; <leader>i (View image attachments) opens them.`
        : `No frame yet. Ask the agent to share its screen (it uses show), or run something there first.${live}`
      await ctx.ui.alert({ title: "Latest frame", message })
      continue
    }
    if (choice === "apps") {
      const target = await ctx.ui.select({
        title: "Agent display · spawned apps",
        options: [
          ...status.apps.map((app) => ({
            title: `${app.command} (pid ${app.pid})`,
            value: String(app.pid),
            description: pidAlive(app.pid) ? `running since ${new Date(app.startedAt).toISOString()}; log ${app.log}` : "exited (pruned on next status read)",
          })),
        ],
      })
      if (!target) continue
      const app = status.apps.find((entry) => entry.pid === Number(target))
      if (!app) continue
      const ok = await ctx.ui.confirm({ title: "Kill app", message: `Stop ${app.command} (pid ${app.pid}) on ${status.display}?`, label: { confirm: "Kill it", cancel: "Keep it" } })
      if (!ok) continue
      try {
        try {
          process.kill(app.pid, "SIGTERM")
        } catch {}
        const next = sweepStatus(readStatus())
        writeStatus({ ...next, apps: next.apps.filter((entry) => entry.pid !== app.pid) })
        ctx.toast.show({ variant: "success", title: "Agent display", message: `App pid ${app.pid} stopped.` })
      } catch (error) {
        ctx.toast.show({ variant: "error", title: "/display failed", message: error instanceof Error ? error.message : String(error) })
      }
      continue
    }
    if (choice === "stop") {
      const ok = await ctx.ui.confirm({ title: "Stop agent display", message: `Stop the virtual screen ${status.display}? Spawned apps are forgotten; saved sessions and running tasks are untouched.`, label: { confirm: "Stop it", cancel: "Keep running" } })
      if (!ok) continue
      try {
        // A recording gets SIGINT first, so ffmpeg finishes the file before its screen goes away.
        if (status.recording) {
          try {
            process.kill(status.recording.pid, "SIGINT")
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 800))
        }
        if (status.pid) {
          try {
            process.kill(status.pid, "SIGTERM")
          } catch {}
        }
        writeStatus({ display: status.display, running: false, apps: [] })
        ctx.toast.show({ variant: "success", title: "Agent display", message: `Display ${status.display} stopped.` })
      } catch (error) {
        ctx.toast.show({ variant: "error", title: "/display failed", message: error instanceof Error ? error.message : String(error) })
      }
      return
    }
  }
}
