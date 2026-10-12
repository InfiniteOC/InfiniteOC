// InfiniteOC: source-only branding; no network or permission hooks.
// Written to packages/tui/src/component/logo.tsx by mods/infiniteoc/index.mjs.
import {
  OptimizedBuffer,
  RGBA,
  StyledText,
  TargetChannel,
  TextAttributes,
  TextRenderable,
  type RenderContext,
  type TextChunk,
  type TextOptions,
} from "@opentui/core"
import { extend, useTerminalDimensions } from "@opentui/solid"
import { createMemo } from "solid-js"
import { useConfig } from "../config"
import { useTheme } from "../context/theme"
import { tint } from "../theme/color"
import { logo } from "../logo"
import { coast, intensityAt, smootherstep } from "./tab-pulse"

const REVEAL = 450 // ms: diagonal wipe in from the background
const HOLD = 150 // ms between the wipe and the glint
const SHEEN = 1000 // ms: one highlight pass, then the logo stays still
const FEATHER = 6 // columns of soft edge on the wipe
const SLANT = 2 // columns each row lags the row above, so wipe and glint lean like "/"
const SHEEN_PEAK = 0.55
const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0)
// Native text draws wide glyphs as a head followed by flagged continuation cells.
const CONTINUATION = 0xc0000000 | 0
const clamp = (value: number) => Math.max(0, Math.min(1, value))
// Home remounts whenever you return to it; like upstream, an idle screen never animates.
let introPlayed = false

// extend() derives the JSX props from the constructor options.
type WordmarkOptions = TextOptions & { styled?: StyledText; backdrop?: RGBA; sheen?: RGBA; motion?: boolean }

// Masked like upstream masked-text.ts, but row-aware (slant) and the wipe also fades the
// shadow backgrounds. Live only during the 1.6s intro: a live renderable forces 60fps frames.
class WordmarkRenderable extends TextRenderable {
  private scratch: OptimizedBuffer | undefined
  private mask = new Float32Array(0)
  private matrix = new Float32Array(16)
  private _backdrop = RGBA.defaultBackground()
  private _sheen = RGBA.fromInts(255, 255, 255)
  private elapsed: number | undefined
  private fresh = true

  constructor(ctx: RenderContext, options: WordmarkOptions) {
    super(ctx, options)
    this.matrix[15] = 1
  }

  // The Solid reconciler stringifies a `content` prop, so styled chunks arrive here instead.
  set styled(value: StyledText) {
    this.content = value
  }

  set backdrop(value: RGBA) {
    this._backdrop = value
    this.requestRender()
  }

  set sheen(value: RGBA) {
    this._sheen = value
  }

  set motion(value: boolean) {
    if (value && !introPlayed) {
      introPlayed = true
      this.elapsed = 0
      this.fresh = true
      this.live = true
    } else if (!value && this.elapsed !== undefined) {
      this.elapsed = undefined
      this.live = false
    }
    this.requestRender()
  }

