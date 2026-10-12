// Terminal effects for the launcher: a purple-to-pink gradient with a moving sheen, a spinner and a
// rounded box. Everything degrades to plain text without a TTY, with NO_COLOR, or when motion is off.
const FROM = [192, 132, 252] // InfiniteOC purple
const TO = [244, 114, 182] // InfiniteOC pink
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function fx(stream = process.stderr, { motion = true } = {}) {
  const tty = !!stream.isTTY
  const color = tty && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb"
  const animate = color && motion
  const rgb = ([r, g, b], text) => (color ? `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m` : text)
  const mix = (t) => FROM.map((from, index) => Math.round(from + (TO[index] - from) * t))
  const lift = (value, amount) => value.map((channel) => Math.round(channel + (255 - channel) * amount))
  // Gradient across the text; `phase` (0..1) moves a bright sheen through it.
  const gradient = (text, phase) => {
    const chars = [...text]
    return chars
      .map((char, index) => {
        const t = chars.length > 1 ? index / (chars.length - 1) : 0
        const sheen = phase === undefined ? 0 : Math.max(0, 1 - Math.abs(t - (phase * 1.6 - 0.3)) * 6)
        return rgb(lift(mix(t), sheen * 0.75), char)
      })
      .join("")
  }
  const bold = (text) => (color ? `\x1b[1m${text}\x1b[22m` : text)
  const dim = (text) => (color ? `\x1b[2m${text}\x1b[22m` : text)
  const ok = (text) => `${rgb([134, 239, 172], "✓")} ${text}`
  const fail = (text) => `${rgb([252, 165, 165], "✗")} ${text}`
  const write = (text) => stream.write(text)
  const line = (text) => write(`${tty ? "\r\x1b[2K" : ""}${text}`)

  // Rounded box; widths are measured in code points, which is enough for this ASCII-and-box-drawing text.
  const box = (rows, width = Math.max(...rows.map((row) => [...row.plain].length)) + 4) => {
    const pad = (row) => `${row.text}${" ".repeat(Math.max(0, width - 4 - [...row.plain].length))}`
    const edge = (text) => rgb(mix(0.35), text)
    return [edge(`╭${"─".repeat(width - 2)}╮`), ...rows.map((row) => `${edge("│")} ${pad(row)} ${edge("│")}`), edge(`╰${"─".repeat(width - 2)}╯`)].join("\n")
  }

  // Runs `task` behind an animated spinner line and closes it with a check mark or a cross.
  async function spin(label, task) {
    const started = Date.now()
    let frame = 0
    const draw = () => line(`${gradient(FRAMES[frame++ % FRAMES.length])} ${label} ${dim(`${((Date.now() - started) / 1000).toFixed(1)}s`)}`)
    if (!tty) write(`${label}…`)
    const timer = animate ? setInterval(draw, 80) : undefined
    if (tty) draw()
    try {
      const value = await task()
      line(`${tty ? "" : " "}${ok(`${label} ${dim(`${((Date.now() - started) / 1000).toFixed(1)}s`)}`)}\n`)
      return value
    } catch (error) {
      line(`${tty ? "" : " "}${fail(label)}\n`)
      throw error
    } finally {
      clearInterval(timer)
    }
  }

  // Plays the sheen across a single line a few times, leaving the static gradient behind.
  async function shimmer(text, { passes = 1, duration = 700 } = {}) {
    if (!animate) return void write(`${gradient(text)}\n`)
    const frames = Math.round(duration / 33)
    for (let pass = 0; pass < passes; pass++)
      for (let index = 0; index <= frames; index++) {
        line(gradient(text, index / frames))
        await new Promise((resolve) => setTimeout(resolve, 33))
      }
    line(`${gradient(text)}\n`)
  }

  return { tty, color, animate, gradient, bold, dim, ok, fail, write, line, box, spin, shimmer }
}
