// InfiniteOC: "/goal" at the start of the prompt glows with a purple-to-pink wave while typed.
// Copied to packages/tui/src/component/prompt/goal-word.ts by mods/infiniteoc.
// Uses its own extmark type (non-virtual, so editing is unaffected) and a small style palette.
import type { SyntaxStyle, TextareaRenderable } from "@opentui/core"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { tint } from "../../theme/color"
import type { ComponentTheme } from "../../theme/component"

export const GOAL_WORD = /^\/goal(?=\s|$)/
const FRAMES = 16
const LENGTH = "/goal".length

export function createGoalWord(input: () => TextareaRenderable | undefined, text: () => string, syntax: () => SyntaxStyle, theme: ComponentTheme, animations: () => boolean) {
  let typeId = 0
  let frame = 0
  const palette = createMemo(() => {
    const style = syntax()
    const from = theme.hue.interactive[400]
    const to = theme.hue.accent[300]
    // One full cycle there and back, so the wave loops without a seam.
    return Array.from({ length: FRAMES }, (_, index) =>
      style.registerStyle(`infiniteoc.goal.${index}`, { fg: tint(from, to, (1 - Math.cos((index / FRAMES) * 2 * Math.PI)) / 2), bold: true }),
    )
  })
  const active = createMemo(() => GOAL_WORD.test(text()))
  const paint = () => {
    const element = input()
    if (!element || element.isDestroyed) return
    if (!typeId) typeId = element.extmarks.registerType("infiniteoc-goal")
    for (const mark of element.extmarks.getAllForTypeId(typeId)) element.extmarks.delete(mark.id)
    if (!GOAL_WORD.test(element.plainText)) return
    const ids = palette()
    for (let index = 0; index < LENGTH; index++)
      element.extmarks.create({ start: index, end: index + 1, styleId: ids[(index * 3 + frame) % FRAMES], typeId, virtual: false })
    frame = (frame + 1) % FRAMES
    element.requestRender()
  }
  createEffect(() => {
    palette()
    if (!active()) return paint()
    paint()
    if (!animations()) return
    const timer = setInterval(paint, 70)
    onCleanup(() => clearInterval(timer))
  })
}
