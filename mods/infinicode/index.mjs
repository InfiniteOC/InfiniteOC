import { readFile } from "node:fs/promises"

// Strict single-anchor replace: every patch inserts around its anchor, so a second application or an
// incompatible upstream fails closed instead of being skipped.
export function replace(source, before, after, label = before) {
  if (typeof source !== "string" || source.split(before).length !== 2) throw new Error(`infinicode: expected one source anchor: ${label}`)
  if (source.includes(after)) throw new Error(`infinicode: already applied: ${label}`)
  return source.replace(before, () => after)
}

const file = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")

// InfiniCode red, per mode: warm red-tinted neutrals (backgrounds and text), crimson for interactive
// elements and scarlet for accents. Steps 100 → 900 run light → dark in dark mode and dark → light in
// light mode, like the InfiniteOC theme they replace. Semantic error/warning/success/diff colors stay.
export const palette = {
  dark: {
    gray: ["#fff5f5", "#fbe9e9", "#dcbcbc", "#b58e8e", "#6b4646", "#381f21", "#2a1617", "#1c0e10", "#12080a"],
    crimson: ["#ffd3da", "#ff6b81", "#e8455f", "#c92e48", "#a51f37", "#80152a", "#5d0e1e", "#3e0813", "#24040b"],
    scarlet: ["#ffd9d0", "#ff7a5c", "#ec5a3c", "#c94428", "#a3341d", "#7d2615", "#5a1a0e", "#3c0f08", "#230804"],
    border: "#6b4646",
    scrollbar: "#e8455f",
  },
  light: {
    gray: ["#2a1012", "#3d181b", "#6b4245", "#93696c", "#c29fa1", "#f4e4e5", "#fbefef", "#fffafa", "#ffffff"],
    crimson: ["#881337", "#9f1239", "#be123c", "#e11d48", "#f43f5e", "#fda4af", "#fecdd3", "#ffe4e6", "#fff1f2"],
    scarlet: ["#9f1d0f", "#b8240f", "#d23016", "#e8401f", "#f2613f", "#f9a58f", "#fcc6b8", "#fde3dc", "#fef3f0"],
    border: "#c29fa1",
    scrollbar: "#e11d48",
  },
}

/** The red document: the InfiniteOC (or stock) v2 theme with the palette above swapped in. */
export function redTheme(source) {
  const theme = structuredClone(source)
  for (const mode of ["dark", "light"]) {
    const colors = palette[mode]
    theme[mode] ??= {}
    theme[mode].hue ??= {}
    for (const hue of ["gray", "crimson", "scarlet"]) {
      theme[mode].hue[hue] = Object.fromEntries(colors[hue].map((color, i) => [String((i + 1) * 100), color]))
    }
    theme[mode].hue.neutral = "$hue.gray"
    theme[mode].hue.interactive = "$hue.crimson"
    theme[mode].hue.accent = "$hue.scarlet"
    theme[mode].border = { ...theme[mode].border, base: colors.border }
    theme[mode].scrollbar = { ...theme[mode].scrollbar, base: colors.scrollbar }
    // Agent colors and /stats use categorical[0].
    theme[mode].categorical = ["crimson", "blue", "green", "orange", "scarlet"]
  }
  return theme
}

const CORE = "packages/core/src"
const TUI = "packages/tui/src"

