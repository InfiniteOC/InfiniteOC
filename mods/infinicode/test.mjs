import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import mod, { palette, redTheme, replace } from "./index.mjs"
import * as V from "./variant.ts"
import * as B from "./blend.ts"
import * as S from "./store.ts"

const checkout = path.resolve(import.meta.dirname, "../..")
const upstream = path.join(checkout, ".upstream")
const config = JSON.parse(await readFile(path.join(checkout, "infiniteoc.json"), "utf8"))

// Pristine pinned files come from git objects, not the working tree (.upstream stays read-only).
let gitOK = false
try {
  execFileSync("git", ["-C", upstream, "cat-file", "-t", config.upstream], { stdio: "ignore" })
  gitOK = true
} catch {}
const pristine = (file) => execFileSync("git", ["-C", upstream, "show", `${config.upstream}:${file}`], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] })

/** An in-memory mod API over pristine upstream: writes and patches land in `files`. */
function memoryApi(options = config.options) {
  const files = new Map()
  const commands = []
  const read = async (file) => (files.has(file) ? files.get(file) : pristine(file))
  const api = {
    root: upstream,
    options,
    read,
    async write(file, content) {
      files.set(file, content)
    },
    async patch(file, transform) {
      const before = await read(file)
      const after = await transform(before)
      if (typeof after !== "string" || after === before) throw new Error(`patch left ${file} unchanged`)
      files.set(file, after)
    },
    async patchExact(file, before, after) {
      const source = await read(file)
      if (source.split(before).length !== 2) throw new Error(`patchExact: expected one anchor in ${file}`)
      files.set(file, source.replace(before, () => after))
    },
    tui: { command: (command) => commands.push(command) },
    on() {},
  }
  return { api, files, commands }
}

async function loadEnabled({ without = [] } = {}) {
  const mods = []
  for (const entry of config.mods) {
    if (entry.includes("/infinicode/") || without.some((id) => entry.includes(`/${id}/`))) continue
    mods.push((await import(path.resolve(checkout, entry))).default)
  }
  return mods
}

// ---- variants: injection and strongest-effort choice ---------------------------------------------

const ids = (variants) => variants.map((variant) => variant.id)
const efforts = (values, spell) => values.map((id) => ({ id, ...spell(id) }))

test("InfiniCode is appended to every model, last, also to models without native variants", () => {
  const none = V.withInfinicode([])
  assert.deepEqual(none, [{ id: "infinicode" }], "no overlay: the model's defaults apply")
  const native = efforts(["low", "medium", "high"], (effort) => ({ settings: { reasoningEffort: effort } }))
  const injected = V.withInfinicode(native)
  assert.deepEqual(ids(injected), ["low", "medium", "high", "infinicode"])
  assert.deepEqual(injected.at(-1), { id: "infinicode", settings: { reasoningEffort: "high" } })
  // The native list is not mutated; a configured "infinicode" variant wins over the injected one.
  assert.deepEqual(ids(native), ["low", "medium", "high"])
  const custom = [{ id: "low" }, { id: "infinicode", settings: { reasoningEffort: "medium" } }]
  assert.equal(V.withInfinicode(custom), custom)
})

