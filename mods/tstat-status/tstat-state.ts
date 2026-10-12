// InfiniteOC tstat: module-level state shared by the tstat plugin and the small patches in
// upstream files (zen, compact tool output, session-allowed permissions, theme detection).
// Copied to packages/tui/src/feature-plugins/system/ by mods/tstat-status.
import { createSignal } from "solid-js"
import { defaults, iconsFor, modeFromBackground, nerdEnabled, permissionKey, sanitize, type Settings } from "./tstat-logic"

const [settings, setSettings] = createSignal<Settings>(defaults)
export { settings }
export const applySaved = (saved: Parameters<typeof sanitize>[0]) => setSettings(sanitize(saved))

/** Zen mode hides tabs, sidebar and footer details; it is per run, not saved. */
export const [zen, setZen] = createSignal(false)
/** Expands every capped tool body at once. */
export const [expandAll, setExpandAll] = createSignal(false)

export const icons = () => iconsFor(nerdEnabled(settings().nerd, process.env))

const allowed = new Set<string>()
const scoped = (root: string, request: Parameters<typeof permissionKey>[0]) => `${root}\u0002${permissionKey(request)}`
export const allowForSession = (root: string, request: Parameters<typeof permissionKey>[0]) => void allowed.add(scoped(root, request))
export const isSessionAllowed = (root: string, request: Parameters<typeof permissionKey>[0]) => allowed.has(scoped(root, request))

type Palette = { getPalette(options?: { size?: number }): Promise<{ defaultBackground?: string | null }> }
/** Light or dark from the terminal background (OSC 11) for terminals that never send a theme-mode report. */
export async function detectMode(renderer: Palette) {
  const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, 500))
  const colors = await Promise.race([renderer.getPalette({ size: 16 }).catch(() => undefined), timeout])
  return modeFromBackground(colors?.defaultBackground ?? undefined)
}
