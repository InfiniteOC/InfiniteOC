// InfiniteOC frontend gate: edits to UI files are refused until the session has loaded the
// frontend-design skill, so every agent and model follows it whatever its prompt adherence.
// Written to packages/core/src/plugin/infiniteoc-frontend.ts by mods/infiniteoc.
// The check reads the current context, so a compaction that drops the skill asks for it again.
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"

export const SKILL = "frontend-design"
// ponytail: matched by extension; a plain .ts/.js file that renders UI is not gated (the guidance still asks for the skill).
const UI_FILE = /\.(html?|css|scss|sass|less|styl|jsx|tsx|vue|svelte|astro|mdx|hbs|ejs|njk|liquid|twig|erb)$/i

export const isUiFile = (file: string) => UI_FILE.test(file)

/** Files an edit, write or patch call would create or change. */
export function targets(tool: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return []
  const value = input as { path?: unknown; patchText?: unknown }
  if ((tool === "edit" || tool === "write") && typeof value.path === "string") return [value.path]
  if (tool === "patch" && typeof value.patchText === "string")
    return [...value.patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((match) => (match[1] ?? match[2]).trim())
  return []
}

/** True when the skill is in context: activated directly, or loaded through a completed skill tool call. */
export const loaded = (messages: ReadonlyArray<SessionMessage.Info>) =>
  messages.some((message) =>
    message.type === "skill"
      ? message.skill === SKILL
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