test("strongest variant per upstream protocol shape", () => {
  const strongest = (variants) => V.strongestVariant(variants)?.id
  // Anthropic adaptive effort (4.7+): low … xhigh, max.
  assert.equal(strongest(efforts(["low", "medium", "high", "xhigh", "max"], (effort) => ({ settings: { thinking: { type: "adaptive" }, effort } }))), "max")
  // OpenAI Responses: none, minimal, low, medium, high, xhigh.
  assert.equal(strongest(efforts(["none", "minimal", "low", "medium", "high", "xhigh"], (effort) => ({ settings: { reasoningEffort: effort, reasoningSummary: "auto" } }))), "xhigh")
  // OpenAI chat / xAI / Groq: low, medium, high.
  assert.equal(strongest(efforts(["low", "medium", "high"], (effort) => ({ settings: { reasoningEffort: effort } }))), "high")
  // Gemini thinking levels and thinking budgets (high = half, max = the whole output limit).
  assert.equal(strongest(efforts(["low", "medium", "high"], (effort) => ({ settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } } }))), "high")
  assert.equal(strongest([
    { id: "high", settings: { thinkingConfig: { thinkingBudget: 16000 } } },
    { id: "max", settings: { thinkingConfig: { thinkingBudget: 31999 } } },
  ]), "max")
  // Anthropic manual budgets (Claude 4.0–4.5) and Bedrock body fields.
  assert.equal(strongest([
    { id: "high", settings: { thinking: { type: "enabled", budgetTokens: 16000 } } },
    { id: "max", settings: { thinking: { type: "enabled", budgetTokens: 31999 } } },
  ]), "max")
  // DeepSeek / Moonshot / Z.ai: low, high, max (max listed before others still wins).
  assert.equal(strongest(efforts(["max", "low", "high"], (effort) => ({ settings: { reasoningEffort: effort }, body: { thinking: { type: "enabled" } } }))), "max")
  // Toggle-only models: thinking beats none.
  assert.equal(strongest([{ id: "none", body: { chat_template_kwargs: { enable_thinking: false } } }, { id: "thinking", body: { chat_template_kwargs: { enable_thinking: true } } }]), "thinking")
  // Gemini toggle: dynamic budget (-1) beats 0.
  assert.equal(strongest([{ id: "none", settings: { thinkingConfig: { thinkingBudget: 0 } } }, { id: "thinking", settings: { thinkingConfig: { thinkingBudget: -1 } } }]), "thinking")
  // Custom config variants are ranked by what they send, not their name.
  assert.equal(strongest([{ id: "deep", settings: { reasoningEffort: "xhigh" } }, { id: "high", settings: { reasoningEffort: "high" } }]), "deep")
  assert.equal(strongest([{ id: "a", settings: { thinking: { budgetTokens: 64000 } } }, { id: "b", settings: { thinking: { budgetTokens: 2000 } } }]), "a")
  // Unknown names without signals: the last one (upstream lists efforts ascending). None: undefined.
  assert.equal(strongest([{ id: "quick" }, { id: "careful" }]), "careful")
  assert.equal(strongest([]), undefined)
  assert.equal(strongest([{ id: "infinicode" }]), undefined, "never copies itself")
})

test("the injected overlay is the strongest variant's, unchanged", () => {
  const native = [
    { id: "none", settings: { thinking: { type: "disabled" } } },
    { id: "low", settings: { thinking: { type: "adaptive" }, effort: "low" }, headers: { "x-a": "1" } },
    { id: "max", settings: { thinking: { type: "adaptive" }, effort: "max" }, body: { extra: true }, headers: { "x-b": "2" } },
  ]
  assert.deepEqual(V.withInfinicode(native).at(-1), { id: "infinicode", settings: native[2].settings, headers: native[2].headers, body: native[2].body })
})

// ---- workflows: enter and restore ----------------------------------------------------------------

test("entering saves the user's workflows value once and turns workflows on; leaving restores it", () => {
  for (const before of [false, true, undefined]) {
    const root = { traffic: { mode: "tor" }, providers: { x: {} }, workflows: { maxParallel: 5, ...(before === undefined ? {} : { enabled: before }) } }
    const entered = S.enter(root)
    assert.equal(entered.workflows.enabled, true)
    assert.equal(entered.workflows.maxParallel, 5)
    assert.equal(entered.infinicode.workflowsBefore, before ?? null)
    assert.deepEqual(entered.traffic, root.traffic)
    assert.equal(S.enter(entered), undefined, "entering twice changes nothing")
    const left = S.leave(entered)
    assert.deepEqual(left, root, `restored exactly (before: ${before})`)
    assert.equal(S.leave(left), undefined, "leaving without a saved value changes nothing")
  }
  // No workflows section at all: it is removed again rather than left as {}.
  assert.deepEqual(S.leave(S.enter({ a: 1 })), { a: 1 })
})

test("a workflows change the user made while InfiniCode was on is kept on leave", () => {
  const entered = S.enter({ workflows: { enabled: true } })
  const changed = { ...entered, workflows: { enabled: false } }
  assert.deepEqual(S.leave(changed), { workflows: { enabled: false } })
  // A crash left the saved value behind while workflows were turned off by hand: re-entering keeps the original.
  assert.equal(S.enter(changed).infinicode.workflowsBefore, true)
  assert.equal(S.describe({}), "default")
  assert.equal(S.describe({ workflows: { enabled: false } }), "off")
})

