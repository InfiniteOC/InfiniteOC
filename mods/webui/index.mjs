import { readFile } from "node:fs/promises"
import { cells, rows } from "./wordmark.mjs"
import { logo } from "../infiniteoc/wordmark.mjs"

// Build-side support for `infiniteoc serve` / `infiniteoc web` (the launcher side is src/serve.mjs), and
// InfiniteOC in the web UI (built in only with options.webUi): its branding, logo and icons, toasts from
// the server, and the TUI's InfiniteOC commands as web commands backed by one RPC. Listed last in
// infiniteoc.json: the web commands cover the features of every mod applied before it.
export const patches = [
  // Upstream drops the server password from its environment only for --stdio; in a foreground `serve` the agent's
  // shell would inherit it. It has been read into a variable just above, so nothing else needs it.
  ["packages/cli/src/server-process.ts", '      if (options.mode === "stdio") {\n        delete process.env.OPENCODE_PASSWORD', '      if (options.mode === "stdio" || OPENCODE_CHANNEL === "infiniteoc") {\n        delete process.env.OPENCODE_PASSWORD'],
  // No theme stored yet: the app starts in InfiniteOC's theme instead of oc-2.
  ["packages/app/src/app.tsx", "      <ThemeProvider\n        onThemeApplied={", '      <ThemeProvider\n        defaultTheme="infiniteoc"\n        onThemeApplied={'],
  // The pre-render script must agree, or every load flashes oc-2 before the app applies the theme.
  ["packages/app/public/oc-theme-preload.js", 'var themeId = localStorage.getItem(key) || "oc-2"', 'var themeId = localStorage.getItem(key) || "infiniteoc"'],
  // Shown in the theme picker before the theme file has loaded.
  ["packages/ui/src/theme/context.tsx", '  "oc-2": "OpenCode",\n', '  "oc-2": "OpenCode",\n  infiniteoc: "InfiniteOC",\n'],
  ["packages/app/index.html", "<title>OpenCode</title>", "<title>InfiniteOC</title>"],
  // The sign-in screen's wordmark is InfiniteOC's (packages/ui wordmark.tsx below); so is its label.
  ["packages/app/src/servers/connect/screen.tsx", '<div class="server-connect-brand" role="img" aria-label="OpenCode">', '<div class="server-connect-brand" role="img" aria-label="InfiniteOC">'],
  // Installed as an app (PWA): its name.
  ["packages/app/manifest.json", '  "name": "OpenCode",\n  "short_name": "OpenCode",', '  "name": "InfiniteOC",\n  "short_name": "InfiniteOC",'],
  // InfiniteOC's commands and the server's toasts, once per session screen beside upstream's command hooks.
  ["packages/app/src/session/composer/region.tsx", 'import { useComposerCommands } from "@/composer/commands"\n', 'import { useComposerCommands } from "@/composer/commands"\nimport { useInfiniteocWeb } from "@/infiniteoc/web"\n'],
  ["packages/app/src/session/composer/region.tsx", "  useComposerCommands()\n  useSessionCommands({", "  useComposerCommands()\n  useInfiniteocWeb({ sessionID: () => input.session.identity.params.id, directory: () => location().directory })\n  useSessionCommands({"],
]

// Favicon and app icons: the web build copies these from the "dev" icon channel (packages/app/vite.icons.ts),
// which InfiniteOC builds use; the desktop app that also reads them is never built by InfiniteOC.
export const icons = [
  ["icon.ico", "packages/desktop/icons/dev/icon.ico"],
  ["AppIcon-60x60@3x.png", "packages/desktop/icons/dev/ios/AppIcon-60x60@3x.png"],
  ["ic_launcher.png", "packages/desktop/icons/dev/android/mipmap-xxxhdpi/ic_launcher.png"],
  ["icon.png", "packages/desktop/icons/dev/icon.png"],
  ["64x64.png", "packages/desktop/icons/dev/64x64.png"],
]

const FROM = "#c084fc"
const TO = "#f472b6"

