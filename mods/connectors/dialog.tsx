// /apps: the connector catalog inside the TUI. Written to packages/tui/src/component/dialog-apps.tsx by
// mods/connectors and registered next to upstream's /mcps (a source patch, not a live feature command: it renders
// upstream components, which live ctx-only handlers cannot import). Adding a connector writes the OpenCode config (persistent) and also connects it at once
// through the server's MCP API; OAuth apps go straight to upstream's own sign-in (DialogIntegration), the same
// flow /mcps uses. Removing one deletes it from the config and stops it. Sessions are never touched.
import { createMemo, createSignal, onMount } from "solid-js"
import type { McpServer } from "@opencode/client"
import { useData } from "../context/data"
import { useClient } from "../context/client"
import { useLocation } from "../context/location"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogIntegration } from "./dialog-integration"
import { SecretPrompt } from "./dialog-infiniteoc"
import { CATEGORIES, connect, connectorStatus, disconnect, findConnector, resolve } from "./connectors-lib.mjs"

type Row = Awaited<ReturnType<typeof connectorStatus>>[number]
type Var = { name: string; help: string; secret?: boolean; optional?: boolean; arg?: boolean }
// The catalog is plain JS; this is the shape every entry shares.
const entry = (id: string) => findConnector(id) as { vars?: Var[]; auth?: string } | undefined

const live = (status: McpServer["status"] | undefined) =>
  !status ? undefined
    : status.status === "connected" ? "Connected ✓"
    : status.status === "needs_auth" ? "Sign in required →"
    : status.status === "failed" ? "Failed !"
    : status.status === "pending" ? "Connecting …"
    : "Disabled ○"

