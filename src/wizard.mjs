// First-run wizard: provider, model, theme, update mode, ponytail level. It only writes through the same stores the
// TUI settings dialog uses (settings-store.mjs) plus the two plain files OpenCode reads for the theme and ponytail.
// Every question has a default (Enter), so Enter all the way through changes nothing but the "done" marker.
import { readFile, writeFile, rename, access, mkdir } from "node:fs/promises"
import { createInterface } from "node:readline"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { loadSettings, saveSettings, saveProvider, providerProtocols, providerConfigFile, settingsFile } from "../mods/infiniteoc/settings/settings-store.mjs"
import { UPDATE_MODES } from "./updater.mjs"

export const THEMES = ["infiniteoc", "tokyonight", "catppuccin", "gruvbox", "nord", "dracula", "one-dark", "solarized", "rosepine", "kanagawa", "github", "monokai", "matrix", "synthwave84"]
export const PONYTAIL_LEVELS = ["auto", "lite", "full", "ultra", "off"]
const PROTOCOLS = [
  ["anthropic", "Anthropic", "https://api.anthropic.com/v1"],
  ["openai-completions", "OpenAI-compatible (chat completions)", "https://api.openai.com/v1"],
  ["openai-responses", "OpenAI (responses API)", "https://api.openai.com/v1"],
]
const exists = (path) => access(path).then(() => true, () => false)
const dataDir = (env) => join(env.XDG_DATA_HOME || join(homedir(), ".local/share"), "opencode")
const configDir = (env) => join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")

/** Only a brand-new installation on a terminal: no settings file and no OpenCode data of any earlier use. */
export async function needsWizard({ env = process.env, tty = process.stdin.isTTY && process.stderr.isTTY } = {}) {
  if (!tty || env.CI) return false
  return !await exists(settingsFile(env)) && !await exists(dataDir(env))
}

/** Strict-JSON edit with a backup and an atomic write. Returns false (and changes nothing) for JSONC or unreadable files. */
async function editJson(file, change) {
  let raw = null, value = {}
  try { raw = await readFile(file, "utf8"); value = JSON.parse(raw) } catch (error) { if (error.code !== "ENOENT") return false }
  if (value === null || typeof value !== "object" || Array.isArray(value) || file.endsWith(".jsonc")) return false
  change(value)
  await mkdir(dirname(file), { recursive: true })
  if (raw !== null) await writeFile(`${file}.${Date.now()}.bak`, raw, { mode: 0o600 })
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  await rename(`${file}.tmp`, file)
  return true
}

/** Terminal prompts on stderr. ask() resolves undefined at end of input or Ctrl+C; secret input is not echoed. */
export function terminalIO(input = process.stdin, output = process.stderr) {
  const rl = createInterface({ input, output, terminal: true })
  let muted = false, closed = false
  rl._writeToOutput = (text) => { if (!muted) output.write(text) }
  const waiting = new Set()
  rl.on("close", () => { closed = true; for (const resolve of waiting) resolve(undefined) })
  return {
    say: (text = "") => output.write(`${text}\n`),
    ask: (question, { secret = false } = {}) => new Promise((resolve) => {
      if (closed) return resolve(undefined)
      waiting.add(resolve)
      output.write(question)
      muted = secret
      rl.question("", (answer) => { muted = false; waiting.delete(resolve); if (secret) output.write("\n"); resolve(answer.trim()) })
    }),
    close: () => rl.close(),
  }
}

/** Resolves `answer` against numbered options: a number, an option's own text, or Enter for the default. */
const pick = (answer, options, fallback) => {
  if (!answer) return fallback
  const byNumber = options[Number(answer) - 1]
  return byNumber ?? options.find((option) => option === answer.toLowerCase())
}

