// InfiniteOC frontend gate: edits to UI files are refused until the session has loaded the
// frontend-design skill, so every agent and model follows it whatever its prompt adherence.
// Written to packages/core/src/plugin/infiniteoc-frontend.ts by mods/infiniteoc.
// The check reads the current context, so a compaction that drops the skill asks for it again.
// A request that is clearly web UI work gets the skill attached to the prompt, so the first UI write is
// not refused and written again.
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Skill } from "@opencode/schema/skill"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import path from "node:path"

export const SKILL = "frontend-design"
// ponytail: matched by extension; a plain .ts/.js file that renders UI is not gated (the guidance still asks for the skill).
const UI_FILE = /\.(html?|css|scss|sass|less|styl|jsx|tsx|vue|svelte|astro|mdx|hbs|ejs|njk|liquid|twig|erb)$/i

export const isUiFile = (file: string) => UI_FILE.test(file)

// Clear signs of web UI work in a request. Narrow on purpose: a miss falls back to the gate's refusal, and a
// false match only adds the skill's text to the context.
const UI_REQUEST = /\b(?:web ?apps?|web ?sites?|web ?pages?|landing pages?|front-?end|user interfaces?|html|css|dashboards?|single[- ]page apps?|react|vue|svelte|angular|tailwind)\b/i

export const wantsUi = (text: string) => UI_REQUEST.test(text) || /\bUI\b/.test(text)

/** The bundled skill, which the launcher points INFINITEOC_SKILLS at; others are left to the gate. */
export const bundled = (env: NodeJS.ProcessEnv = process.env) =>
  !!env.INFINITEOC_SKILLS && existsSync(path.join(env.INFINITEOC_SKILLS, SKILL, "SKILL.md"))

/** Files an edit, write or patch call would create or change. */
export function targets(tool: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return []
  const value = input as { path?: unknown; patchText?: unknown }
  if ((tool === "edit" || tool === "write") && typeof value.path === "string") return [value.path]
  if (tool === "patch" && typeof value.patchText === "string")
    return [...value.patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((match) => (match[1] ?? match[2]).trim())
  return []
}

/** True when the skill is in context: activated directly, attached to a prompt, or loaded through a completed skill tool call. */
export const loaded = (messages: ReadonlyArray<SessionMessage.Info>) =>
  messages.some((message) =>
    message.type === "skill"
      ? message.skill === SKILL
      : message.type === "user"
        ? (message.skills ?? []).some((skill) => skill.id === SKILL && skill.text !== undefined)
        : message.type === "assistant" &&
          message.content.some((part) => part.type === "tool" && part.name === "skill" && part.state.status === "completed" && part.state.input.id === SKILL),
  )

export const refusal = (files: ReadonlyArray<string>) =>
  `Refused: ${files.join(", ")} is user-facing UI and the ${SKILL} skill is not loaded in this session. ` +
  `Call the skill tool with id "${SKILL}" now, follow it (mode, design plan, quality floor, render and inspect), then retry this edit. ` +
  `This is required once per session for every agent and model.`

export const Plugin = define({
  id: "infiniteoc.frontend",
  effect: Effect.fn(function* (ctx) {
    // Without this, every gated eval run wrote a UI file first, was refused, loaded the skill and wrote the file again.
    yield* ctx.session.hook("prompt", (event) =>
      Effect.gen(function* () {
        if (!wantsUi(event.prompt.text) || event.prompt.skills?.some((skill) => skill.id === SKILL) || !bundled()) return
        if (loaded(yield* ctx.session.context({ sessionID: event.sessionID }))) return
        event.prompt.skills = [...(event.prompt.skills ?? []), { id: Skill.ID.make(SKILL) }]
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("InfiniteOC frontend skill attach failed", { cause }))),
    )
    yield* ctx.tool.hook("execute.before", (event) => {
      const files = targets(event.tool, event.input).filter(isUiFile)
      if (files.length === 0) return Effect.void
      return ctx.session.context({ sessionID: event.sessionID }).pipe(
        Effect.map(loaded),
        // Fail open: an unreadable transcript must not block editing.
        Effect.catchCause((cause) => Effect.logWarning("InfiniteOC frontend gate check failed", { cause }).pipe(Effect.as(true))),
        Effect.flatMap((loaded) => (loaded ? Effect.void : Effect.fail(new Tool.Error({ message: refusal(files) })))),
      )
    })
  }),
})