test("settings file updates: atomic, 0600, other keys kept, non-JSON refused", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "infinicode-"))
  try {
    const file = path.join(dir, "nested", "settings.json")
    assert.equal(S.update(S.leave, file), undefined, "no file, nothing saved: untouched")
    assert.equal(existsSync(file), false)
    assert.equal(S.update(S.enter, file), "on")
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { workflows: { enabled: true }, infinicode: { workflowsBefore: null } })
    assert.equal(S.update(S.leave, file), "default")
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {})
    await writeFile(file, '{"providers":{"p":{"apiKey":"{env:KEY}"}},"workflows":{"enabled":false}}')
    S.update(S.enter, file)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).providers, { p: { apiKey: "{env:KEY}" } })
    assert.equal(S.update(S.leave, file), "off")
    await writeFile(file, "{ // jsonc\n}")
    assert.throws(() => S.update(S.enter, file), /not strict JSON; not modified/)
    assert.equal(await readFile(file, "utf8"), "{ // jsonc\n}")
    assert.equal(S.settingsFile({ INFINITEOC_SETTINGS_FILE: "/x/s.json" }), "/x/s.json")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the workflows store agrees with the workflows contract helper", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "infinicode-flag-"))
  try {
    const { readWorkflowsEnabled, setWorkflowsEnabled } = await import("../workflows/flag.mjs")
    const env = { INFINITEOC_SETTINGS_FILE: path.join(dir, "settings.json") }
    setWorkflowsEnabled(false, env)
    S.update(S.enter, env.INFINITEOC_SETTINGS_FILE)
    assert.equal(readWorkflowsEnabled(env), true)
    S.update(S.leave, env.INFINITEOC_SETTINGS_FILE)
    assert.equal(readWorkflowsEnabled(env), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- theme transition ------------------------------------------------------------------------------

test("color interpolation: exact ends, OKLab midpoint, alpha, hex round trip", () => {
  assert.equal(B.mixHex("#a864db", "#e8455f", 0), "#a864db")
  assert.equal(B.mixHex("#a864db", "#e8455f", 1), "#e8455f")
  assert.equal(B.mixHex("#000000", "#ffffff", 0.5), "#636363", "perceptual midpoint, not #808080")
  assert.equal(B.mixHex("#a864db", "#e8455f", -1), "#a864db", "clamped")
  assert.deepEqual(B.mixRgba([0, 0, 0, 0], [0, 0, 0, 1], 0.25)[3], 0.25)
  assert.equal(B.rgbaToHex(B.hexToRgba("#c084fc")), "#c084fc")
  assert.equal(B.rgbaToHex(B.hexToRgba("#fff")), "#ffffff")
  // Purple → crimson stays saturated through the middle (no grey midpoint).
  const [r, g, b] = B.hexToRgba(B.mixHex("#a864db", "#e8455f", 0.5))
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) > 0.3)
  assert.equal(B.easeInOutCubic(0), 0)
  assert.equal(B.easeInOutCubic(1), 1)
  assert.equal(B.easeInOutCubic(0.5), 0.5)
  assert.ok(B.easeInOutCubic(0.1) < 0.1 && B.easeInOutCubic(0.9) > 0.9)
})

test("reduced motion: instant unless the TUI's Animations choice says otherwise", () => {
  assert.equal(B.fadeEnabled(undefined, false), true)
  assert.equal(B.fadeEnabled(undefined, true), false, "options.reducedMotion → instant")
  assert.equal(B.fadeEnabled(false, false), false)
  assert.equal(B.fadeEnabled(true, true), true, "an Animations choice made in the TUI wins, like mods/infiniteoc")
  assert.ok(B.FADE_SECONDS > 0.2 && B.FADE_SECONDS < 1.5)
})

