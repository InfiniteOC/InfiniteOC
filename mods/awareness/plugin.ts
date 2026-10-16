// InfiniteOC awareness tools: detected project checks, an on-demand
// cheat-sheet for every custom tool's exact input shape, and an InfiniteOC
// manager, plus on-demand loading of specialist tools (load_tools). Written to
// packages/core/src/plugin/infiniteoc-awareness.ts by mods/awareness next to
// infiniteoc-awareness-lib.ts (the pure helpers; see lib.ts). All tools are
// read-only: project_checks reads manifest file names and scripts only (never
// .env or secrets), tool_guide returns static text, infiniteoc answers from
// files or returns terminal commands for the user to run, and load_tools only
// changes which tool definitions this session's requests carry.
// Nothing here executes state-changing operations, writes files, or changes
// permissions.
import { define } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import * as L from "./infiniteoc-awareness-lib.js"

const failure = (error: unknown) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) })

/** "leanTools": false in the InfiniteOC settings sends every tool on every request again. */
const leanTools = () => {
  try {
    const file = process.env.INFINITEOC_SETTINGS_FILE || path.join(homedir(), ".config/infiniteoc/settings.json")
    return JSON.parse(readFileSync(file, "utf8")).leanTools !== false
  } catch {
    return true
  }
}

export const Plugin = define({
  id: "infiniteoc.awareness",
  effect: Effect.fn(function* (ctx) {
    const directory = String(ctx.location.directory)
    // Specialist tools each session loaded, and the set its last request was sent with (see the hooks below).
    const loaded = new Map<string, Set<string>>()
    const sent = new Map<string, Set<string>>()

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
        editor.add({
          name: "infiniteoc",
          options: { codemode: false },
          description:
            "Manage InfiniteOC and use its advantages: status/mods/doctor/check answer from files; new/enable/disable/rebuild/team return the exact terminal command with preconditions for the user to run; update/bench/remote/mod/wizard are user-only and stop there. This tool never executes state-changing operations itself.",
          input: Schema.Struct({
            op: Schema.optionalKey(Schema.String).annotate({ description: "Op: status, mods, doctor, check, new, enable, disable, rebuild, update, bench, remote, mod, wizard, team, devflow, advantages, help. Default: status." }),
            target: Schema.optionalKey(Schema.String).annotate({ description: "Mod ID for check/new/enable/disable." }),
          }),
          execute: (input) =>
            Effect.try({
              try: () => {
                const { op, target } = input as { op?: string; target?: string }
                const home = process.env.INFINITEOC_HOME
                const checkout = home && existsSync(path.join(home, "infiniteoc.json"))
                  ? home
                  : L.findCheckout(directory, (dir) => existsSync(path.join(dir, "infiniteoc.json")))
                if (!checkout) return { content: `No InfiniteOC checkout found from ${directory} (and INFINITEOC_HOME ${home ? "does not point at one" : "is unset"}). Run inside the checkout, or set INFINITEOC_HOME to its path. Nothing was changed.` }
                let text: string | undefined
                try {
                  const raw = readFileSync(path.join(checkout, "infiniteoc.json"), "utf8")
                  text = raw.length > 50_000 ? raw.slice(0, 50_000) : raw
                } catch {}
                let branch: string | undefined
                try {
                  const head = readFileSync(path.join(checkout, ".git", "HEAD"), "utf8").trim()
                  const match = /^ref: refs\/heads\/(.+)$/.exec(head)
                  branch = match ? match[1] : head.slice(0, 40) || undefined
                } catch {}
                return { content: L.infiniteoc(op, target, L.readCheckout(checkout, text, branch)) }
              },
              catch: failure,
            }),
        })
        editor.add({
          name: L.LOAD_TOOL,
          options: { codemode: false },
          // Rewritten per request to list only what is left to load (see the hooks below).
          description: L.loadToolDescription(Object.keys(L.DEFERRED)),
          input: Schema.Struct({
            names: Schema.Array(Schema.String).annotate({ description: "Tool names from the list, e.g. [\"agent_display\"]" }),
          }),
          execute: (input, context) =>
            Effect.sync(() => {
              const names = (input as { names: ReadonlyArray<string> }).names
              const known = names.filter((name) => name in L.DEFERRED)
              const unknown = names.filter((name) => !(name in L.DEFERRED))
              const session = loaded.get(context.sessionID) ?? new Set<string>()
              for (const name of known) session.add(name)
              loaded.set(context.sessionID, session)
              return {
                content: [
                  known.length ? `Loaded ${known.join(", ")}: callable from your next step on. Call them directly now.` : "",
                  ...known.flatMap((name) => (L.TOOL_GUIDE[name] ? [L.TOOL_GUIDE[name]] : [])),
                  unknown.length ? `Not loadable: ${unknown.join(", ")}. Choose from the list in this tool's description.` : "",
                ].filter(Boolean).join("\n"),
              }
            }),
        })
      })
      .pipe(Effect.orDie)

    // Specialist tools on demand. A tool counts as loaded once this session loaded (or used) it; the set
    // also lives in memory, so a compaction that hides the load_tools call keeps it loaded. Compaction
    // and side generations get the session's last tool list so their prompt prefix (and cache) matches.
    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        if (!leanTools()) return
        const session = loaded.get(event.sessionID) ?? new Set<string>()
        for (const name of L.loadedTools(event.messages as any)) session.add(name)
        loaded.set(event.sessionID, session)
        sent.set(event.sessionID, new Set(session))
        L.deferTools(event.tools, session)
      }),
    )
    const replay = (event: { sessionID: string; tools: Record<string, { description: string }> }) =>
      Effect.sync(() => {
        if (!leanTools()) return
        L.deferTools(event.tools, sent.get(event.sessionID) ?? loaded.get(event.sessionID) ?? new Set())
      })
    yield* ctx.session.hook("compaction", replay)
    yield* ctx.session.hook("generate", replay)
  }),
})
