import { readFile } from "node:fs/promises"

// Mod order: after mods/infiniteoc (settings dialog, internal plugin list) and, when enabled, mods/prov-kit
// (its model fallback stands down when this mod switched accounts) and mods/tstat-status (shared builtins anchor).
export function replace(source, before, after, label = before) {
  if (source.split(before).length !== 2) throw new Error(`accounts: expected one source anchor: ${label}`)
  return source.replace(before, () => after)
}

const read = (name) => readFile(new URL(name, import.meta.url), "utf8")
const system = "packages/tui/src/feature-plugins/system"
const auth = "packages/cli/src/commands/handlers/auth"

export const renameSpec = `        Spec.make("rename", {
          description: "rename a saved account",
          params: {
            ...ServerParams,
            target: Argument.string("target").pipe(
              Argument.withDescription("Integration ID or name"),
              Argument.optional,
            ),
            credential: Argument.string("credential").pipe(
              Argument.withDescription("Credential ID or label (opens an account picker when omitted)"),
              Argument.optional,
            ),
            name: Argument.string("name").pipe(
              Argument.withDescription("New account name (prompted when omitted)"),
              Argument.optional,
            ),
          },
        }),
`
const labelFlag = `
            label: Flag.string("label").pipe(
              Flag.withDescription("Name for the new account (default: the integration name, numbered)"),
              Flag.optional,
            ),`

