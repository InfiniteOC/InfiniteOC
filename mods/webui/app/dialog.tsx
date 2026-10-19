// One dialog for every InfiniteOC feature: it renders the View the server returns and sends the next
// action (a selected item, a button, or the text field) back. Written to
// packages/app/src/infiniteoc/dialog.tsx by mods/webui.
import { createSignal, For, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { TextInput } from "@opencode/ui/text-input"
import { showToast } from "@/shell/notifications/toast"
import type { View } from "./rpc"

export function InfiniteocDialog(props: { title: string; load: (action?: string, value?: string) => Promise<View> }) {
  const [view, setView] = createSignal<View>()
  const [busy, setBusy] = createSignal(true)
  const [text, setText] = createSignal("")

  const go = async (action?: string, value?: string) => {
    setBusy(true)
    try {
      const next = await props.load(action || undefined, value)
      setView(next)
      setText(next.input?.value ?? "")
      if (next.toast) showToast({ title: next.title, description: next.toast.message, variant: next.toast.variant === "error" ? "error" : "success" })
    } catch (cause) {
      showToast({ title: props.title, description: cause instanceof Error ? cause.message : String(cause), variant: "error" })
    } finally {
      setBusy(false)
    }
  }
  void go()

  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitle>{view()?.title ?? props.title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div data-component="infiniteoc-dialog" class="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-3" aria-busy={busy()}>
          <Show when={view()?.text}>
            {(body) => <pre class="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-base p-3 text-12-regular text-text-base"
                style={{ "font-family": "var(--font-family-mono, ui-monospace, monospace)" }}>{body()}</pre>}
          </Show>
          <Show when={view()?.input}>
            {(input) => (
              <form
                class="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (text().trim()) void go(input().action, text())
                }}
              >
                <div class="min-w-0 flex-1">
                  <TextInput class="!w-full" placeholder={input().placeholder} value={text()} onInput={(event) => setText(event.currentTarget.value)} />
                </div>
                <Button type="submit" variant="neutral" disabled={busy() || !text().trim()}>
                  Add
                </Button>
              </form>
            )}
          </Show>
          <Show when={view()?.items?.length}>
            <ul class="flex min-h-0 flex-col overflow-y-auto" role="list">
              <For each={view()?.items}>
                {(item) => (
                  <li>
                    <button
                      type="button"
                      class="flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-surface-raised-base-hover focus-visible:bg-surface-raised-base-hover disabled:opacity-50"
                      disabled={busy()}
                      onClick={() => void go(item.id)}
                    >
                      <span class="min-w-0 flex-1 truncate text-14-regular text-text-strong">{item.title}</span>
                      <Show when={item.description}>
                        <span class="shrink-0 text-12-regular text-text-weak">{item.description}</span>
                      </Show>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={view()?.actions?.length}>
            <div class="flex flex-wrap justify-end gap-2">
              <For each={view()?.actions}>
                {(action) => (
                  <Button variant={action.id ? "neutral" : "ghost"} title={action.description} disabled={busy()} onClick={() => void go(action.id)}>
                    {action.title}
                  </Button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </DialogBody>
    </Dialog>
  )
}
