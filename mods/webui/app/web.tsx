// InfiniteOC in the web UI: its features as commands (palette and slash), toasts the server sends to
// UIs (/ponytail, /goal, workflows, ...), and /yolo as upstream's auto-accept. Called once per session
// screen next to upstream's own command hooks. Written to packages/app/src/infiniteoc/web.tsx by mods/webui.
import { createResource, onCleanup } from "solid-js"
import { useDialog } from "@opencode/ui/context/dialog"
import { useCommand, type CommandOption } from "@/shell/commands/command"
import { useServerSDK } from "@/runtime/server/client"
import { showToast } from "@/shell/notifications/toast"
import { InfiniteocDialog } from "./dialog"
import { contract, type Feature, type Request, type View } from "./rpc"

// Several session screens can be mounted at once; each server toast is shown once.
const shown = new Set<string>()

export function useInfiniteocWeb(input: { sessionID: () => string | undefined; directory: () => string }) {
  const command = useCommand()
  const server = useServerSDK()
  const dialog = useDialog()
  const rpc = () => server.api.rpc(contract)

  onCleanup(
    server.event.on("tui.toast.show", (event) => {
      if (shown.has(event.id)) return
      shown.add(event.id)
      if (shown.size > 200) shown.delete(shown.values().next().value!)
      const { title, message, variant, duration } = event.data
      showToast({ title: title ?? "InfiniteOC", description: message, variant: variant === "error" ? "error" : variant === "success" ? "success" : "default", duration })
    }),
  )

  // An older server without the plugin answers with an error: no InfiniteOC commands, nothing breaks.
  const [features] = createResource(async () => JSON.parse(String(await rpc().features(""))) as Feature[], { initialValue: [] })

  const call = async (feature: string, action?: string, value?: string): Promise<View> => {
    const request: Request = { feature, action, value, sessionID: input.sessionID(), directory: input.directory() }
    return JSON.parse(String(await rpc().run(JSON.stringify(request)))) as View
  }

  command.register("infiniteoc", () => [
    ...(features.error ? [] : features()).map(
      (feature): CommandOption => ({
        id: `infiniteoc.${feature.id}`,
        title: feature.title,
        description: feature.description,
        category: "InfiniteOC",
        slash: feature.slash,
        disabled: feature.session && !input.sessionID(),
        onSelect: () => void dialog.show(() => <InfiniteocDialog title={feature.title} load={(action, value) => call(feature.id, action, value)} />),
      }),
    ),
    {
      id: "infiniteoc.yolo",
      title: "YOLO: auto-accept permissions",
      description: "Same as upstream's auto-accept toggle; deny rules and InfiniteOC safety gates still ask",
      category: "InfiniteOC",
      slash: "yolo",
      onSelect: () => command.trigger("permissions.autoaccept"),
    },
  ])
}
