import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { replaceExact } from "./tui-features.mjs"

export async function installExportTool(root) {
  const file = path.join(root, "packages/core/src/tool/plugin/opencode.ts")
  let source = await readFile(file, "utf8")
  source = replaceExact(source, 'import { Effect, Schema } from "effect"', 'import { Effect, Schema } from "effect"\nimport { FileAccess } from "../../file-access.js"\nimport { Permission } from "../../permission.js"\nimport { exportProject } from "./infiniteoc-export.mjs"', "export tool imports")
  // Services are bound once at plugin setup, as upstream's file tools do, so execute requires nothing.
  source = replaceExact(source, '    yield* ctx.session.hook("generate", hook)\n    yield* ctx.tool\n', '    yield* ctx.session.hook("generate", hook)\n    const access = yield* FileAccess.Service\n    const permission = yield* Permission.Service\n    yield* ctx.tool\n', "export tool services")
  source = replaceExact(source, '        draft.add({\n          name: "session_rename",', `        draft.add({
          name: "project_export",
          description: "Export the project (or one of its subdirectories) as a downloadable archive. Resolves paths against the session directory, asks for approval like any other tool, then returns a one-click download link that works once, on this machine, for the next 10 minutes. Use when the user wants a copy of their project.",
          input: Schema.Struct({
            path: Schema.optionalKey(Schema.String).annotate({ description: "Subdirectory to export, relative to the session directory. Omit for the whole project." }),
            format: Schema.optionalKey(Schema.Literals(["zip", "tar.gz"])).annotate({ description: "Archive format. Omit for zip (tar.gz when zip is unavailable). .git and node_modules are always excluded." }),
          }),
          output: Schema.Struct({ url: Schema.String, filename: Schema.String, bytes: Schema.String, sha256: Schema.String, format: Schema.String, expiresInMs: Schema.Number }),
          options: { namespace: "opencode", codemode: true },
          execute: (input, context) =>
            Effect.gen(function* () {
              const target = yield* access.resolve({ path: input.path ?? ".", kind: "directory" })
              yield* access.authorizeExternal([target], context)
              const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
              yield* permission.assert({ action: "project_export", resources: [target.resource], save: [], metadata: { path: input.path ?? ".", format: input.format ?? "zip" }, sessionID: context.sessionID, agent: context.agent, source })
              const result = yield* Effect.tryPromise({
                try: () => exportProject({ directory: target.absolute, format: input.format ?? "zip" }),
                catch: (error) => new ToolFailure({ message: "project export: " + (error as Error).message + ". The agent continues." }),
              })
              return {
                output: { ...result, bytes: String(result.bytes) },
                content: "Download " + result.filename + " (" + (result.bytes / 1048576).toFixed(1) + " MB, sha256 " + result.sha256.slice(0, 12) + "): " + result.url + " . The link works once, on this machine, for the next " + Math.round(result.expiresInMs / 60000) + " minutes.",
              }
            }).pipe(
              // A denied approval, a path outside the project or a filesystem error must reach the agent as a tool failure.
              Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: "project export: " + (error instanceof Error ? error.message : String(error)), error }))),
            ),
        })
        draft.add({
          name: "session_rename",`, "export tool registration")
  await writeFile(file, source)
  await writeFile(path.join(root, "packages/core/src/tool/plugin/infiniteoc-export.mjs"), await readFile(new URL("./project-export.mjs", import.meta.url), "utf8"))
}
