// InfiniteOC ponytail: the lazy-senior-dev ruleset from github.com/DietrichGebert/ponytail (MIT,
// bundled in skills/ponytail*), off by default and applied only to turns that write code when enabled.
// Written to packages/core/src/plugin/infiniteoc-ponytail.ts by mods/infiniteoc, which inlines the
// skill body below. The block goes just before the turn's user message and is never persisted, so it
// stays put across one turn's steps (prompt cache friendly) and costs nothing on chat turns.
import { Message } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { TuiEvent } from "@opencode/schema/tui-event"
import { Effect } from "effect"
import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import path from "path"
import { Bus } from "../bus.js"

const SKILL_BODY: string = "__PONYTAIL_SKILL__"

export type Mode = "auto" | "off" | "lite" | "full" | "ultra"
export type Level = Exclude<Mode, "auto" | "off">
// Shipped default when no state file and no PONYTAIL_DEFAULT_MODE override exists.
export const DEFAULT_MODE: Mode = "off"
const MODES: ReadonlyArray<Mode> = ["auto", "off", "lite", "full", "ultra"]
const LEVELS: ReadonlyArray<string> = ["lite", "full", "ultra"]
// Agents that never write code get nothing.
const SKIP = new Set(["explore", "researcher", "reviewer", "title", "compaction", "summary"])

export const parseMode = (value: unknown): Mode | undefined => {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : ""
  return (MODES as ReadonlyArray<string>).includes(mode) ? (mode as Mode) : undefined
}

/** The ruleset for one level: the skill body without frontmatter and other levels' table rows. */
export function rules(level: Level, body = SKILL_BODY) {
  const text = body
    .replace(/^---[\s\S]*?---\s*/, "")
    .split("\n")
    .filter((line) => {
      const row = /^\|\s*\*\*(.+?)\*\*\s*\|/.exec(line)?.[1]?.trim().toLowerCase()
      return !row || !LEVELS.includes(row) || row === level
    })
    .join("\n")
  return `PONYTAIL MODE ACTIVE (level: ${level}). Off for this session: say "stop ponytail". Change: /ponytail lite|full|ultra|auto|off.\n\n${text.trim()}`
}

// Implementation intent: an action verb, and not phrased as a question or a request to explain.
const BUILD = /\b(add|implement|build|create|make|fix|refactor|write|change|update|remove|delete|rename|migrate|port|optimi[sz]e|support|wire|hook up|integrate|replace|rewrite|clean ?up|simplify|scaffold|set up|setup|debug|patch|bump|upgrade)\b/i
const ASK = /^\s*(what|why|how does|how do|explain|describe|tell me|summari[sz]e|compare|is it|is there|are there|can you explain|where is|which)\b/i
const LAZY = /\b(ponytail|yagni|be lazy|simplest|minimal|over-?engineer|bloat)\b/i
const EDIT_TOOLS = new Set(["edit", "write", "patch"])

const textOf = (message: Message) =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

/** Pure: the level to apply to this request, or undefined. */
export function decide(mode: Mode, agent: string, messages: ReadonlyArray<Message>): Level | undefined {
  if (mode === "off" || SKIP.has(agent)) return undefined
  const users = messages.flatMap((message, index) => (message.role === "user" && textOf(message).trim() ? [index] : []))
  // "stop ponytail" or "normal mode" as a whole message turns it off for the session; /ponytail turns it back on.
  for (const index of users.toReversed()) {
    const text = textOf(messages[index]).trim().toLowerCase().replace(/[.!?\s]+$/, "")
    if (text === "stop ponytail" || text === "normal mode") return undefined
    if (/^\/?ponytail\b/.test(text)) break
  }
  if (mode !== "auto") return mode
  if (agent === "general") return "full"
  const last = users.at(-1)
  if (last === undefined) return undefined
  const request = textOf(messages[last])
  if (LAZY.test(request)) return "full"
  const editing = messages
    .slice(last + 1)
    .some((message) => message.role === "assistant" && message.content.some((part) => part.type === "tool-call" && EDIT_TOOLS.has(part.name)))
  if (editing) return "full"
  return BUILD.test(request) && !ASK.test(request) ? "full" : undefined
}

const statePath = () => path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode", ".ponytail-active")
export const readMode = (): Mode => {
  try {
    return parseMode(readFileSync(statePath(), "utf8")) ?? parseMode(process.env.PONYTAIL_DEFAULT_MODE) ?? DEFAULT_MODE
  } catch {
    return parseMode(process.env.PONYTAIL_DEFAULT_MODE) ?? DEFAULT_MODE
  }
}

const commands = [
  ["ponytail-review", "over-engineering and quality review of the current changes"],
  ["ponytail-audit", "whole-repo audit: bugs, risk, load, tests, speed, bloat"],
  ["ponytail-debt", "list shortcut: comments as a debt ledger"],
  ["ponytail-gain", "ponytail's measured savings from its benchmark"],
  ["ponytail-help", "ponytail levels and commands"],
] as const

export const Plugin = define({
  id: "infiniteoc.ponytail",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const toast = (message: string) =>
      bus.publish(TuiEvent.ToastShow, { title: "Ponytail", message, variant: "info", duration: 4000 }).pipe(Effect.asVoid)

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "ponytail",
        description: "lazy senior dev mode: auto (default), lite, full, ultra, off",
        execute: (input) =>
          Effect.suspend(() => {
            const wanted = input.prompt.text.trim()
            const mode = wanted ? parseMode(wanted) : readMode() === "off" ? "auto" : readMode()
            if (!mode) return toast(`Unknown level "${wanted}". Use auto, lite, full, ultra or off.`)
            mkdirSync(path.dirname(statePath()), { recursive: true })
            writeFileSync(statePath(), mode)
            return toast(mode === "auto" ? "auto: applied to turns that write code" : mode === "off" ? "off" : `${mode}: applied to every coding agent turn`)
          }),
      })
      for (const [name, description] of commands)
        editor.add({
          name,
          description,
          execute: (input) =>
            ctx.session
              .prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text: `Load the ${name} skill with the skill tool and follow it.${input.prompt.text.trim() ? ` Target: ${input.prompt.text.trim()}` : ""}`,
                delivery: input.delivery,
              })
              .pipe(Effect.asVoid),
        })
    })

    yield* ctx.session.hook("context", (event) => {
      const level = decide(readMode(), event.agent, event.messages)
      if (!level) return Effect.void
      const last = event.messages.findLastIndex((message) => message.role === "user")
      event.messages.splice(last === -1 ? event.messages.length : last, 0, Message.user(rules(level)))
      return Effect.void
    })
  }),
})