// A stand-in for OpenTUI's RGBA in a resolved-theme shape (hue scales, stateful colors, surfaces).
class Color {
  constructor(hex) {
    this.hex = hex
  }
}
const ops = { isColor: (value) => value instanceof Color, mix: (a, b, t) => new Color(B.mixHex(a.hex, b.hex, t)) }
function resolved(accent, background, extra = {}) {
  const action = { base: new Color(accent), hovered: new Color(background), disabled: new Color("#777777") }
  action.state = (states) => action[["disabled", "pressed", "focused", "selected", "hovered"].find((s) => states[s]) ?? "base"]
  const theme = {
    hue: { accent: { 200: new Color(accent) }, ...extra },
    categorical: [{ 200: new Color(accent) }],
    background: { base: new Color(background) },
    text: { action: { primary: action } },
    thinkingOpacity: 0.6,
    source: () => ({ hue: "accent", step: 200 }),
    increase: () => new Color("#000000"),
    decrease: () => new Color("#000000"),
  }
  const dialog = { ...theme, background: { base: new Color("#222222") } }
  theme.surface = () => dialog
  dialog.surface = () => dialog
  return theme
}

test("theme transition: ends are the real themes, frames blend every token", () => {
  const from = resolved("#c084fc", "#160f1d", { pink: { 200: new Color("#f472b6") } })
  const to = resolved("#ff6b81", "#1c0e10", { crimson: { 200: new Color("#ff6b81") } })
  assert.equal(B.themeAt(from, to, 0, ops), from)
  assert.equal(B.themeAt(from, to, 1, ops), to)
  const mid = B.themeAt(from, to, 0.5, ops)
  assert.equal(mid.hue.accent[200].hex, B.mixHex("#c084fc", "#ff6b81", 0.5))
  assert.equal(mid.background.base.hex, B.mixHex("#160f1d", "#1c0e10", 0.5))
  assert.equal(mid.categorical[0][200].hex, mid.hue.accent[200].hex)
  assert.ok(mid.hue.pink && mid.hue.crimson, "hues only one theme has are kept")
  assert.equal(mid.thinkingOpacity, 0.6)
  // Stateful colors pick from the blended values.
  assert.equal(mid.text.action.primary.state({ hovered: true }).hex, mid.text.action.primary.hovered.hex)
  assert.equal(mid.text.action.primary.state({ disabled: true, hovered: true }).hex, "#777777")
  assert.equal(mid.text.action.primary.state({}).hex, mid.hue.accent[200].hex)
  // The dialog surface blends the two dialog views and is cached; hue-step lookups are identity.
  assert.equal(mid.surface("dialog").background.base.hex, "#222222")
  assert.equal(mid.surface("dialog"), mid.surface("dialog"))
  const color = new Color("#123456")
  assert.equal(mid.increase(color), color)
  assert.equal(mid.source(color), undefined)
  // Mismatched shapes switch at the midpoint instead of failing.
  assert.deepEqual(B.blendTree([1, 2], [1, 2, 3], 0.4, ops), [1, 2])
  assert.deepEqual(B.blendTree([1, 2], [1, 2, 3], 0.6, ops), [1, 2, 3])
})

// ---- red theme -------------------------------------------------------------------------------------