export function DialogApps(props: { notice?: string; focus?: string } = {}) {
  const data = useData()
  const client = useClient()
  const location = useLocation()
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const current = () => location.ref ?? data.location.default()
  const servers = createMemo(() => data.location.mcp.server.list(current()) ?? [])
  const server = (id: string) => servers().find((item) => item.name === id)
  const [rows, setRows] = createSignal<Row[]>([])
  const [error, setError] = createSignal("")
  const reload = () => connectorStatus().then(setRows, (e) => setError(e instanceof Error ? e.message : String(e)))
  onMount(() => {
    // Wide enough for each app's description and its status.
    dialog.setSize("large")
    void reload()
  })

  // Promise-style steps on top of the dialog stack; Esc (onClose) resolves undefined.
  const step = <T,>(render: (done: (value: T | undefined) => void) => any, size?: "medium" | "large") =>
    new Promise<T | undefined>((resolveStep) => {
      let settled = false
      const done = (value: T | undefined) => { if (!settled) { settled = true; resolveStep(value) } }
      dialog.replace(() => render(done), () => done(undefined), size ? { size } : undefined)
    })
  const back = (notice?: string, focus?: string) => dialog.replace(() => <DialogApps notice={notice} focus={focus} />)
  const choose = (title: string, options: { title: string; value: string; description?: string }[]) =>
    step<string>((done) => <DialogSelect title={title} options={options} onSelect={(option) => done(option.value as string)} />)

  /** Asks for one variable; returns the typed value, "" to use the environment or skip, undefined on Esc. */
  async function ask(row: Row, item: Var, index: number, total: number): Promise<string | undefined> {
    const title = `${row.name} · ${index}/${total} ${item.name}`
    const fromEnv = process.env[item.name] ? `Use $${item.name} from the environment (set)` : `Read $${item.name} from the environment (set it before the next start)`
    if (item.secret) {
      const how = await choose(title, [
        { title: "Type or paste it (masked)", value: "type", description: "Stored in a mode-600 key file, never in opencode.json" },
        ...(item.optional ? [{ title: "Skip", value: "skip" }] : [{ title: fromEnv, value: "env" }]),
      ])
      if (how === undefined) return undefined
      if (how !== "type") return ""
      return step<string>((done) => <SecretPrompt title={title} note={`${item.help}. Masked; stored in a local mode-600 key file.`} busy={false} error="" onConfirm={done} onCancel={() => done(undefined)} />, "large")
    }
    return step<string>((done) => (
      <DialogPrompt
        title={title}
        description={() => <text fg={theme.text.muted}>{`${item.help}. ${item.optional ? "Empty skips it." : `Empty reads $${item.name} from the environment.`}`}</text>}
        value={process.env[item.name] ?? ""}
        onConfirm={(value) => done(value)}
        onCancel={() => done(undefined)}
      />
    ))
  }

  async function add(row: Row, force = false) {
    const vars = entry(row.id)?.vars ?? []
    const values: Record<string, string> = {}
    for (const [index, item] of vars.entries()) {
      const value = await ask(row, item, index + 1, vars.length)
      if (value === undefined) return back(undefined, row.id)
      values[item.name] = value
    }
    try {
      const result = await connect(row.id, { values, force })
      // The config file holds {env:}/{file:} references; the runtime API needs the resolved values.
      const config = await resolve(result.server)
      const unset = vars.filter((item) => !item.optional && !values[item.name] && !process.env[item.name]).map((item) => item.name)
      if (unset.length) return back(`${row.name} added. Set ${unset.join(", ")} and restart InfiniteOC to start it.`, row.id)
      await client.api.mcp.add({ server: row.id, location: { directory: current().directory }, config })
      if (entry(row.id)?.auth === "oauth") return signIn(row)
      back(`${row.name} added${result.next.length ? `: ${result.next.filter((line: string) => !line.startsWith("Sign in")).join(" · ")}` : ""}`, row.id)
    } catch (e) {
      back(`Could not add ${row.name}: ${e instanceof Error ? e.message : String(e)}`, row.id)
    }
  }

  /** Waits briefly for the server to report its state, then opens upstream's OAuth sign-in for it. */
  async function signIn(row: Row) {
    for (let i = 0; i < 40 && !server(row.id)?.integrationID; i++) await new Promise((r) => setTimeout(r, 250))
    const integrationID = server(row.id)?.integrationID
    if (!integrationID) return back(`${row.name} added. Sign in with /mcps once it reports "Sign in required".`, row.id)
    dialog.replace(() => <DialogIntegration integrationID={integrationID} autoConnect onConnected={() => back(`Signed in to ${row.name}`, row.id)} />)
  }

  async function manage(row: Row) {
    const status = server(row.id)?.status.status
    const action = await choose(row.name, [
      ...(status === "needs_auth" ? [{ title: "Sign in", value: "signin" }] : []),
      ...(status && status !== "connected" ? [{ title: "Retry connection", value: "retry" }] : []),
      ...(status === "connected" ? [{ title: "Pause until restart", value: "pause", description: "Disconnect now; it starts again next launch" }] : []),
      { title: "Replace its settings", value: "replace", description: "Enter its values again" },
      { title: "Remove", value: "remove", description: "Delete it from opencode.json and stop it" },
    ])
    const where = { directory: current().directory }
    try {
      if (action === "signin") return signIn(row)
      if (action === "retry") { await client.api.mcp.connect({ server: row.id, location: where }); return back(`Reconnecting ${row.name}`, row.id) }
      if (action === "pause") { await client.api.mcp.disconnect({ server: row.id, location: where }); return back(`${row.name} paused until restart`, row.id) }
      if (action === "replace") return add(row, true)
      if (action === "remove") {
        const sure = await choose(`Remove ${row.name}?`, [{ title: "Remove", value: "yes" }, { title: "Keep", value: "no" }])
        if (sure !== "yes") return back(undefined, row.id)
        await disconnect(row.id)
        await client.api.mcp.remove({ server: row.id, location: where }).catch(() => {})
        return back(`${row.name} removed`, row.id)
      }
    } catch (e) {
      return back(`${row.name}: ${e instanceof Error ? e.message : String(e)}`, row.id)
    }
    back(undefined, row.id)
  }

  const options = createMemo(() => {
    const order = new Map(CATEGORIES.map((name: string, index: number) => [name, index]))
    return [...rows()]
      .sort((a, b) => Number(b.connected) - Number(a.connected) || (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99))
      .map((row) => {
        const status = server(row.id)?.status
        const footer = live(status) ?? (row.connected ? (row.missing.length ? `needs ${row.missing.join(", ")}` : "added · restart") : row.unsupported ?? "")
        return {
          title: row.name,
          value: row.id,
          description: row.description,
          category: row.connected ? "Connected" : row.category,
          searchText: `${row.id} ${row.name} ${row.category} ${row.description}`,
          footer,
          footerColor: status?.status === "connected" ? theme.text.feedback.success.base
            : status?.status === "failed" ? theme.text.feedback.error.base
            : status?.status === "needs_auth" || row.missing.length ? theme.text.feedback.warning.base
            : theme.text.muted,
        }
      })
  })

  return (
    <DialogSelect
      title="Apps"
      placeholder="Search apps"
      options={options()}
      focusTarget={props.focus}
      onSelect={(option) => {
        const row = rows().find((item) => item.id === option.value)
        if (!row) return
        if (server(row.id)?.status.status === "needs_auth") return void signIn(row)
        void (row.connected ? manage(row) : add(row))
      }}
      footer={<text fg={error() ? theme.text.feedback.error.base : theme.text.muted}>{error() || props.notice || "enter adds or manages · tools appear to the agent at once · secrets never go into opencode.json"}</text>}
    />
  )
}
