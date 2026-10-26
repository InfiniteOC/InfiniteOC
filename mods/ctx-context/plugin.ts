// InfiniteOC ctx: what goes into the model's context. Written to packages/core/src/plugin/infiniteoc-ctx.ts
// by mods/ctx-context. Adds the memory, repo_map, trace_lookup, type_lookup, log_tail, sql_peek,
// openapi_lookup and linked_repo tools, the /pin /unpin /glossary commands, @url mentions, and a
// project memory, glossary, pins, dependency versions and machine profile as a session instruction
// source (infiniteoc-ctx-instruction.ts, cache-stable), and request slimming: smaller tool images and
// only the recent screenshots resent. Persistence and lookups live in infiniteoc-ctx-store.ts and
// infiniteoc-ctx-knowledge.ts (pure, tested).
import { Message, ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { TuiEvent } from "@opencode/schema/tui-event"
import { Effect, Schema } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { Bus } from "../bus.js"
import { FileAccess } from "../file-access.js"
import { Image } from "../image.js"
import { convertHTMLToMarkdown } from "../tool/html-markdown.js"
import * as K from "./infiniteoc-ctx-knowledge.js"
import { lastRendered } from "./infiniteoc-ctx-instruction.js"
import * as Store from "./infiniteoc-ctx-store.js"

// Agents whose requests never need project knowledge.
const SKIP = new Set(["title", "compaction", "summary"])
const MAX_URL_BYTES = 200 * 1024

export async function fetchMention(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: "text/markdown, text/plain, text/html;q=0.8, application/json;q=0.7", "User-Agent": "InfiniteOC/1.0 (+@url mention)" } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const type = response.headers.get("content-type") ?? ""
  if (!/^(text\/|application\/(json|xml|xhtml|yaml|x-yaml|javascript))/.test(type)) throw new Error(`unsupported content type ${type || "unknown"}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  let text = new TextDecoder().decode(bytes.slice(0, MAX_URL_BYTES))
  if (type.startsWith("text/html")) text = convertHTMLToMarkdown(text)
  return `Content of ${url}${bytes.byteLength > MAX_URL_BYTES ? ` (first ${MAX_URL_BYTES / 1024} KB)` : ""}:\n\n${text}`
}

const dataUri = (text: string) => `data:text/plain;base64,${Buffer.from(text).toString("base64")}`

const field = (description: string) => Schema.optionalKey(Schema.String).annotate({ description })
const count = (description: string) => Schema.optionalKey(Schema.Finite).annotate({ description })

export const Plugin = define({
  id: "infiniteoc.ctx",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const access = yield* FileAccess.Service
    // Every step resends every image still in the history. Upstream lets each one reach 5 MB of base64;
    // screenshots (agent_display, ui_check, read of a .png) are re-encoded as JPEG above this instead,
    // at the same size so screen coordinates stay valid. media.image in opencode.json still overrides it.
    yield* (yield* Image.Service).transform((editor) => editor.configure({ maxBase64Bytes: Store.TOOL_IMAGE_BYTES }))
    const root = Store.projectRoot(ctx.location.directory)
    const toast = (title: string, message: string, variant: "info" | "success" | "warning" | "error" = "info", duration = 6000) =>
      bus.publish(TuiEvent.ToastShow, { title, message, variant, duration }).pipe(Effect.asVoid)
    const fail = (error: unknown) => new ToolFailure({ message: error instanceof Error ? error.message : String(error), error })

    type Invocation = Parameters<typeof access.authorizeRead>[1]
    /** Runs a lookup after the normal read permission check on every path it touches. */
    const lookup = (context: Invocation, files: string[], work: () => string | Promise<string>) =>
      Effect.gen(function* () {
        for (const file of files) yield* access.authorizeRead(file, context).pipe(Effect.mapError((error) => new ToolFailure({ message: `Not permitted to read ${file}`, error })))
        const content = yield* Effect.tryPromise({ try: async () => work(), catch: fail })
        return { content }
      })

    const cfg = () => Store.readConfig(root)
    const configured = (name: "sqlite" | "openapi", what: string) => {
      const file = cfg()[name]
      if (!file) throw new Error(`No ${what} configured. Add {"${name}": "<path>"} to ${path.join(root, ".infiniteoc", "context.json")}.`)
      return Store.resolveIn(root, file)
    }

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: "memory",
          options: { codemode: false },
          description:
            "Project memory shared by all future sessions in this project. Save durable facts you learned that are hard to rediscover: build/test/lint commands, gotchas, environment quirks, conventions the user stated, preferences. One short line per fact. Do not save secrets, task progress, or anything the code already shows. Saved entries are shown to every future session; list and remove stale ones.",
          input: Schema.Struct({
            action: Schema.Literals(["add", "list", "remove"]).annotate({ description: "add a fact, list all facts, or remove one by number or unique text" }),
            text: field("The fact to add (add), or the entry number or a unique part of its text (remove)"),
          }),
          execute: (input) =>
            Effect.try({
              try: () => {
                const file = Store.memoryFile(root)
                if (input.action === "list") return Store.listItems(file).map((item, i) => `${i + 1}. ${item}`).join("\n") || "Project memory is empty."
                if (!input.text) throw new Error("text is required")
                if (input.action === "remove") return `Removed: ${Store.removeItem(file, input.text)}`
                const { items, replaced } = Store.addItem(file, input.text)
                return `${replaced ? "Updated" : "Saved"} (${items.length} entries). It will be in context for future sessions.`
              },
              catch: fail,
            }).pipe(Effect.map((content) => ({ content }))),
        })
        editor.add({
          name: "repo_map",
          options: { codemode: false },
          description:
            "Cached outline of the project's code files and their top-level symbols (functions, classes, types), one line per file. Use it to orient in an unfamiliar repository before grepping. Narrow with path (a directory prefix) or query (matches file names and symbols).",
          input: Schema.Struct({ path: field("Directory prefix, e.g. src/server"), query: field("Case-insensitive text matched against file paths and symbol names") }),
          execute: (input, context) => lookup(context, [root], () => K.repoMap(root, path.join(Store.projectDir(root), "repomap.json"), input)),
        })
        editor.add({
          name: "trace_lookup",
          options: { codemode: false },
          description:
            "Map a pasted stack trace or compiler error to files in this project. Pass the trace text; it returns each frame's local file:line with surrounding source, resolving paths from CI, containers or other machines by suffix, and marking dependency frames. Use it when the user pastes an error.",
          input: Schema.Struct({ trace: Schema.String.annotate({ description: "The stack trace or error text, verbatim" }), context: count("Source lines around each frame (default 2)") }),
          execute: (input, context) => lookup(context, [root], () => K.lookupTrace(root, input.trace, Math.min(Math.max(input.context ?? 2, 0), 10))),
        })
        editor.add({
          name: "type_lookup",
          options: { codemode: false },
          description:
            "Look up the definition of a type, interface, class or function by name in node_modules/@types, the project's installed dependencies' .d.ts files, and any docs folders configured in .infiniteoc/context.json. Gives the declaration as installed, which beats recalling an API from memory.",
          input: Schema.Struct({ name: Schema.String.annotate({ description: "Identifier, e.g. Request or useState (a dotted name uses its last part)" }), package: field("Limit to this package, e.g. express or @types/node") }),
          execute: (input, context) =>
            lookup(context, [root, ...(cfg().docs ?? []).map((dir) => Store.resolveIn(root, dir))], () =>
              K.lookupTypes(root, { name: input.name, pkg: input.package, docs: (cfg().docs ?? []).map((dir) => Store.resolveIn(root, dir)) }),
            ),
        })
        editor.add({
          name: "log_tail",
          options: { codemode: false },
          description:
            "Read the recent output of a log file. name is a key from \"logs\" in .infiniteoc/context.json (a dev server or process that writes its output to a file), or a path. Returns the last lines, optionally only those containing a text. Omit name to list the configured logs.",
          input: Schema.Struct({ name: field("Configured log name or a file path"), lines: count("How many lines (default 100, max 500)"), match: field("Only lines containing this text, case-insensitive") }),
          execute: (input, context) => {
            const logs = cfg().logs ?? {}
            if (!input.name) return Effect.succeed({ content: Object.entries(logs).map(([name, file]) => `${name}: ${file}`).join("\n") || 'No logs configured. Add {"logs": {"dev": "logs/dev.log"}} to .infiniteoc/context.json, or pass a file path.' })
            const file = Store.resolveIn(root, logs[input.name] ?? input.name)
            return lookup(context, [file], () => K.tailFile(file, { lines: input.lines, match: input.match }))
          },
        })
        editor.add({
          name: "sql_peek",
          options: { codemode: false },
          description:
            "Read-only SQL against the project's configured SQLite database (\"sqlite\" in .infiniteoc/context.json). Only SELECT, WITH, EXPLAIN and introspection PRAGMAs run; the file is opened read-only and any write is refused. Pass sql \"schema\" (or nothing) to list tables and their DDL. Results are limited to 50 rows by default.",
          input: Schema.Struct({ sql: field('One read-only statement, or "schema"'), limit: count("Max rows (default 50, max 200)") }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* Effect.try({ try: () => configured("sqlite", "SQLite database"), catch: fail })
              return yield* lookup(context, [file], () => K.queryReadOnly(file, input.sql ?? "schema", input.limit))
            }),
        })
        editor.add({
          name: "openapi_lookup",
          options: { codemode: false },
          description:
            'Look up endpoints in the project\'s configured OpenAPI spec ("openapi" in .infiniteoc/context.json). With query it lists matching "METHOD /path - summary" lines; with operation ("GET /users/{id}") it returns that endpoint\'s parameters, request body and responses with $refs resolved.',
          input: Schema.Struct({ query: field("Text matched against method, path, summary and operationId"), operation: field('Exact operation, e.g. "POST /orders"') }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* Effect.try({ try: () => configured("openapi", "OpenAPI spec"), catch: fail })
              return yield* lookup(context, [file], () => K.lookupOpenApi(K.loadSpec(file), input))
            }),
        })
        editor.add({
          name: "linked_repo",
          options: { codemode: false },
          description:
            "Read-only access to a linked sibling repository (\"repos\" in .infiniteoc/context.json, listed in the context). Lists a directory, reads a file range, or greps for a literal. It cannot modify the repository; make changes there by asking the user to open it.",
          input: Schema.Struct({
            repo: Schema.String.annotate({ description: "Linked repository name (its folder name)" }),
            path: field("File or directory inside the repository (default: its root)"),
            grep: field("Literal text to search for (case-insensitive) under path"),
            offset: count("First line to read for a file"),
            limit: count("Lines to read for a file (default 400)"),
          }),
          execute: (input, context) => {
            const repos = (cfg().repos ?? []).map((repo) => Store.resolveIn(root, repo))
            const repo = repos.find((item) => path.basename(item) === input.repo)
            if (!repo) return Effect.fail(fail(`Unknown repository "${input.repo}". Linked: ${repos.map((item) => path.basename(item)).join(", ") || "none"}.`))
            return lookup(context, [path.resolve(repo, input.path ?? ".")], () => K.inspectRepo(repo, input))
          },
        })
      })
      .pipe(Effect.orDie)

    yield* ctx.command.transform((editor) => {
      const target = (input: { prompt: { text: string; files?: ReadonlyArray<{ uri: string }> } }) => {
        const attached = input.prompt.files?.find((file) => file.uri.startsWith("file://"))
        const raw = attached ? fileURLToPath(attached.uri) : input.prompt.text.trim().replace(/^@/, "").replace(/^["']|["']$/g, "")
        return path.resolve(ctx.location.directory, raw)
      }
      editor.add({
        name: "pin",
        description: "keep a file's current content in every turn of this session · /pin <file>",
        execute: (input) =>
          Effect.suspend(() => {
            if (!input.prompt.text.trim() && !input.prompt.files?.length) {
              const pins = Store.listPins(input.sessionID)
              return toast("Pins", pins.length ? pins.map((pin) => path.relative(root, pin)).join("\n") : "Nothing pinned. Usage: /pin <file>")
            }
            try {
              const { pins, tokens } = Store.addPin(input.sessionID, target(input))
              return toast("Pinned", `${path.relative(root, target(input))} (about ${tokens} tokens in context, ${pins.length} pinned). /unpin removes it.`, "success")
            } catch (error) {
              return toast("Pin failed", error instanceof Error ? error.message.replace(/^ENOENT.*open '(.*)'$/, "No such file: $1") : String(error), "error")
            }
          }),
      })
      editor.add({
        name: "unpin",
        description: "stop pinning a file · /unpin <file|all>",
        execute: (input) =>
          Effect.suspend(() => {
            const wanted = input.prompt.text.trim().replace(/^@/, "")
            if (!wanted) return toast("Unpin", "Usage: /unpin <file> or /unpin all", "warning")
            try {
              const gone = Store.removePin(input.sessionID, wanted === "all" ? "all" : path.resolve(ctx.location.directory, wanted))
              return toast("Unpinned", gone.map((pin) => path.relative(root, pin)).join("\n"), "success")
            } catch {
              try {
                return toast("Unpinned", Store.removePin(input.sessionID, wanted).map((pin) => path.relative(root, pin)).join("\n"), "success")
              } catch (error) {
                return toast("Unpin failed", error instanceof Error ? error.message : String(error), "error")
              }
            }
          }),
      })
      editor.add({
        name: "glossary",
        description: "project terms loaded every session · /glossary add <term> <meaning> | remove <term> | list",
        execute: (input) =>
          Effect.suspend(() => {
            const [verb, ...rest] = input.prompt.text.trim().split(/\s+/)
            const file = Store.glossaryFile(root)
            try {
              if (!verb || verb === "list") return toast("Glossary", Store.listItems(file).join("\n") || "Empty. Usage: /glossary add <term> <meaning>", "info", 15000)
              if (verb === "remove") return toast("Glossary", `Removed: ${Store.removeItem(file, rest.join(" "))}`, "success")
              if (verb === "add" && rest.length >= 2) {
                // A quoted multi-word term is allowed: /glossary add "build target" what ... means
                const quoted = /^add\s+"([^"]+)"\s+(.+)$/s.exec(input.prompt.text.trim())
                const [term, meaning] = quoted ? [quoted[1], quoted[2]] : [rest[0], rest.slice(1).join(" ")]
                const { replaced } = Store.addTerm(root, term, meaning)
                return toast("Glossary", `${replaced ? "Updated" : "Added"} ${term}`, "success")
              }
            } catch (error) {
              return toast("Glossary", error instanceof Error ? error.message : String(error), "error")
            }
            return toast("Glossary", "Usage: /glossary add <term> <meaning> | remove <term> | list", "warning")
          }),
      })
    })

    // @https://... in a prompt attaches the page, like @file. The user typed the URL, so fetching it is opt-in.
    yield* ctx.session.hook("prompt", (event) => {
      const urls = K.urlMentions(event.prompt.text)
      if (!urls.length) return Effect.void
      return Effect.forEach(
        urls,
        (url) =>
          Effect.tryPromise({ try: () => fetchMention(url), catch: (error) => error }).pipe(
            Effect.catch((error) => Effect.succeed(`Could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}`)),
            Effect.map((text) => ({ uri: dataUri(text), name: url })),
          ),
        { concurrency: 3 },
      ).pipe(
        Effect.tap((files) =>
          Effect.sync(() => {
            event.prompt.files = [...(event.prompt.files ?? []), ...files]
          }),
        ),
        Effect.asVoid,
      )
    })

    yield* ctx.session.hook("context", (event) => {
      if (SKIP.has(event.agent)) return Effect.void
      try {
        Store.trimToolImages(event.messages, (message, content) => Message.make({ ...message, content }))
        const ours = lastRendered.get(event.sessionID)
        const report = Store.breakdown(event as unknown as Store.RequestShape, ours ? [ours] : [])
        Store.writeSnapshot(event.sessionID, { at: Date.now(), agent: event.agent, ...report })
      } catch (cause) {
        return Effect.logWarning("InfiniteOC ctx request shaping failed", { cause })
      }
      return Effect.void
    })
  }),
})