test("red theme: same structure as the InfiniteOC theme, crimson/scarlet roles, readable text", async () => {
  const { api, files } = memoryApi()
  const infiniteoc = (await import("../infiniteoc/index.mjs")).default
  await infiniteoc.setup(api)
  const source = JSON.parse(files.get("packages/tui/src/theme/assets/v2/infiniteoc.json"))
  const red = redTheme(source)
  assert.deepEqual(red.base, source.base, "tokens and semantic colors unchanged")
  assert.equal(source.dark.hue.interactive, "$hue.purple", "source not mutated")
  for (const mode of ["dark", "light"]) {
    const hue = red[mode].hue
    assert.equal(hue.interactive, "$hue.crimson")
    assert.equal(hue.accent, "$hue.scarlet")
    assert.equal(hue.neutral, "$hue.gray")
    for (const name of ["gray", "crimson", "scarlet"]) {
      assert.deepEqual(Object.keys(hue[name]), ["100", "200", "300", "400", "500", "600", "700", "800", "900"])
      for (const color of Object.values(hue[name])) assert.match(color, /^#[0-9a-f]{6}$/)
    }
    assert.ok(red[mode].categorical.every((name) => hue[name] || source[mode].hue[name] || source.base.categorical.includes(name)))
    // Text tokens are neutral.200 (base) and neutral.400 (muted) on neutral.800; links/keywords use 200.
    const c = (step, name = "gray") => B.hexToRgba(palette[mode][name][step / 100 - 1])
    assert.ok(B.contrast(c(200), c(800)) >= 12, `${mode} text`)
    assert.ok(B.contrast(c(400), c(800)) >= 4.5, `${mode} muted text`)
    assert.ok(B.contrast(c(200, "crimson"), c(800)) >= 4.5, `${mode} interactive`)
    assert.ok(B.contrast(c(200, "scarlet"), c(800)) >= 4.5, `${mode} accent`)
    // Reds, not purples: hue angle of the interactive/accent steps near red.
    for (const name of ["crimson", "scarlet"]) {
      const [r, g, b] = c(300, name)
      assert.ok(r > g && r > b && r - Math.max(g, b) > 0.35, `${mode} ${name} is red`)
    }
  }
  // Works on the stock theme too (infiniteoc disabled).
  const stock = redTheme(JSON.parse(pristine("packages/tui/src/theme/assets/v2/opencode.json")))
  assert.equal(stock.dark.hue.accent, "$hue.scarlet")
  assert.equal(stock.light.border.base, palette.light.border)
})

// ---- mod application ------------------------------------------------------------------------------

test("applies after every enabled mod on pristine upstream: catalog, theme, plugin, label, picker", { skip: !gitOK && "no pinned upstream git objects" }, async () => {
  const { api, files, commands } = memoryApi()
  for (const other of await loadEnabled()) await other.setup(api)
  await mod.setup(api)
  assert.equal(commands.filter((command) => command.slash === "infinicode").length, 0, "the slash command lives in the builtin plugin")

  const model = files.get("packages/core/src/model.ts")
  assert.match(model, /import \{ withInfinicode \} from "\.\/infiniteoc\/infinicode-variant\.js"\n/)
  assert.match(model, /body: Provider\.mergeOverlay\(provider\?\.body, model\.body\),\n {4}.*mods\/infinicode.*\n {20}variants: withInfinicode\(model\.variants \?\? \[\]\),\n {18}\} satisfies Info/)
  assert.equal(files.get("packages/core/src/infiniteoc/infinicode-variant.ts"), await readFile(new URL("./variant.ts", import.meta.url), "utf8"))

  const theme = files.get("packages/tui/src/context/theme.tsx")
  assert.match(theme, /import \{ createInfinicodeTokens \} from "\.\.\/theme\/infinicode"\n/)
  assert.match(theme, /const tokens = createInfinicodeTokens\(\(\) => selected\(\)\.theme, mode, \(\) => fadeEnabled\(config\.animations, false\)\)\n/)
  assert.match(theme, /active: "infiniteoc",/, "mods/infiniteoc's default theme is kept")
  // The names the patch relies on exist in theme.tsx's init scope, before the patched line.
  const before = theme.slice(0, theme.indexOf("const tokens = createInfinicodeTokens"))
  assert.match(before, /const config = configState\.data\n/)
  assert.match(before, /const mode = \(\) => selected\(\)\.mode\n/)
  const red = JSON.parse(files.get("packages/tui/src/theme/assets/v2/infinicode.json"))
  assert.equal(red.dark.hue.interactive, "$hue.crimson")
  assert.ok(red.dark.hue.pink, "derived from the InfiniteOC theme, not the stock one")
  for (const name of ["theme/infinicode-blend.ts", "theme/infinicode.ts", "infiniteoc-features/infinicode-variant.ts", "infiniteoc-features/infinicode-store.ts", "feature-plugins/system/infiniteoc-infinicode.tsx"])
    assert.ok(files.has(`packages/tui/src/${name}`), name)
  assert.equal(files.get("packages/tui/src/infiniteoc-features/infinicode-build.ts").trim().split("\n").at(-1), "export const workflowsAvailable = true")

  // Every relative import of the written TUI modules resolves in the patched tree.
  const exists = (target) => [".ts", ".tsx", ".json", ""].some((ext) => {
    if (files.has(target + ext)) return true
    try {
      pristine(target + ext)
      return true
    } catch {
      return false
    }
  })
  for (const name of ["theme/infinicode.ts", "feature-plugins/system/infiniteoc-infinicode.tsx"]) {
    const source = files.get(`packages/tui/src/${name}`)
    for (const [, rel] of source.matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
      const target = path.posix.join("packages/tui/src", path.posix.dirname(name), rel)
      assert.ok(exists(target), `${name} imports ${rel}`)
    }
  }
  // Upstream APIs used by the theme glue and the plugin exist in the pinned source.
  assert.match(pristine("packages/tui/src/ui/animation.ts"), /export function createAnimatable/)
  assert.match(pristine("packages/tui/src/theme/index.ts"), /export function parseTheme/)
  assert.match(pristine("packages/plugin/src/tui/context.ts"), /set\(variant: string \| undefined\): boolean/)

  const builtins = files.get("packages/tui/src/plugin/builtins.ts")
  assert.match(builtins, /import InfiniteocInfinicode from "\.\.\/feature-plugins\/system\/infiniteoc-infinicode"\n/)
  assert.match(builtins, / {2}DiffViewer,\n {2}InfiniteocInfinicode,\n\]/)
  assert.match(builtins, /InfiniteocWorkflows,/, "the workflows builtin stays registered")
  const plugin = files.get("packages/tui/src/feature-plugins/system/infiniteoc-infinicode.tsx")
  assert.match(plugin, /slash: \{ name: "infinicode" \}/)

  const metadata = files.get("packages/tui/src/component/prompt/metadata.tsx")
  assert.match(metadata, /variant: props\.variant === "infinicode" \? "InfiniCode" : props\.variant,/)
  assert.match(metadata, /variant\(\) === "InfiniCode" \? theme\.hue\.interactive\["200"\] : theme\.text\.feedback\.warning\.base/)
  const dialog = files.get("packages/tui/src/component/dialog-variant.tsx")
  assert.match(dialog, /title: variant === "infinicode" \? "InfiniCode" : variant,\n {8}description: variant === "infinicode"/)
})