// Solid source for one SVG of cells; ids are per instance, since several logos can share a page.
const svgComponent = (name, props, shapes, width, height, attributes) => `export const ${name} = (props: ${props}) => {
  const id = createUniqueId()
  return (
    <svg
      ${attributes}
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 ${width} ${height}"
      shape-rendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="${width}" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="${FROM}" />
          <stop offset="1" stop-color="${TO}" />
        </linearGradient>
      </defs>
      <g fill={\`url(#\${id})\`}>
${shapes.map((cell) => `        <rect x="${cell.x}" y="${cell.y}" width="${cell.w}" height="${cell.h}"${cell.shadow ? ' fill-opacity="0.25"' : ""} />`).join("\n")}
      </g>
    </svg>
  )
}`

const width = (lines) => Math.max(...lines.map((line) => Array.from(line).length))

/** packages/ui/src/components/logo.tsx: Mark/Splash (the "OC"), Logo (the full wordmark), same exports as upstream. */
export function logoSource() {
  const oc = logo.right.slice(1)
  return `// Written by mods/webui from mods/infiniteoc/wordmark.mjs: the TUI's InfiniteOC wordmark as SVG
// (a terminal cell is 1 wide, 2 tall; shadow cells at 25%), replacing upstream's OpenCode marks.
import { createUniqueId, type ComponentProps } from "solid-js"

${svgComponent("Mark", "{ class?: string }", cells(oc), width(oc), oc.length * 2, 'data-component="logo-mark"\n      role="img"\n      aria-label="InfiniteOC"')}

${svgComponent("Splash", 'Pick<ComponentProps<"svg">, "ref" | "class">', cells(oc), width(oc), oc.length * 2, 'ref={props.ref}\n      data-component="logo-splash"\n      role="img"\n      aria-label="InfiniteOC"')}

${svgComponent("Logo", "{ class?: string }", cells(rows), width(rows), rows.length * 2, 'role="img"\n      aria-label="InfiniteOC"')}
`
}

/** packages/ui/src/typography/wordmark/wordmark.tsx: upstream's props are accepted; the wordmark is InfiniteOC's. */
export function wordmarkSource() {
  return `// Written by mods/webui: InfiniteOC's wordmark in place of upstream's (same props; fade/muted/outline only dim it).
import { type ComponentProps } from "solid-js"
import { Logo } from "../../components/logo"

export function Wordmark(props: Pick<ComponentProps<"svg">, "class"> & { fade?: boolean; muted?: boolean; outline?: boolean }) {
  return (
    <div class={props.class} style={{ opacity: props.muted ? 0.6 : 1 }}>
      <Logo class="block h-auto w-full" />
    </div>
  )
}
`
}

// Server modules the web features read; each feature appears only when its mod ran before this one.
const STORES = {
  ctx: "packages/core/src/plugin/infiniteoc-ctx-store.ts",
  octx: "packages/core/src/plugin/infiniteoctx-store.ts",
  workflows: "packages/core/src/plugin/infiniteoc-wf-store.ts",
  usage: "packages/core/src/plugin/infiniteoc-prov-lib.ts",
}

