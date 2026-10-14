import type { FeatureContext } from "./api"
import { describeStatus, frameFile, pidAlive, readSettings, readStatus, sweepStatus, writeSettings, writeStatus } from "./agent-display-store"

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
    if (choice === "frame") {
      const live = status.streamPort ? `\nLive: http://127.0.0.1:${status.streamPort}/ (this machine only)` : ""
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
