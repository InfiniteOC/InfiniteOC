// InfiniteOC accounts TUI plugin: /account (switch, add, rename, remove, opt-in auto-switch) and the
// active account name in the prompt footer. Copied to packages/tui/src/feature-plugins/system/infiniteoc-accounts.tsx
// and registered as a builtin by mods/accounts. Secrets never reach this file: integration listings carry
// only credential IDs and names.
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, Show } from "solid-js"
import { DialogIntegration } from "../../component/dialog-integration"
import { loadSettings, saveSettings } from "../../component/settings-store"
import { useTheme } from "../../context/theme"
import { errorMessage } from "../../util/error"
import { accountsMenu } from "./infiniteoc-accounts-menu"
import {
  accountGroups,
  fallbackEnabled,
  footerAccount,
  groupSummary,
  integrationFor,
  validateLabel,
  withFallback,
  type ProviderAccounts,
} from "./infiniteoc-accounts-lib"

export default Plugin.define({
  id: "infiniteoc.accounts",
  setup(context) {
    const location = (sessionID?: string) => (sessionID && context.data.session.get(sessionID)?.location) || context.location
    const groups = () => accountGroups(context.data.location.integration.list(location()) ?? [])
    // Menus are snapshots: refresh after a change so the next one lists the result.
    const refresh = () => context.data.location.integration.sync(location()).catch(() => {})
    const fail =(error: unknown) => context.ui.toast.show({ variant: "error", title: "Accounts", message: errorMessage(error) })
    // Upstream's own connect flow: sign in, add another account, or re-authenticate one that expired.
    const connect = (integrationID?: string) =>
      context.ui.dialog.show(() =>
        integrationID ? <DialogIntegration integrationID={integrationID} autoConnect /> : <DialogIntegration />,
      )

    async function readFallback() {
      try {
        return fallbackEnabled(await loadSettings())
      } catch {
        return undefined // unreadable settings.json: shown as unknown, never overwritten from here
      }
    }

    async function menu() {
      for (;;) {
        const list = groups()
        const fallback = await readFallback()
        const choice = await context.ui.dialog.select<string>({
          title: "Accounts",
          options: [
            ...list.map((group) => ({
              title: group.name,
              value: `provider:${group.integrationID}`,
              footer: groupSummary(group),
              category: "Active account per provider",
            })),
            ...(list.length ? [] : [{ title: "No stored accounts yet", value: "connect", description: "Sign in to a provider first", category: "Active account per provider" }]),
            {
              title: `Auto-switch on rate limit: ${fallback === undefined ? "unknown" : fallback ? "on" : "off"}`,
              value: "fallback",
              description: fallback === undefined ? "settings.json is unreadable; fix it in /settings" : "On a 429 or quota error, retry on the provider's next account",
              category: "Options",
              disabled: fallback === undefined,
            },
            { title: "Connect a provider…", value: "connect", description: "Upstream sign-in; also adds accounts", category: "Options" },
          ],
        })
        if (!choice) return
        if (choice === "connect") return connect()
        if (choice === "fallback") {
          try {
            const settings = await loadSettings()
            await saveSettings(withFallback(settings, !fallbackEnabled(settings)))
          } catch (error) {
            fail(error)
            return
          }
          continue
        }
        const group = list.find((item) => `provider:${item.integrationID}` === choice)
        if (group && (await provider(group)) === "done") return
      }
    }

    // Returns "back" to show the provider list again, "done" to close.
    async function provider(initial: ProviderAccounts): Promise<"back" | "done"> {
      for (;;) {
        const group = groups().find((item) => item.integrationID === initial.integrationID)
        if (!group) return "back" // last account removed
        const choice = await context.ui.dialog.select<string>({
          title: `${group.name} accounts`,
          current: group.active?.id,
          options: [
            ...group.accounts.map((account) => ({
              title: account.label,
              value: `use:${account.id}`,
              footer: account.signIn ? "sign in required" : account.active ? "active" : undefined,
              category: "Use for new requests",
            })),
            { title: "Add another account…", value: "add", description: "Opens the provider's sign-in", category: "Manage" },
            { title: "Rename an account…", value: "rename", category: "Manage" },
            { title: "Remove an account…", value: "remove", description: "Deletes the stored login; sessions are kept", category: "Manage" },
          ],
        })
        if (!choice) return "back"
        if (choice === "add") {
          connect(group.integrationID)
          return "done"
        }
        if (choice === "rename" || choice === "remove") {
          const target = await context.ui.dialog.select<string>({
            title: choice === "rename" ? `Rename a ${group.name} account` : `Remove a ${group.name} account`,
            options: group.accounts.map((account) => ({ title: account.label, value: account.id, footer: account.active ? "active" : undefined })),
          })
          const account = group.accounts.find((item) => item.id === target)
          if (!account) continue
          if (choice === "rename") await rename(account.id, account.label)
          else await remove(group, account.id, account.label)
          await refresh()
          continue
        }
        const account = group.accounts.find((item) => `use:${item.id}` === choice)
        if (!account) continue
        if (account.signIn) {
          connect(group.integrationID)
          return "done"
        }
        if (!account.active) {
          try {
            await context.client.credential.activate({ credentialID: account.id })
          } catch (error) {
            fail(error)
            return "done"
          }
          void refresh()
        }
        context.ui.dialog.clear()
        context.ui.toast.show({
          variant: "success",
          title: "Accounts",
          message: account.active ? `${group.name} already uses "${account.label}"` : `${group.name} now uses "${account.label}" for new requests`,
        })
        return "done"
      }
    }

    async function rename(credentialID: string, current: string) {
      let value: string | undefined = current
      for (;;) {
        value = await context.ui.dialog.prompt({ title: "Rename account", description: "1-64 characters; shown in /account and the footer", value })
        if (value === undefined) return
        const checked = validateLabel(value)
        if ("error" in checked) {
          await context.ui.dialog.alert({ title: "Rename account", message: checked.error })
          continue
        }
        if (checked.label === current) return
        try {
          await context.client.credential.update({ credentialID, label: checked.label })
        } catch (error) {
          fail(error)
        }
        return
      }
    }

    async function remove(group: ProviderAccounts, credentialID: string, label: string) {
      const last = group.accounts.length === 1
      const ok = await context.ui.dialog.confirm({
        title: `Remove "${label}"?`,
        message: `Deletes this ${group.name} login from InfiniteOC's credential store. Sessions and other accounts are kept.${last ? ` It is the only ${group.name} account, so ${group.name} will be disconnected.` : ""} To use it again, sign in again.`,
        label: { confirm: "Remove", cancel: "Keep" },
      })
      if (!ok) return
      try {
        await context.client.credential.remove({ credentialID })
      } catch (error) {
        fail(error)
      }
    }

    const disposeMenu = (() => {
      const open = () => void menu().catch(fail)
      accountsMenu.open = open
      return () => {
        if (accountsMenu.open === open) accountsMenu.open = undefined
      }
    })()

    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "infiniteoc.accounts",
              title: "Switch account",
              description: "Active account per provider; add, rename or remove accounts",
              group: "Integration",
              palette: true,
              slash: { name: "account", aliases: ["accounts"] },
              run: () => accountsMenu.open?.(),
            },
          ],
        }))
        return null
      },
    })

    // Active account in the prompt footer, only when the current model's provider has several.
    context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => {
        const theme = useTheme()
        const label = createMemo(() => {
          if (!props.showDetails) return
          const model = context.ui.model.current()
          if (!model) return
          const where = location(props.sessionID)
          const integrationID = integrationFor(model.providerID, context.data.location.provider.list(where) ?? [])
          return footerAccount(accountGroups(context.data.location.integration.list(where) ?? []).find((group) => group.integrationID === integrationID))
        })
        return (
          <Show when={label()}>
            {(text) => (
              <box flexShrink={0} paddingLeft={1}>
                <text fg={theme.text.muted} wrapMode="none">
                  acct {text()}
                </text>
              </box>
            )}
          </Show>
        )
      },
    })

    return disposeMenu
  },
})
