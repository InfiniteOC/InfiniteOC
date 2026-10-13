// InfiniteOC awareness tools: detected project checks plus an on-demand
// cheat-sheet for every custom tool's exact input shape. Written to
// packages/core/src/plugin/infiniteoc-awareness.ts by mods/awareness next to
// infiniteoc-awareness-lib.ts (the pure helpers; see lib.ts). Both tools are
// read-only: project_checks reads manifest file names and scripts only (never
// .env or secrets) and tool_guide returns static text. Nothing here executes
// commands, writes files, or changes permissions.
import { define } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import * as L from "./infiniteoc-awareness-lib.js"

const failure = (error: unknown) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) })

export const Plugin = define({
  id: "infiniteoc.awareness",
  effect: Effect.fn(function* (ctx) {
    const directory = String(ctx.location.directory)

    const loadProject = (): L.Project => {
      let files: string[] = []
      try {
        files = readdirSync(directory)
      } catch {}
      return {
        files,
        read: (name: string) => {
          const full = path.resolve(directory, name)
          if (full !== directory && !full.startsWith(directory + path.sep)) return undefined
          try {
            const text = readFileSync(full, "utf8")
            return text.length > 200_000 ? text.slice(0, 200_000) : text
          } catch {
            return undefined
          }
        },
      }
    }

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: "project_checks",
          options: { codemode: false },
          description:
            "Detected build/test/type/lint commands for this project (package.json scripts, Makefile, Cargo, Go, pytest). Call it before claiming how to build, test or lint; run the returned command instead of guessing.",
          input: { type: "object", properties: {} },
          execute: () =>
            Effect.try({
              try: () => ({ content: L.formatChecks(L.detectChecks(loadProject())) }),
              catch: failure,
            }),
        })
        editor.add({
          name: "tool_guide",
          options: { codemode: false },
          description:
            "Exact input shapes and when-to-use for every InfiniteOC custom tool (free_port, env_diff, project_checks, memory, repo_map, ui_check, ...). Call it with a tool name, or with no input for the full cheat-sheet, when unsure how to call a tool.",
          input: Schema.Struct({
            tool: Schema.optionalKey(Schema.String).annotate({ description: "Tool name, e.g. free_port or ui_check. Omit for all tools." }),
          }),
          execute: (input) => Effect.succeed({ content: L.toolGuide((input as { tool?: string }).tool) }),
        })
      })
      .pipe(Effect.orDie)
  }),
})