export default {
  id: "infinicode",
  version: "1.0.0",
  async setup(api) {
    const variant = await file("variant.ts")
    // mods/workflows (when enabled before this mod) writes its server plugin; without it the
    // workflows flag would do nothing, so InfiniCode says so instead of writing it.
    const workflowsAvailable = await api.read(`${CORE}/plugin/infiniteoc-workflows.ts`).then(() => true, () => false)

    // Server: every model in the catalog gets the InfiniCode variant, a copy of its strongest one.
    await api.write(`${CORE}/infiniteoc/infinicode-variant.ts`, variant)
    await api.patch(`${CORE}/model.ts`, (source) => {
      source = replace(source, 'import { AISDKNative } from "./aisdk-native.js"\n', 'import { AISDKNative } from "./aisdk-native.js"\nimport { withInfinicode } from "./infiniteoc/infinicode-variant.js"\n')
      return replace(source, "                    body: Provider.mergeOverlay(provider?.body, model.body),\n                  } satisfies Info",
        "                    body: Provider.mergeOverlay(provider?.body, model.body),\n                    // mods/infinicode: every model also offers the InfiniCode effort (its strongest variant).\n                    variants: withInfinicode(model.variants ?? []),\n                  } satisfies Info",
        "model.ts merged catalog entry")
    })

    // TUI theme: the red document and the fade, applied to the resolved theme in context/theme.tsx.
    const base = await api.read(`${TUI}/theme/assets/v2/infiniteoc.json`).catch(() => api.read(`${TUI}/theme/assets/v2/opencode.json`))
    await api.write(`${TUI}/theme/assets/v2/infinicode.json`, JSON.stringify(redTheme(JSON.parse(base)), null, 2) + "\n")
    await api.write(`${TUI}/theme/infinicode-blend.ts`, await file("blend.ts"))
    await api.write(`${TUI}/theme/infinicode.ts`, await file("tui/theme.ts"))
    await api.patch(`${TUI}/context/theme.tsx`, (source) => {
      source = replace(source, 'import { createComponentTheme, type ComponentTheme } from "../theme/component"\n',
        'import { createComponentTheme, type ComponentTheme } from "../theme/component"\nimport { createInfinicodeTokens } from "../theme/infinicode"\nimport { fadeEnabled } from "../theme/infinicode-blend"\n')
      return replace(source, "    const tokens = () => selected().theme\n",
        `    // mods/infinicode: fades to InfiniCode red while that effort is selected (instant with Animations off).\n    const tokens = createInfinicodeTokens(() => selected().theme, mode, () => fadeEnabled(config.animations, ${api.options?.reducedMotion === true}))\n`,
        "theme.tsx tokens")
    })

    // TUI: shared modules, the builtin plugin (/infinicode, the watcher) and the effort label.
    await api.write(`${TUI}/infiniteoc-features/infinicode-variant.ts`, variant)
    await api.write(`${TUI}/infiniteoc-features/infinicode-store.ts`, await file("store.ts"))
    await api.write(`${TUI}/infiniteoc-features/infinicode-build.ts`, `// Written by mods/infinicode at build time.\nexport const workflowsAvailable = ${workflowsAvailable}\n`)
    await api.write(`${TUI}/feature-plugins/system/infiniteoc-infinicode.tsx`, await file("tui/plugin.tsx"))
    await api.patch(`${TUI}/plugin/builtins.ts`, (source) => {
      source = replace(source, 'import Stats from "../feature-plugins/system/stats"\n', 'import Stats from "../feature-plugins/system/stats"\nimport InfiniteocInfinicode from "../feature-plugins/system/infiniteoc-infinicode"\n')
      return replace(source, "  DiffViewer,\n]", "  DiffViewer,\n  InfiniteocInfinicode,\n]", "builtins list end")
    })
    await api.patch(`${TUI}/component/prompt/metadata.tsx`, (source) => {
      source = replace(source, "      variant: props.variant,\n    })\n  })", '      variant: props.variant === "infinicode" ? "InfiniCode" : props.variant,\n    })\n  })', "metadata layout variant")
      return replace(source, "                    fg={fade(theme.text.feedback.warning.base, props.variantAlpha)}",
        '                    fg={fade(variant() === "InfiniCode" ? theme.hue.interactive["200"] : theme.text.feedback.warning.base, props.variantAlpha)}',
        "metadata variant color")
    })
    await api.patch(`${TUI}/component/dialog-variant.tsx`, (source) =>
      replace(source, "        title: variant,\n",
        '        title: variant === "infinicode" ? "InfiniCode" : variant,\n        description: variant === "infinicode" ? "strongest effort · workflows on · red theme" : undefined,\n',
        "dialog-variant title"))
  },
}
