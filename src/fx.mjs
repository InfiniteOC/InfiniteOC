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

  // A multi-step job (the build): the running step is a live block — spinner, its latest output line and
  // an overall bar — and each finished step leaves a ✓ line. `estimates` (ms per step, from the previous
  // run) turn the bar into an ETA; without them it counts steps. Animated terminals only; callers check
  // `animate` and fall back to plain lines.
  function progress(total, estimates) {
    const timings = []
    const known = Array.isArray(estimates) && estimates.length === total && estimates.every((ms) => Number.isFinite(ms) && ms > 0)
    const sum = (values) => values.reduce((a, b) => a + b, 0)
    const width = () => Math.max(20, (stream.columns || 80) - 1)
    const clip = (text, max) => ([...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text)
    let drawn = 0
    // Redraws the block in place: back to its first line, clear to the end of the screen, print.
    const paint = (lines) => {
      write(`\r${drawn > 1 ? `\x1b[${drawn - 1}A` : ""}\x1b[J${lines.join("\n")}`)
      drawn = lines.length
    }
    const showCursor = () => write("\x1b[?25h")
    async function step(label, task) {
      const index = timings.length
      const started = Date.now()
      const kept = []
      let partial = ""
      // Child output arrives in chunks; keep whole lines (for the tail and a failure) plus the line in progress.
      const output = (chunk) => {
        const parts = (partial + chunk.toString()).split(/\r\n|\n|\r/)
        partial = parts.pop()
        for (const part of parts) if (plain(part).trim()) kept.push(plain(part).trimEnd())
        if (kept.length > 400) kept.splice(0, kept.length - 200)
      }
      const latest = () => plain(partial).trim() || kept.at(-1)?.trim() || ""
      let frame = 0
      const draw = () => {
        const elapsed = Date.now() - started
        const head = `${gradient(FRAMES[frame % FRAMES.length])} ${clip(label, width() - 10)} ${dim(clock(elapsed))}`
        let fraction, note
        if (known) {
          const done = sum(timings)
          const left = Math.max(0, estimates[index] - elapsed) + sum(estimates.slice(index + 1))
          fraction = (done + elapsed) / (done + elapsed + left)
          note = left > 1000 ? `~${clock(left, true)} left` : "almost done"
        } else {
          fraction = index / total
          note = `step ${index + 1} of ${total}`
        }
        const size = Math.min(30, width() - 24)
        const filled = Math.max(1, Math.round(fraction * size))
        // The sheen sweeps the filled part of the bar while the step runs.
        const bar = `  ${gradient("■".repeat(filled), (frame % 30) / 30)}${dim("□".repeat(size - filled))} ${dim(`${Math.floor(fraction * 100)}% · ${note}`)}`
        const tail = latest()
        paint([head, ...(tail ? [`  ${dim(`╰ ${clip(tail, width() - 4)}`)}`] : []), bar])
        frame++
      }
      write("\x1b[?25l")
      process.once("exit", showCursor)
      draw()
      const timer = setInterval(draw, 80)
      try {
        const value = await task(output)
        timings.push(Date.now() - started)
        paint([ok(`${label} ${dim(clock(Date.now() - started))}`)])
        write("\n")
        return value
      } catch (error) {
        // The captured output is the only copy on screen: show its end so the failure explains itself.
        const lines = [...kept, ...(plain(partial).trim() ? [plain(partial)] : [])].slice(-30)
        paint([fail(label), ...lines.map((text) => `  ${dim(clip(text, width() - 2))}`)])
        write("\n")
        throw error
      } finally {
        clearInterval(timer)
        drawn = 0
        showCursor()
        process.off("exit", showCursor)
      }
    }
    return { step, timings }
  }

  return { tty, color, animate, gradient, bold, dim, ok, fail, write, line, box, spin, shimmer, progress }
}

// Child output without colors or control characters, for one-line display.
const plain = (text) => text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
// "4.2s" while it runs; "1m 05s" for longer spans; whole seconds for estimates.
export function clock(ms, whole = false) {
  const seconds = ms / 1000
  if (seconds < 60) return whole ? `${Math.max(1, Math.round(seconds))}s` : `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`
}