test("without the workflows mod InfiniCode still builds and reports workflows unavailable", { skip: !gitOK && "no pinned upstream git objects" }, async () => {
  const { api, files } = memoryApi()
  for (const other of await loadEnabled({ without: ["workflows"] })) await other.setup(api)
  await mod.setup(api)
  assert.match(files.get("packages/tui/src/infiniteoc-features/infinicode-build.ts"), /export const workflowsAvailable = false\n/)
  assert.ok(files.has("packages/tui/src/feature-plugins/system/infiniteoc-infinicode.tsx"))
})

test("reducedMotion is baked into the fade default; anchors fail closed", { skip: !gitOK && "no pinned upstream git objects" }, async () => {
  const { api, files } = memoryApi({ ...config.options, reducedMotion: true })
  await mod.setup(api)
  assert.match(files.get("packages/tui/src/context/theme.tsx"), /fadeEnabled\(config\.animations, true\)/)
  // Without mods/infiniteoc the red theme derives from the stock theme.
  assert.ok(!JSON.parse(files.get("packages/tui/src/theme/assets/v2/infinicode.json")).dark.hue.pink)
  // A second application, or a changed upstream anchor, throws instead of silently skipping.
  await assert.rejects(mod.setup(api), /already applied|expected one source anchor/)
  assert.throws(() => replace("a b a", "a", "c"), /expected one source anchor/)
  assert.throws(() => replace("ab", "a", "ab"), /already applied/)
  const broken = memoryApi()
  broken.files.set("packages/tui/src/context/theme.tsx", "nothing to anchor")
  await assert.rejects(mod.setup(broken.api), /expected one source anchor: import \{ createComponentTheme/)
})

test("plugin never touches permissions, sessions or the theme config", async () => {
  const plugin = await readFile(new URL("./tui/plugin.tsx", import.meta.url), "utf8")
  const theme = await readFile(new URL("./tui/theme.ts", import.meta.url), "utf8")
  for (const source of [plugin, theme].map((text) => text.replace(/^\s*\/\/.*$/gm, ""))) {
    assert.doesNotMatch(source, /permission|session\.(delete|remove|interrupt)|\.prompt\(|themes\.set|configState|\.update\(/i)
  }
  // Only the variant API and the settings-file store change anything.
  assert.match(plugin, /context\.ui\.model\.variant\.set\(/)
  assert.match(plugin, /update\(active \? enter : leave\)/)
})
