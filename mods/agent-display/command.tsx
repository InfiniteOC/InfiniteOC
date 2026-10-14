import type { FeatureContext } from "./api"
import { describeStatus, frameFile, readStatus, sweepStatus, writeStatus } from "./agent-display-store"

// /display: the agent's isolated screen. Reads the status file the server plugin
// writes; stopping here only stops the virtual display, never user sessions.
export async function run(ctx: FeatureContext) {
  for (;;) {
    const status = sweepStatus(readStatus())
    const choice = await ctx.ui.select({
      title: `Agent display · ${status.display} · ${status.running ? "running" : "stopped"}`,
      options: [
        { title: "Status", value: "status", description: status.running ? `${status.apps.length} app${status.apps.length === 1 ? "" : "s"}` : "the virtual screen is stopped" },
        { title: "Latest frame", value: "frame", description: status.lastFrameAt ? new Date(status.lastFrameAt).toISOString() : "no screenshot yet (the agent takes one)" },
        ...(status.running ? [{ title: "Stop display", value: "stop", description: "Stops Xvfb and forgets spawned apps; user sessions keep going" }] : []),
      ],
    })
    if (!choice) return
    if (choice === "status") {
      await ctx.ui.alert({ title: `Agent display ${status.display}`, message: describeStatus(status) })
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