/** The RPC plugin serving mods/webui/views.ts with the stores this build has. */
export function serverSource(present) {
  const has = (name) => present.includes(name)
  return `// Generated by mods/webui: InfiniteOC's features for the web UI over one RPC. The browser side is
// packages/app/src/infiniteoc (contract in rpc.ts); the views are infiniteoc-web-views.ts.
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { features, view, type Deps, type Request } from "./infiniteoc-web-views.js"
${has("ctx") ? 'import * as Ctx from "./infiniteoc-ctx-store.js"\n' : ""}${has("octx") ? 'import * as Octx from "./infiniteoctx-store.js"\n' : ""}${has("workflows") ? 'import * as Workflows from "./infiniteoc-wf-store.js"\n' : ""}${has("usage") ? `import { Database } from "bun:sqlite"
import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { Global } from "@opencode/util/global"
import { aggregateUsage, formatUsage, type UsageRow } from "./infiniteoc-prov-lib.js"

// InfiniteOC's own database (OPENCODE_DB, else opencode-infiniteoc.db), else the newest opencode*.db.
function databaseFile() {
  const data = Global.Path.data
  for (const name of [process.env.OPENCODE_DB, "opencode-infiniteoc.db"]) {
    if (name && existsSync(path.resolve(data, name))) return path.resolve(data, name)
  }
  const found = existsSync(data) ? readdirSync(data).filter((name) => /^opencode.*\\.db$/.test(name)).map((name) => path.join(data, name)) : []
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

// The same query as the TUI's /usage: cost per assistant and compaction message, by local day.
const QUERY = \`select date(m.time_created / 1000, 'unixepoch', 'localtime') as day, s.directory as project,
  coalesce(json_extract(m.data, '$.model.providerID'), 'unknown') as provider, json_extract(m.data, '$.cost') as cost
  from session_message m join session_v2 s on s.id = m.session_id
  where m.type in ('assistant', 'compaction') and json_extract(m.data, '$.cost') > 0\`

function usage() {
  const file = databaseFile()
  if (!file) return "No stored sessions found."
  const db = new Database(file, { readonly: true })
  try {
    return formatUsage(aggregateUsage(db.query(QUERY).all() as UsageRow[]))
  } finally {
    db.close()
  }
}
` : ""}
const deps: Deps = { ${[has("ctx") && "ctx: Ctx", has("octx") && "octx: Octx", has("workflows") && "workflows: Workflows", has("usage") && "usage"].filter(Boolean).join(", ")} }

const contract = {
  id: "infiniteoc",
  methods: {
    features: { input: { type: "string" }, output: { type: "string" } },
    run: { input: { type: "string" }, output: { type: "string" } },
  },
  events: {},
} as const

// Anything that is not a request object becomes an unknown feature, which the views answer with an error view.
function parse(input: unknown): Request {
  try {
    const value = JSON.parse(String(input))
    if (value && typeof value === "object" && typeof value.feature === "string")
      return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string")) as Request
  } catch {}
  return { feature: "" }
}

export const Plugin = define({
  id: "infiniteoc.web",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.rpc
      .register(contract, {
        features: () => Effect.sync(() => JSON.stringify(features(deps))),
        run: (input) => Effect.sync(() => JSON.stringify(view(parse(input), deps))),
      })
      .pipe(Effect.orDie)
  }),
})
`
}

// Inserted before an upstream line that stays intact, so other mods patching the plugin list still find it.
export function internalSource(source) {
  for (const [before, after] of [
    ['import { WarmingPlugin } from "./warming.js"', 'import * as InfiniteocWeb from "./infiniteoc-web.js"\nimport { WarmingPlugin } from "./warming.js"'],
    ["  WarmingPlugin.Plugin,\n", "  InfiniteocWeb.Plugin,\n  WarmingPlugin.Plugin,\n"],
  ]) {
    if (source.includes(after)) throw new Error("webui: already applied (plugin list)")
    if (source.split(before).length !== 2) throw new Error(`webui: expected one source anchor: ${before}`)
    source = source.replace(before, () => after)
  }
  return source
}

const file = (name) => readFile(new URL(`./${name}`, import.meta.url))

export default {
  id: "webui",
  version: "2.0.0",
  async setup(api) {
    await api.write("packages/ui/src/theme/themes/infiniteoc.json", await readFile(new URL("./theme.json", import.meta.url), "utf8"))
    for (const [path, before, after] of patches) await api.patchExact(path, before, after)
    // Logo and icons.
    await api.write("packages/ui/src/components/logo.tsx", logoSource())
    await api.write("packages/ui/src/typography/wordmark/wordmark.tsx", wordmarkSource())
    for (const [name, target] of icons) await api.write(target, await file(`icons/${name}`))
    // InfiniteOC's features: the browser side, the views and the RPC plugin with the stores present.
    for (const name of ["rpc.ts", "dialog.tsx", "web.tsx"]) await api.write(`packages/app/src/infiniteoc/${name}`, await file(`app/${name}`))
    const present = []
    for (const [name, path] of Object.entries(STORES)) {
      if (await api.read(path).then(() => true, () => false)) present.push(name)
    }
    await api.write("packages/core/src/plugin/infiniteoc-web-views.ts", await file("views.ts"))
    await api.write("packages/core/src/plugin/infiniteoc-web.ts", serverSource(present))
    await api.patch("packages/core/src/plugin/internal.ts", internalSource)
  },
}
