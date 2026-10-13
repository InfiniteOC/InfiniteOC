// InfiniCode red: while the InfiniCode effort is the selected variant, the resolved theme fades to
// the red document (infinicode.json, derived from the InfiniteOC theme at build time) and fades back
// when it is left. The user's theme choice and config are never changed. Animations off (or
// infiniteoc.json options.reducedMotion) makes the switch instant.
// Written to packages/tui/src/theme/infinicode.ts by mods/infinicode; context/theme.tsx calls
// createInfinicodeTokens and the InfiniCode builtin plugin sets the active signal.
import { RGBA } from "@opentui/core"
import { resolveThemeDocument, type ResolvedTheme } from "@opencode/theme/tui"
import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { createAnimatable, tween } from "../ui/animation"
import { parseTheme } from "./index"
import { FADE_SECONDS, easeInOutCubic, mixRgba, themeAt, type ColorOps } from "./infinicode-blend"
import red from "./assets/v2/infinicode.json" with { type: "json" }

const [active, setActive] = createSignal(false)
export const infinicodeActive = active
export const setInfinicodeActive = (value: boolean) => setActive(value)

const ops: ColorOps<RGBA> = {
  isColor: (value): value is RGBA => value instanceof RGBA,
  mix: (from, to, t) => RGBA.fromValues(...mixRgba([from.r, from.g, from.b, from.a], [to.r, to.g, to.b, to.a], t)),
}

export function createInfinicodeTokens(
  base: Accessor<ResolvedTheme>,
  mode: Accessor<"dark" | "light">,
  animations: Accessor<boolean>,
): Accessor<ResolvedTheme> {
  const fade = createAnimatable(
    { t: active() ? 1 : 0 },
    { enabled: animations, transition: tween({ duration: FADE_SECONDS, ease: easeInOutCubic }) },
  )
  createEffect(() => fade.animate({ t: active() ? 1 : 0 }))
  // Resolved once per mode, on first use: InfiniCode off never pays for it. A red document that
  // fails to resolve keeps the user's theme (null) instead of breaking every themed component.
  const resolved = new Map<"dark" | "light", ResolvedTheme | null>()
  const target = (current: "dark" | "light") => {
    if (!resolved.has(current)) {
      try {
        resolved.set(current, resolveThemeDocument(parseTheme(red, "infinicode"), current))
      } catch {
        resolved.set(current, null)
      }
    }
    return resolved.get(current) ?? undefined
  }
  return createMemo(() => {
    const t = fade.value().t
    const to = t > 0 ? target(mode()) : undefined
    if (!to) return base()
    return themeAt(base(), to, t, ops)
  })
}