  override render(buffer: OptimizedBuffer, deltaTime: number) {
    if (!this.visible || this.isDestroyed || !Number.isFinite(this.width) || this.width <= 0 || this.height <= 0) return
    if (this.elapsed === undefined) return super.render(buffer, deltaTime)
    // The first live frame must not inherit idle time from before the intro started, and a
    // stalled boot frame slows the wipe instead of skipping it (like ui/animation.ts's clamp).
    const elapsed = (this.elapsed += this.fresh ? 0 : Math.min(deltaTime, 50))
    this.fresh = false
    const wipe = elapsed < REVEAL
    const pass = (elapsed - REVEAL - HOLD) / SHEEN
    if (pass >= 1) {
      this.elapsed = undefined
      this.live = false
    }
    if (!wipe && (pass < 0 || pass >= 1)) return super.render(buffer, deltaTime)

    if (!this.scratch)
      this.scratch = OptimizedBuffer.create(this.width, this.height, this._ctx.widthMethod, { respectAlpha: true })
    if (this.scratch.width !== this.width || this.scratch.height !== this.height) this.scratch.resize(this.width, this.height)
    this.scratch.clear(TRANSPARENT)
    this.scratch.drawTextBuffer(this.textBufferView, 0, 0)
    const characters = this.scratch.buffers.char
    let end = 0
    for (let row = 0; row < this.height; row++) {
      let column = this.width
      while (column > 0 && (characters[row * this.width + column - 1] === 32 || characters[row * this.width + column - 1] === 0)) column--
      end = Math.max(end, column)
    }
    // Every row travels the same distance; lower rows start SLANT columns later.
    const span = end + SLANT * (this.height - 1)
    const color = wipe ? this._backdrop : this._sheen
    this.matrix[3] = color.r
    this.matrix[7] = color.g
    this.matrix[11] = color.b
    const front = wipe ? -FEATHER + coast(elapsed / REVEAL) * (span + FEATHER * 2) : -3 + coast(pass) * (span + 13)
    const shade = wipe
      ? (position: number) => 1 - smootherstep(clamp((front - position) / FEATHER))
      : (position: number) => SHEEN_PEAK * intensityAt(position, front, 3, 10)
    if (this.mask.length !== this.width * this.height * 3) this.mask = new Float32Array(this.width * this.height * 3)
    let strength = 0
    for (let cell = 0; cell < characters.length; cell++) {
      const column = cell % this.width
      const row = Math.floor(cell / this.width)
      if ((characters[cell] & CONTINUATION) !== CONTINUATION) strength = shade(column + row * SLANT)
      this.mask[cell * 3] = column
      this.mask[cell * 3 + 1] = row
      this.mask[cell * 3 + 2] = strength
    }
    this.scratch.colorMatrix(this.matrix, this.mask, 1, wipe ? TargetChannel.Both : TargetChannel.FG)
    buffer.drawFrameBuffer(this.screenX, this.screenY, this.scratch)
    this.markClean()
    this._ctx.addToHitGrid(this.screenX, this.screenY, this.width, this.height, this.num)
  }

  override destroy() {
    this.scratch?.destroy()
    this.scratch = undefined
    super.destroy()
  }
}

extend({ infiniteoc_wordmark: WordmarkRenderable })

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    infiniteoc_wordmark: typeof WordmarkRenderable
  }
}

const chunk = (text: string, fg: RGBA, bg?: RGBA): TextChunk => ({ __isChunk: true, text, fg, bg })

export function Logo() {
  const theme = useTheme()
  const config = useConfig().data
  const dimensions = useTerminalDimensions()

  // Home pads 2 columns per side from 44 columns up, 1 below: pick the widest variant that fits.
  const lines = createMemo(() => {
    const width = dimensions().width
    if (width >= 44) return logo.left.map((line, index) => `${line} ${logo.right[index]}`)
    const right = logo.right.slice(1)
    if (width - 2 < logo.left[0].length) return right
    const pad = " ".repeat(logo.left[0].length - right[0].length)
    return [...logo.left, ...right.map((line) => pad + line)]
  })

  // Same encoding as upstream logo.tsx: _ shadow cell, ^ ▀ over shadow, ~ shadow ▀.
  const content = createMemo(() => {
    const from = theme.hue.interactive["200"]
    const to = theme.hue.accent["200"]
    const rows = lines()
    const width = Math.max(...rows.map((line) => line.length))
    const chunks: TextChunk[] = []
    rows.forEach((line, row) => {
      if (row > 0) chunks.push(chunk("\n", from))
      Array.from(line).forEach((char, column) => {
        const fg = tint(from, to, width > 1 ? column / (width - 1) : 0)
        const shadow = tint(theme.background.base, fg, 0.25)
        if (char === "_") chunks.push(chunk(" ", fg, shadow))
        else if (char === "^") chunks.push(chunk("▀", fg, shadow))
        else if (char === "~") chunks.push(chunk("▀", shadow))
        else chunks.push(chunk(char, fg))
      })
    })
    return new StyledText(chunks)
  })

  return (
    <box>
      {dimensions().height < 12 ? null : (
        <infiniteoc_wordmark
          styled={content()}
          backdrop={theme.background.base}
          sheen={theme.hue.accent["100"]}
          motion={config.animations ?? true}
          attributes={TextAttributes.BOLD}
          wrapMode="none"
          selectable={false}
        />
      )}
    </box>
  )
}