export default {
  id: "accounts",
  version: "1.0.0",
  async setup(api) {
    const lib = await read("./accounts-lib.ts")

    // ---- server: opt-in switch to the next account on a rate limit or quota error ----
    await api.write("packages/core/src/plugin/infiniteoc-accounts-lib.ts", lib)
    await api.write("packages/core/src/plugin/infiniteoc-accounts.ts", await read("./plugin.ts"))
    await api.patch("packages/core/src/plugin/internal.ts", (source) => {
      source = replace(source, 'import { PlanPlugin } from "./plan.js"', 'import { PlanPlugin } from "./plan.js"\nimport * as InfiniteocAccounts from "./infiniteoc-accounts.js"')
      // Directly after PlanPlugin: before prov-kit's InfiniteocProv, whose retry hook must see the switch.
      return replace(source, "  PlanPlugin.Plugin,\n", "  PlanPlugin.Plugin,\n  InfiniteocAccounts.Plugin,\n")
    })
    const prov = "packages/core/src/plugin/infiniteoc-prov.ts"
    if (await api.read(prov).then(() => true, () => false))
      await api.patch(prov, (source) =>
        replace(source, "if (!backup || !event.decision.retry || !lib.failsOver(event.error)) return",
          "if (!backup || !event.decision.retry || !lib.failsOver(event.error) || (event as { accountRotated?: boolean }).accountRotated) return"))

    // ---- TUI: /account, footer label, InfiniteOC Settings → Accounts ----
    await api.write(`${system}/infiniteoc-accounts-lib.ts`, lib)
    await api.write(`${system}/infiniteoc-accounts-menu.ts`, await read("./menu.ts"))
    await api.write(`${system}/infiniteoc-accounts.tsx`, await read("./tui.tsx"))
    await api.patch("packages/tui/src/plugin/builtins.ts", (source) => {
      source = replace(source, 'import Notifications from "../feature-plugins/system/notifications"', 'import Notifications from "../feature-plugins/system/notifications"\nimport InfiniteocAccounts from "../feature-plugins/system/infiniteoc-accounts"')
      return replace(source, "  Notifications,\n", "  Notifications,\n  InfiniteocAccounts,\n")
    })
    await api.patch("packages/tui/src/component/dialog-infiniteoc.tsx", (source) => {
      source = replace(source, 'from "./settings-store"\n', 'from "./settings-store"\nimport { accountsMenu } from "../feature-plugins/system/infiniteoc-accounts-menu"\n')
      source = replace(source, '      { title: "Updates", value: "updates",', '      { title: "Accounts", value: "accounts", description: "Active account per provider; add, rename, remove", footer: "/account" },\n      { title: "Updates", value: "updates",')
      return replace(source, '    if (option.value === "updates") updates()\n', '    if (option.value === "updates") updates()\n    if (option.value === "accounts") accountsMenu.open?.()\n')
    })
    await api.patch("packages/tui/src/component/dialog-config.tsx", (source) =>
      replace(source, 'keywords: ["proxy", "tor", "provider", "api key"]', 'keywords: ["proxy", "tor", "provider", "api key", "account"]'))

    // ---- CLI: auth rename, auth login --label, active marker in auth list ----
    await api.write(`${auth}/rename.ts`, await read("./cli-rename.ts"))
    await api.patch("packages/cli/src/commands/commands.ts", (source) => {
      source = replace(source, '        Spec.make("switch", {\n', renameSpec + '        Spec.make("switch", {\n')
      const method = 'method: Flag.string("method").pipe(Flag.withDescription("Authentication method ID"), Flag.optional),'
      return replace(source, method, method + labelFlag)
    })
    await api.patch("packages/cli/src/index.ts", (source) =>
      replace(source, '    switch: () => import("./commands/handlers/auth/switch"),\n', '    switch: () => import("./commands/handlers/auth/switch"),\n    rename: () => import("./commands/handlers/auth/rename"),\n'))
    await api.patch(`${auth}/account.ts`, (source) =>
      replace(source, 'action: "log out" | "switch to",', 'action: "log out" | "switch to" | "rename",'))
    await api.patch(`${auth}/list.ts`, (source) => {
      source = replace(source, "    integration.connections.map((connection) => ({", "    integration.connections.map((connection, index) => ({")
      // Upstream sends requests with the first connection; mark it when there is a choice.
      return replace(source, '      type: connection.type === "credential" ? "stored" : "environment",',
        '      type: (connection.type === "credential" ? "stored" : "environment") + (index === 0 && integration.connections.length > 1 ? ", active" : ""),')
    })
    await api.patch(`${auth}/login.ts`, (source) => {
      source = replace(source, "      method: Option.getOrUndefined(input.method),\n", "      method: Option.getOrUndefined(input.method),\n      label: Option.getOrUndefined(input.label),\n")
      source = replace(source, "  method?: string\n  answer?: ReadonlyArray<string>\n", "  method?: string\n  label?: string\n  answer?: ReadonlyArray<string>\n")
      source = replace(source, "  yield* authenticate(client, integration, method, answer)\n", "  yield* authenticate(client, integration, method, answer, input.label)\n")
      source = replace(source, `  answer?: FormAnswer,
) {
  if (method.type === "key") return yield* keyLogin(client, integration, method, answer)
  if (method.type === "command") return yield* commandLogin(client, integration, method)
  return yield* oauthLogin(client, integration, method, answer)`, `  answer?: FormAnswer,
  label?: string,
) {
  if (method.type === "key") return yield* keyLogin(client, integration, method, answer, label)
  if (method.type === "command") return yield* commandLogin(client, integration, method, label)
  return yield* oauthLogin(client, integration, method, answer, label)`, "login authenticate")
      source = replace(source, "  answer?: FormAnswer,\n) {\n  const key = yield* secret(", "  answer?: FormAnswer,\n  label?: string,\n) {\n  const key = yield* secret(")
      source = replace(source, "client.integration.connect.key({ integrationID: integration.id, key, answer, location }, { signal })",
        "client.integration.connect.key({ integrationID: integration.id, key, answer, label, location }, { signal })")
      source = replace(source, '  method: Extract<ConnectMethod, { type: "command" }>,\n) {', '  method: Extract<ConnectMethod, { type: "command" }>,\n  label?: string,\n) {')
      return replace(source, "client.integration.command.connect({ integrationID: integration.id, methodID: method.id, location }, { signal })",
        "client.integration.command.connect({ integrationID: integration.id, methodID: method.id, label, location }, { signal })")
    })
  },
}