export async function runWizard({ io, env = process.env, settingsPath = settingsFile(env), configFile = providerConfigFile(env), now = new Date() }) {
  const done = []
  const menu = async (title, options, fallback, label = (option) => option) => {
    io.say(`\n${title}`)
    options.forEach((option, index) => io.say(`  ${index + 1}. ${label(option)}${option === fallback ? "  (default)" : ""}`))
    for (;;) {
      const answer = await io.ask(`Choice [${options.indexOf(fallback) + 1}]: `)
      if (answer === undefined) return undefined
      const chosen = pick(answer, options, fallback)
      if (chosen !== undefined) return chosen
      io.say("Enter one of the numbers above, or press Enter for the default.")
    }
  }
  const current = await loadSettings(settingsPath).catch(() => undefined)
  if (!current) throw new Error(`${settingsPath} is unreadable; fix or delete it, then run infiniteoc wizard`)
  io.say("InfiniteOC setup. Press Enter to accept the default for any question; Ctrl+C skips the rest.")
  let aborted = false
  let model
  try {
    // 1. provider
    const add = await io.ask("\nAdd a model provider now? (y/N): ")
    if (add === undefined) throw Object.assign(new Error("skipped"), { skipped: true })
    if (/^y/i.test(add)) {
      const [protocol, , baseURL] = await menu("Provider type", PROTOCOLS, PROTOCOLS[0], (option) => option[1]) ?? []
      if (!protocol) throw Object.assign(new Error("skipped"), { skipped: true })
      for (let attempt = 0; attempt < 3 && !model; attempt++) {
        const id = await io.ask(`Provider ID [${protocol.split("-")[0]}]: `)
        const url = await io.ask(`Base URL [${baseURL}]: `)
        const models = await io.ask("Model IDs, comma separated: ")
        const key = await io.ask("API key, or {env:NAME} to read an environment variable (Enter for none): ", { secret: true })
        if ([id, url, models, key].includes(undefined)) throw Object.assign(new Error("skipped"), { skipped: true })
        try {
          const saved = await saveProvider({ id: id || protocol.split("-")[0], protocol, baseURL: url || baseURL, models, apiKey: key }, { configFile, settingsFile: settingsPath })
          done.push(`provider ${saved.id}`)
          model = { provider: saved.id, models: saved.models }
        } catch (error) { io.say(`Could not add the provider: ${error.message}`) }
      }
    }
    // 2. default model
    if (model) {
      const choice = await menu("Default model", model.models, model.models[0])
      if (choice === undefined) throw Object.assign(new Error("skipped"), { skipped: true })
      if (await editJson(configFile, (value) => { value.model = `${model.provider}/${choice}` })) done.push(`model ${model.provider}/${choice}`)
      else io.say("Could not set the default model (the config file is not strict JSON); pick it with /models.")
    } else {
      const typed = await io.ask("\nDefault model as provider/model (Enter to keep what you have): ")
      if (typed === undefined) throw Object.assign(new Error("skipped"), { skipped: true })
      if (typed && /^[^\s/]+\/\S+$/.test(typed) && await editJson(configFile, (value) => { value.model = typed })) done.push(`model ${typed}`)
      else if (typed) io.say("Not changed: use provider/model, for example anthropic/claude-sonnet-4-5.")
    }
    // 3. theme
    const theme = await menu("Theme", THEMES, THEMES[0])
    if (theme === undefined) throw Object.assign(new Error("skipped"), { skipped: true })
    if (theme !== THEMES[0] && await editJson(join(configDir(env), "cli.json"), (value) => { value.theme = { ...value.theme, name: theme } })) done.push(`theme ${theme}`)
    // 4. update mode
    const mode = await menu("When a new InfiniteOC version is available", UPDATE_MODES, current.updates?.mode ?? "auto", (option) => ({ auto: "auto: install at launch after a 5 second countdown", ask: "ask: ask at launch", off: "off: never check" })[option])
    if (mode === undefined) throw Object.assign(new Error("skipped"), { skipped: true })
    if (mode !== (current.updates?.mode ?? "auto")) { current.updates = { ...current.updates, mode }; done.push(`updates ${mode}`) }
    // 5. ponytail level
    const level = await menu("Ponytail (keep solutions small and simple)", PONYTAIL_LEVELS, "auto", (option) => ({ auto: "auto: when the request writes code", lite: "lite", full: "full: every coding turn", ultra: "ultra", off: "off" })[option])
    if (level === undefined) throw Object.assign(new Error("skipped"), { skipped: true })
    if (level !== "auto") {
      const file = join(configDir(env), ".ponytail-active")
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, level)
      done.push(`ponytail ${level}`)
    }
  } catch (error) {
    if (!error.skipped) throw error
    aborted = true
  }
  await saveSettings({ ...current, wizard: { done: true, at: now.toISOString(), skipped: aborted || undefined } }, settingsPath)
  io.say(`\n${done.length ? `Saved: ${done.join(", ")}.` : "No changes."} Change any of this later with /settings, or run infiniteoc wizard.`)
  return { done, aborted }
}
