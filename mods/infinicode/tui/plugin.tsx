// InfiniCode: follows the selected effort. When it becomes the InfiniCode variant the theme fades to
// red and workflows turn on (through the workflows.enabled contract); when it is left both return.
// /infinicode toggles it and gives the model back the effort it had before.
// Written to packages/tui/src/feature-plugins/system/infiniteoc-infinicode.tsx and registered as a
// builtin by mods/infinicode. It never changes permissions, sessions or the user's theme choice.
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, untrack } from "solid-js"
import { setInfinicodeActive } from "../../theme/infinicode"
import { INFINICODE, strongestVariant } from "../../infiniteoc-features/infinicode-variant"
import { enter, leave, update } from "../../infiniteoc-features/infinicode-store"
import { workflowsAvailable } from "../../infiniteoc-features/infinicode-build"

type Selection = { readonly providerID: string; readonly modelID: string; readonly variant?: string }
const key = (model: Selection) => `${model.providerID}/${model.modelID}`

export default Plugin.define({
  id: "infiniteoc.infinicode",
  setup(context) {
    // The effort each model had before InfiniCode ("default" for none), so turning it off restores it.
    const [previous, setPrevious] = context.storage.store("previous", { initial: { variants: {} as Record<string, string> } })
    const toast = (message: string, variant: "info" | "warning" = "info") => context.ui.toast.show({ title: "InfiniCode", message, variant })

    const effort = () => {
      const strongest = strongestVariant(context.ui.model.variant.list().filter((id) => id !== INFINICODE).map((id) => ({ id })))
      return strongest ? `${strongest.id} effort` : "model default effort (no effort levels)"
    }

    const workflows = (active: boolean) => {
      if (!workflowsAvailable) return "workflows unavailable (workflows mod disabled)"
      try {
        const result = update(active ? enter : leave)
        if (active) return "workflows on"
        return result === undefined ? "workflows unchanged" : `workflows back to ${result === "default" ? "the default" : result}`
      } catch (error) {
        toast(`Workflows setting not changed: ${error instanceof Error ? error.message : String(error)}`, "warning")
        return active ? "workflows unchanged" : "workflows not restored"
      }
    }

    function toggle() {
      const model = context.ui.model.current()
      if (!model) return toast("Select a model first", "warning")
      if (model.variant === INFINICODE) {
        const before = previous.variants[key(model)]
        const restore = before && before !== "default" && context.ui.model.variant.list().includes(before) ? before : undefined
        context.ui.model.variant.set(restore)
        return
      }
      if (!context.ui.model.variant.set(INFINICODE)) toast("InfiniCode is not offered for this model yet; the model list is still loading", "warning")
    }

    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "infinicode.toggle",
              title: "Toggle InfiniCode (strongest effort, workflows, red theme)",
              group: "Agent",
              slash: { name: "infinicode" },
              palette: true,
              run: toggle,
            },
          ],
        }))

        let state: boolean | undefined
        let last: { key: string; variant: string } | undefined
        createEffect(() => {
          const model = context.ui.model.current()
          // No model yet (catalog still loading): keep the current state rather than leave.
          if (!model) return
          const active = model.variant === INFINICODE
          setInfinicodeActive(active)
          untrack(() => {
            const first = state === undefined
            if (active && last?.key === key(model)) {
              const before = last.variant
              void setPrevious((draft) => {
                draft.variants[key(model)] = before
              }).catch(() => {})
            }
            if (!active) last = { key: key(model), variant: model.variant ?? "default" }
            if (active === state) return
            state = active
            // At startup an inactive InfiniCode only restores what a crashed session left on.
            const summary = workflows(active)
            if (active) toast(`On · ${effort()} · ${summary} · red theme`)
            else if (!first) toast(`Off · ${summary}`)
          })
        })
        return null
      },
    })
  },
})
