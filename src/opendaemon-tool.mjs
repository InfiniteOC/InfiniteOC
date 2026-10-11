import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { replaceExact } from "./tui-features.mjs"

export async function installDaemonTool(root) {
  const file = path.join(root, "packages/core/src/tool/plugin/opencode.ts")
  let source = await readFile(file, "utf8")
  source = replaceExact(source, 'import { Effect, Schema } from "effect"', 'import { Effect, Schema } from "effect"\nimport { daemonRequest } from "./opendaemon-client.mjs"', "daemon tool import")
  source = replaceExact(source, '        draft.add({\n          name: "session_rename",', `        draft.add({
          name: "opendaemon",
          description: "Control InfiniteOC live UI without stopping the agent. status reports progress and client IDs; reload compiles local TUI commands; notify sends UI text; close-all-tabs preserves sessions; auto controls watching. script runs trusted JS/TS source exporting run(ctx) once in the chosen client; temporary registers source with slash/title until that UI restarts; temporary-clear removes overlays; client defaults to the agent's own UI. Scripts are NOT sandboxed and side effects are not automatically undone. Compiled backend changes require restart.",
          input: Schema.Struct({
            action: Schema.Literals(["status", "reload", "notify", "close-all-tabs", "auto", "script", "temporary", "temporary-clear"]),
            text: Schema.optionalKey(Schema.String),
            enabled: Schema.optionalKey(Schema.Boolean),
            client: Schema.optionalKey(Schema.String),
            source: Schema.optionalKey(Schema.String),
            slash: Schema.optionalKey(Schema.String),
            title: Schema.optionalKey(Schema.String),
          }),
          output: Schema.Struct({ result: Schema.String }),
          options: { namespace: "opencode", codemode: true },
          execute: (input) => Effect.tryPromise({
            try: async () => {
              const socket = process.env.INFINITEOC_DAEMON_SOCKET
              // || so an empty string from the model still means the agent's own UI.
              const client = input.client || process.env.INFINITEOC_UI_CLIENT
              const result = input.action === "status"
                ? await daemonRequest(socket, "GET", "/status")
                : input.action === "reload"
                  ? await daemonRequest(socket, "POST", "/reload", {})
                  : ["script", "temporary", "temporary-clear"].includes(input.action)
                    ? await daemonRequest(socket, "POST", "/temporary", { client, clear: input.action === "temporary-clear", run: input.action === "script", command: { id: input.slash || "test-script", slash: input.slash || "test-script", title: input.title || "Temporary test script", source: input.source } }, 30000)
                  : input.action === "auto"
                    ? await daemonRequest(socket, "POST", "/auto", { enabled: input.enabled })
                    : await daemonRequest(socket, "POST", "/message", { action: input.action, text: input.text, client })
              return { output: { result: JSON.stringify(result) }, content: JSON.stringify(result) }
            },
            // Daemon/client error strings are static; compiler output never reaches them.
            catch: (error) => new ToolFailure({ message: "opendaemon: " + (error as Error).message + ". The agent continues." }),
          }),
        })
        draft.add({
          name: "session_rename",`, "daemon tool registration")
  await writeFile(file, source)
  await writeFile(path.join(root, "packages/core/src/tool/plugin/opendaemon-client.mjs"), await readFile(new URL("./daemon-client.mjs", import.meta.url), "utf8"))
}