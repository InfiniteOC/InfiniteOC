// The TUI's block-character wordmark (mods/infiniteoc/wordmark.mjs) as SVG for the web UI. A terminal
// cell is 1 wide and 2 tall (█ both halves, ▀ top, ▄ bottom); colors match the TUI: a left-to-right
// gradient from the theme's interactive hue to its accent, and shadow cells at 25% of it.
import { logo } from "../infiniteoc/wordmark.mjs"

// Rows of the full wordmark: "infinite" and "OC" side by side, as the TUI draws it on wide screens.
export const rows = logo.left.map((line, index) => `${line} ${logo.right[index]}`)

/** Rectangles per row in half-cell units: { x, y, w, h, shadow }. Adjacent cells of a kind are merged. */
export function cells(lines = rows) {
  const out = []
  lines.forEach((line, row) => {
    const top = row * 2
    const halves = [[], []] // [top half, bottom half] → "fg" | "shadow" | undefined, per column
    Array.from(line).forEach((char, column) => {
      const [upper, lower] =
        char === "█" ? ["fg", "fg"]
        : char === "▀" ? ["fg", undefined]
        : char === "▄" ? [undefined, "fg"]
        : char === "_" ? ["shadow", "shadow"]
        : char === "^" ? ["fg", "shadow"]
        : char === "~" ? ["shadow", undefined]
        : [undefined, undefined]
      halves[0][column] = upper
      halves[1][column] = lower
    })
    halves.forEach((kinds, half) => {
      for (let column = 0; column < kinds.length; ) {
        const kind = kinds[column]
        let end = column + 1
        while (end < kinds.length && kinds[end] === kind) end++
        if (kind) out.push({ x: column, y: top + half, w: end - column, h: 1, shadow: kind === "shadow" })
        column = end
      }
    })
  })
  return out
}

/**
 * The wordmark as an SVG document. `from`/`to` are the gradient ends; CSS custom properties work too
 * (the web UI passes its theme variables so the logo follows the chosen theme).
 */
export function wordmarkSvg({ from = "#c084fc", to = "#f472b6", id = "ioc-wordmark", title = "InfiniteOC" } = {}) {
  const width = Math.max(...rows.map((line) => Array.from(line).length))
  const height = rows.length * 2
  const rect = (cell) => `<rect x="${cell.x}" y="${cell.y}" width="${cell.w}" height="${cell.h}"${cell.shadow ? ' fill-opacity="0.25"' : ""}/>`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="${width}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>`,
    `<g fill="url(#${id})">${cells().map(rect).join("")}</g>`,
    "</svg>",
  ].join("")
}

/** The square mark for favicons and app icons: the wordmark's "OC", on a rounded tile. */
export function markSvg({ from = "#c084fc", to = "#f472b6", background = "#16101c", id = "ioc-mark" } = {}) {
  const oc = logo.right.slice(1)
  const width = Array.from(oc[0]).length
  const shapes = cells(oc)
  const pad = 1.5
  const size = width + pad * 2
  const y = (size - oc.length * 2) / 2
  const rect = (cell) => `<rect x="${cell.x + pad}" y="${cell.y + y}" width="${cell.w}" height="${cell.h}"${cell.shadow ? ' fill-opacity="0.25"' : ""}/>`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`,
    `<defs><linearGradient id="${id}" x1="${pad}" y1="0" x2="${size - pad}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>`,
    `<rect width="${size}" height="${size}" rx="2" fill="${background}"/>`,
    `<g fill="url(#${id})">${shapes.map(rect).join("")}</g>`,
    "</svg>",
  ].join("")
}
