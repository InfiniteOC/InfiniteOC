// InfiniCode red: the pure part of the theme transition. Colors mix in OKLab, so purple and pink
// fade into crimson without a grey or muddy midpoint; a resolved theme blends token by token.
// Pure (no imports): written to packages/tui/src/theme/infinicode-blend.ts by mods/infinicode and
// loaded directly by node tests.

/** Seconds of the fade between the current theme and InfiniCode red, both ways. */
export const FADE_SECONDS = 0.7

/** r, g, b, a in 0..1, like OpenTUI's RGBA.fromValues. */
export type Rgba = readonly [number, number, number, number]

const clamp = (value: number) => Math.max(0, Math.min(1, value))
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function toOklab(r: number, g: number, b: number): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function fromOklab(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    clamp(toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp(toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp(toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ]
}

/** `from` at t = 0, `to` at t = 1 (exactly), mixed in OKLab between; alpha mixes linearly. */
export function mixRgba(from: Rgba, to: Rgba, t: number): [number, number, number, number] {
  const p = clamp(t)
  if (p === 0) return [...from]
  if (p === 1) return [...to]
  const a = toOklab(from[0], from[1], from[2])
  const b = toOklab(to[0], to[1], to[2])
  const [r, g, bl] = fromOklab(a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p, a[2] + (b[2] - a[2]) * p)
  return [r, g, bl, from[3] + (to[3] - from[3]) * p]
}

export const hexToRgba = (hex: string): Rgba => {
  const value = hex.replace(/^#/, "")
  const full = value.length <= 4 ? [...value].map((c) => c + c).join("") : value
  const part = (index: number) => parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255
  return [part(0), part(1), part(2), full.length >= 8 ? part(3) : 1]
}

export const rgbaToHex = (color: Rgba) =>
  "#" + color.slice(0, 3).map((c) => Math.round(clamp(c) * 255).toString(16).padStart(2, "0")).join("")

export const mixHex = (from: string, to: string, t: number) => rgbaToHex(mixRgba(hexToRgba(from), hexToRgba(to), t))

/** Slow start and end, like a CSS ease-in-out. */
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/**
 * Whether the fade animates: the TUI's Animations choice when made, else not with
 * infiniteoc.json options.reducedMotion. Off means the theme switches instantly.
 */
export const fadeEnabled = (animations: boolean | undefined, reducedMotion: boolean) => animations ?? !reducedMotion

/** WCAG contrast ratio of two colors (1–21), used to keep the red theme readable. */
export function contrast(a: Rgba, b: Rgba) {
  const luminance = (c: Rgba) => 0.2126 * toLinear(c[0]) + 0.7152 * toLinear(c[1]) + 0.0722 * toLinear(c[2])
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

export type ColorOps<C> = {
  isColor(value: unknown): value is C
  mix(from: C, to: C, t: number): C
}

// Upstream resolve.ts: a stateful color's state() picks the first active state in this order.
const STATES = ["disabled", "pressed", "focused", "selected", "hovered"] as const
type Tree = Record<string, unknown>
const isTree = (value: unknown): value is Tree => value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * Blends two resolved token trees: colors mix, numbers interpolate, equal-length arrays blend item
 * by item, keys only one side has are kept; anything else (functions, mismatched shapes) switches
 * at the midpoint. A blended stateful color gets a state() over its own blended colors.
 */
export function blendTree<C>(from: unknown, to: unknown, t: number, ops: ColorOps<C>): unknown {
  if (ops.isColor(from) && ops.isColor(to)) return ops.mix(from, to, t)
  if (typeof from === "number" && typeof to === "number") return from + (to - from) * t
  if (Array.isArray(from) && Array.isArray(to))
    return from.length === to.length ? from.map((item, index) => blendTree(item, to[index], t, ops)) : t < 0.5 ? from : to
  if (ops.isColor(from) || ops.isColor(to) || !isTree(from) || !isTree(to)) return t < 0.5 ? from : to
  const result: Tree = {}
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (!(key in to)) result[key] = from[key]
    else if (!(key in from)) result[key] = to[key]
    else result[key] = blendTree(from[key], to[key], t, ops)
  }
  if (typeof result.state === "function")
    result.state = (states: Partial<Record<(typeof STATES)[number], boolean>>) => result[STATES.find((state) => states[state]) ?? "base"]
  return result
}

/**
 * One frame of the transition between two resolved themes. The ends are the themes themselves, so
 * the transition ends on exactly the real theme. Between them, surface("dialog") blends the two
 * dialog views and hue-step lookups (source/increase/decrease) are identity for the few frames.
 */
export function themeAt<T extends object, C>(from: T, to: T, t: number, ops: ColorOps<C>): T {
  if (t <= 0) return from
  if (t >= 1) return to
  const surfaces = new Map<unknown, T>()
  const surface = (theme: T, name: unknown) => (theme as unknown as { surface(name: unknown): T }).surface(name)
  return {
    ...(blendTree(from, to, t, ops) as T),
    source: () => undefined,
    increase: (color: unknown) => color,
    decrease: (color: unknown) => color,
    surface(name: unknown) {
      const hit = surfaces.get(name)
      if (hit) return hit
      const view = themeAt(surface(from, name), surface(to, name), t, ops)
      surfaces.set(name, view)
      return view
    },
  }
}
