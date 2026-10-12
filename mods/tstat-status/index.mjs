import { readFile } from "node:fs/promises"

// Strict single-anchor replace: later mods keep the anchor text because every patch only inserts around it.
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`tstat-status: expected one source anchor: ${before}`)
  return source.replace(before, () => after)
}

const system = "packages/tui/src/feature-plugins/system"
const STATE = `from "./feature-plugins/system/tstat-state"`

export default {
  id: "tstat-status",
  version: "1.0.0",
  async setup(api) {
    const read = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")
    for (const name of ["tstat-logic.ts", "tstat-state.ts", "tstat-ui.tsx", "tstat.tsx"]) await api.write(`${system}/${name}`, await read(name))

    await api.patch("packages/tui/src/plugin/builtins.ts", (source) => {
      source = replace(source, 'import Notifications from "../feature-plugins/system/notifications"', 'import Notifications from "../feature-plugins/system/notifications"\nimport Tstat from "../feature-plugins/system/tstat"')
      return replace(source, "  Notifications,\n", "  Notifications,\n  Tstat,\n")
    })

    // Zen mode hides the tab strip; terminals that never report light/dark get it from OSC 11.
    await api.patch("packages/tui/src/app.tsx", (source) => {
      source = replace(source, 'import { registerOpencodeSpinner } from "./component/register-spinner"', `import { registerOpencodeSpinner } from "./component/register-spinner"\nimport { zen as tstatZen, detectMode as tstatDetectMode } ${STATE}`)
      source = replace(source, "  const tabsVisible = () => tabsAvailable() && !fullscreenPanel()", "  const tabsVisible = () => tabsAvailable() && !fullscreenPanel() && !tstatZen()")
      return replace(source, '(await renderer.waitForThemeMode(1000)) ?? "dark"', '(await renderer.waitForThemeMode(1000)) ?? (await tstatDetectMode(renderer)) ?? "dark"')
    })
    await api.patch("packages/tui/src/component/session-frame.tsx", (source) => {
      source = replace(source, 'import { PanelHost } from "./panel-host"', `import { PanelHost } from "./panel-host"\nimport { zen as tstatZen } ${STATE.replace("./feature-plugins/system", "../feature-plugins/system")}`)
      return replace(source, "  const sidebarVisible = createMemo(() => {\n", "  const sidebarVisible = createMemo(() => {\n    if (tstatZen()) return false\n")
    })
    await api.patch("packages/tui/src/component/prompt/index.tsx", (source) => {
      source = replace(source, 'import path from "path"', `import path from "path"\nimport { zen as tstatZen } ${STATE.replace("./feature-plugins/system", "../../feature-plugins/system")}`)
      return replace(source, "    showDetails: store.interrupt === 0 || dimensions().width >= 80,", "    showDetails: !tstatZen() && (store.interrupt === 0 || dimensions().width >= 80),")
    })

    // Tab badge: an errored tab shows "x" instead of the same dot as a finished one.
    await api.patch("packages/tui/src/component/session-tabs.tsx", (source) =>
      replace(source, 'if (props.status.unread || fading()) return TAB_UNREAD_MARKERS[props.unreadMarker ?? "small-dot"]',
        'if (props.status.unread || fading()) return props.status.unread === "error" ? "x" : TAB_UNREAD_MARKERS[props.unreadMarker ?? "small-dot"]'))

    // Large tool bodies (writes, diffs) are capped; shell output keeps its own expand.
    await api.patch("packages/tui/src/routes/session/index.tsx", (source) => {
      source = replace(source, 'import { rowsAfter, rowsBefore, rowWeight } from "./mount-budget"', 'import { rowsAfter, rowsBefore, rowWeight } from "./mount-budget"\nimport { Capped as TstatCapped } from "../../feature-plugins/system/tstat-ui"')
      return replace(source, "      {props.children}\n      <Show when={error()}>\n        <text fg={props.errorColor", "      <TstatCapped disabled={props.onClick !== undefined}>{props.children}</TstatCapped>\n      <Show when={error()}>\n        <text fg={props.errorColor")
    })

    // Permission prompt: "Allow for session" plus single-key answers (y, s, a, n).
    await api.patch("packages/tui/src/routes/session/permission.tsx", (source) => {
      source = replace(source, 'import { useToast } from "../../ui/toast"', 'import { useToast } from "../../ui/toast"\nimport { allowForSession as tstatAllow } from "../../feature-plugins/system/tstat-state"')
      source = replace(source, '                      once: permissionOptionLabel("once"),\n                      always: permissionOptionLabel("always"),',
        '                      once: permissionOptionLabel("once") + " (y)",\n                      session: "Allow for session (s)",\n                      always: permissionOptionLabel("always") + " (a)",')
      source = replace(source, '                      reject: permissionOptionLabel("reject"),\n                    }\n                  : { once: permissionOptionLabel("once"), reject: permissionOptionLabel("reject") }',
        '                      reject: permissionOptionLabel("reject") + " (n)",\n                    }\n                  : { once: permissionOptionLabel("once") + " (y)", session: "Allow for session (s)", reject: permissionOptionLabel("reject") + " (n)" }')
      source = replace(source, '              onSelect={(option) => {\n                if (option === "always") {',
        '              onSelect={(option) => {\n                if (option === "session") {\n                  tstatAllow(data.session.root(props.request.sessionID), props.request)\n                  reply("once")\n                  return\n                }\n                if (option === "always") {')
      // Single-key answers while the buttons are showing (the prompt input is not mounted then).
      return replace(source, "  const theme = useTheme()\n\n  function reply(value: PermissionReply, message?: string) {",
        `  const theme = useTheme()
  Keymap.createLayer(() => ({
    mode: "base",
    enabled: () => store.stage === "permission",
    commands: [
      { bind: "y", title: "Allow once", group: "Permission", run: () => reply("once") },
      {
        bind: "s",
        title: "Allow for this session",
        group: "Permission",
        run: () => {
          tstatAllow(data.session.root(props.request.sessionID), props.request)
          reply("once")
        },
      },
      ...(props.request.save?.length ? [{ bind: "a", title: "Always allow", group: "Permission", run: () => reply("always") }] : []),
      { bind: "n", title: "Reject", group: "Permission", run: () => (session()?.parentID ? setStore("stage", "reject") : reply("reject")) },
    ],
  }))

  function reply(value: PermissionReply, message?: string) {`)
    })

    // Home: recent sessions, git status of the project, update status.
    await api.patch("packages/tui/src/routes/home.tsx", (source) => {
      source = replace(source, 'import { FadeInText } from "../component/fade-in-text"', 'import { FadeInText } from "../component/fade-in-text"\nimport { Dashboard as TstatDashboard } from "../feature-plugins/system/tstat-ui"')
      return replace(source, "          <Prompt ref={bind} placeholders={placeholder} disabled={forms().length > 0} />\n        </box>\n",
        "          <Prompt ref={bind} placeholders={placeholder} disabled={forms().length > 0} />\n        </box>\n        <Show when={dimensions().height >= 26 && dimensions().width >= 60}>\n          <TstatDashboard directory={currentLocation().directory} />\n        </Show>\n")
    })
  },
}
