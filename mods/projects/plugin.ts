// InfiniteOC projects: the `project` tool. Written to packages/core/src/plugin/infiniteoc-projects.ts by
// mods/projects. create makes a project in the managed folder (asking first, like any write outside the
// session's directory) and moves the session into it; open moves to an existing one; list shows them.
// Moving uses upstream's own session move (the session_move tool's path): it lands at the next safe boundary.
import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { Permission } from "../permission.js"
import { AbsolutePath } from "../schema.js"
import * as Projects from "./infiniteoc-projects-lib.mjs"

export const TOOL = "project"

const Input = Schema.Struct({
  action: Schema.Literals(["create", "open", "list"]).annotate({
    description: "create: a new project in the InfiniteOC projects folder, then work there. open: move to an existing project. list: show them.",
  }),
  name: Schema.optionalKey(Schema.String).annotate({ description: "create/open: the project's name (a folder name is derived from it)." }),
  description: Schema.optionalKey(Schema.String).annotate({ description: "create: one line for its README." }),
  template: Schema.optionalKey(Schema.Literals(Projects.TEMPLATES)).annotate({
    description: "create: starter files. empty (README, .gitignore), node (package.json with node --test), python (pyproject.toml), web (index.html, style.css, main.js). Default empty.",
  }),
  move: Schema.optionalKey(Schema.Boolean).annotate({ description: "create: move the session into the new project (default true)." }),
})

const age = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  return minutes < 60 ? `${minutes}m ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`
}

export const Plugin = define({
  id: "infiniteoc.projects",
  effect: Effect.fn(function* (ctx) {
    const permission = yield* Permission.Service

    const move = (sessionID: string, directory: string) =>
      ctx.session.move({ sessionID: sessionID as never, directory: AbsolutePath.make(directory), delivery: "steer" })

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: TOOL,
          options: { codemode: false },
          description: [
            "Create, open and list projects in the InfiniteOC projects folder.",
            "When the user asks for something new (an app, a game, a site, a tool) and is not already in the folder it belongs in, create a project for it instead of writing into the current directory. open switches this session to another project.",
            "After create or open, the session moves at the next safe boundary: do not run tools that depend on the new directory in the same batch.",
          ].join("\n"),
          input: Input,
          execute: (input: typeof Input.Type, context: { sessionID: string; agent: string; messageID: unknown; id: unknown }) =>
            Effect.gen(function* () {
              const root = Projects.projectsRoot()
              if (input.action === "list") {
                const all = Projects.listProjects(root)
                if (!all.length) return { content: `No projects yet in ${root}. Create one with action "create".` }
                return { content: [`Projects in ${root}:`, ...all.slice(0, 50).map((item) => `- ${item.name} (${age(item.updated)})${item.description ? `: ${item.description}` : ""}`)].join("\n") }
              }
              if (!input.name?.trim()) return yield* Effect.fail(new ToolFailure({ message: `${input.action} needs a name.` }))
              if (input.action === "open") {
                const found = yield* Effect.try({ try: () => Projects.findProject(input.name!, root), catch: (error) => new ToolFailure({ message: (error as Error).message }) })
                yield* move(context.sessionID, found.dir)
                return { content: `Moving this session to ${found.dir}${found.description ? ` (${found.description})` : ""}. From the next step on, relative paths and commands run there.` }
              }
              const dir = path.join(root, Projects.slug(input.name))
              // Writing outside the session's directory: the same approval any tool asks for, savable for the whole folder.
              yield* permission.assert({
                action: "project",
                resources: [dir],
                save: [path.join(root, "*")],
                metadata: { name: input.name, template: input.template ?? "empty", root },
                sessionID: context.sessionID as never,
                agent: context.agent as never,
                source: { type: "tool", messageID: context.messageID as never, id: context.id as never },
              })
              const created = yield* Effect.try({ try: () => Projects.createProject(input, root), catch: (error) => new ToolFailure({ message: (error as Error).message }) })
              const git = spawnSync("git", ["init", "-q"], { cwd: created.dir, stdio: "ignore", windowsHide: true }).status === 0
              const moving = input.move !== false
              if (moving) yield* move(context.sessionID, created.dir)
              return {
                content: [
                  `Created ${created.dir} (${created.template}: ${created.files.join(", ")}${git ? ", git repository" : ""}).`,
                  moving ? "This session moves there at the next safe boundary; from the next step on, relative paths and commands run in the new project." : `Not moved; open it with action "open" and name "${created.name}".`,
                ].join(" "),
              }
            }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: `project ${input.action}: ${error instanceof Error ? error.message : String(error)}`, error })))),
        })
      })
      .pipe(Effect.orDie)
  }),
})
