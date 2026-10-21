// InfiniteOC quality tools: verification of code and frontend work (render, accessibility, tests, coverage,
// dependencies, licenses). Written to packages/core/src/plugin/infiniteoc-quality.ts by mods/qual-checks; the
// logic lives in ../infiniteoc/quality/*.ts and is unit tested on its own.
import { define } from "@opencode/plugin/effect/plugin"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { TuiEvent } from "@opencode/schema/tui-event"
import { Effect, Schema, Stream } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Bus } from "../bus.js"
import { FileAccess } from "../file-access.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { formatReport, findAxe, findChrome, runCheck, serveLocal, toUrl, viewportSpecs, type Scheme } from "../infiniteoc/quality/browser.js"
import { catalog, formatCatalog } from "../infiniteoc/quality/catalog.js"
import { detectCommand, fmtDelta, parseCoverage, readReport, type Totals } from "../infiniteoc/quality/coverage.js"
import { addedDeps, describeAdded } from "../infiniteoc/quality/deps.js"
import { run, tail } from "../infiniteoc/quality/exec.js"
import { formatLicense, scanLicense } from "../infiniteoc/quality/license.js"
import { formatPrune, prune } from "../infiniteoc/quality/prune.js"
import { load } from "../infiniteoc/quality/scan.js"
import { checkable, syntaxProblem } from "../infiniteoc/quality/syntax.js"
import { networkAllowed, projectDir, readBaseline, readConfig, readJson, writeBaseline } from "../infiniteoc/quality/store.js"
import { compareBench, eventsFromMessages, flakyVerdict, isSourceFile, isTestCommand, MARK, mutate, reminderCount, targets, testFirstEnd, testFirstPhase, testFirstRefusal } from "../infiniteoc/quality/tests.js"
import { extractTokens, formatTokens } from "../infiniteoc/quality/tokens.js"
import { createHash } from "node:crypto"

const UI_FILE = /\.(html?|css|scss|sass|less|styl|jsx|tsx|vue|svelte|astro|mdx|hbs|ejs|njk|liquid|twig|erb)$/i
const MANIFEST = /(^|\/)(package\.json|requirements[^/]*\.txt)$/
const INSTALL = /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\buv\s+(add|pip install)\b|\bpoetry\s+add\b/
const VENDOR = /(^|\/)(vendor|vendored|third_party|third-party|thirdparty|extern|external)\/([^/\s'"]+)/i
const FLAKY_MAX_MS = Number(process.env.INFINITEOC_QUALITY_FLAKY_MAX_SECONDS ?? 60) * 1000

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })
const image = (name: string, png: string) => ({ type: "file" as const, uri: `data:image/png;base64,${png}`, mime: "image/png", name })
const asArray = (content: unknown): Tool.Content[] => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? [...content] : [])
const fail = (error: unknown) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) })
const toolError = (error: unknown) => (error instanceof Tool.Error ? error : fail(error))
const attempt = <A>(fn: () => Promise<A> | A) => Effect.tryPromise({ try: async () => fn(), catch: fail })

/** The project-relative directory argument, kept inside the project. */
function inside(root: string, input: string | undefined) {
  const full = path.resolve(root, input ?? ".")
  const base = path.resolve(root)
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`${input} is outside the project (${base}).`)
  return full
}

const Viewports = Schema.Array(Schema.Union([Schema.String, Schema.Number]))

export const Plugin = define({
  id: "infiniteoc.quality",
  effect: Effect.fn(function* (ctx: Context) {
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service
    const access = yield* FileAccess.Service
    const cwd = () => location.directory
    const toast = (title: string, message: string, variant: "info" | "success" | "warning" = "info") =>
      bus.publish(TuiEvent.ToastShow, { title, message, variant, duration: 8000 }).pipe(Effect.asVoid)
    const askShell = (command: string, context: Tool.Context) =>
      permission.assert({ action: "shell", resources: [command], save: [command], sessionID: context.sessionID, agent: context.agent, source: { type: "tool", messageID: context.messageID, id: context.id } })

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: "ui_check",
          options: { codemode: false },
          description:
            "Render a page in headless Chrome and look at it. Returns screenshots at phone (375), tablet (768) and desktop (1280) widths in light mode plus desktop in dark mode, a horizontal-overflow check, console errors, an axe-core accessibility audit (when axe-core is installed in the project), and a pixel diff against the previous capture of the same page. Use it after every UI change. Capture once BEFORE editing so the after-capture shows a diff. Optionally pass a mockup image to see how far the render is from it. Target: a dev server URL (http://localhost:...) or an HTML file path; a file is served from its folder over a temporary local http server, so ES modules, fetch and localStorage work without starting one yourself. Lists and tables: also check them filled, with storage (localStorage the app loads) or setup (a script that adds items).",
          input: Schema.Struct({
            target: Schema.String.annotate({ description: "http://localhost URL of a running dev server, or the path of an HTML file" }),
            viewports: Schema.optionalKey(Viewports).annotate({ description: 'Subset of "phone", "tablet", "desktop" or pixel widths. Default: all three.' }),
            schemes: Schema.optionalKey(Schema.Array(Schema.Literals(["light", "dark"]))).annotate({ description: "Color schemes to render for every viewport. Default: light for each viewport plus dark at the widest." }),
            full_page: Schema.optionalKey(Schema.Boolean).annotate({ description: "Capture the whole page (capped at 2000px tall) instead of the first screen. Default true." }),
            a11y: Schema.optionalKey(Schema.Boolean).annotate({ description: "Run the axe-core audit when available. Default true." }),
            save_baseline: Schema.optionalKey(Schema.Boolean).annotate({ description: "Store these captures as the new baseline for later diffs (a baseline is also created when none is fresh)." }),
            mockup: Schema.optionalKey(Schema.String).annotate({ description: "Path of a mockup image (png, jpg, webp); the page is rendered at its width and compared pixel by pixel." }),
            storage: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({ description: "localStorage entries (key to string value) set before the page's scripts run, to render a filled state." }),
            setup: Schema.optionalKey(Schema.String).annotate({ description: "JavaScript run in the page after it loads and before it is measured (may await), e.g. to fill and submit the form a few times." }),
          }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const dir = cwd()
              const chrome = findChrome()
              if (!chrome) return text("ui_check cannot render here: no Chrome, Chromium or Edge was found (set INFINITEOC_CHROME to a browser binary). Nothing was installed. Tell the user the UI was not rendered and list what they should check by hand.")
              // A relative path means the session directory, not the server process's working directory.
              const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(input.target) || path.isAbsolute(input.target) ? input.target : path.join(dir, input.target)
              const url = toUrl(target, networkAllowed(dir))
              const viewports = viewportSpecs(input.viewports)
              const wide = viewports.reduce((a, b) => (b.width > a.width ? b : a))
              const plan = input.schemes?.length
                ? viewports.flatMap((viewport) => input.schemes!.map((scheme) => ({ viewport, scheme: scheme as Scheme })))
                : [...viewports.map((viewport) => ({ viewport, scheme: "light" as Scheme })), { viewport: wide, scheme: "dark" as Scheme }]
              const mockup = input.mockup
                ? yield* access.authorizeRead(input.mockup, context).pipe(Effect.flatMap((target) => attempt(() => ({ file: target.absolute, base64: readFileSync(target.absolute).toString("base64") }))))
                : undefined
              // A filled state gets its own baselines instead of diffing against the empty page.
              const state = input.storage || input.setup ? JSON.stringify([input.storage ?? null, input.setup ?? null]) : ""
              const key = createHash("sha1").update(url + state).digest("hex").slice(0, 10)
              const file = (label: string) => path.join(projectDir(dir), "shots", `${key}-${label}.png`)
              const axePath = input.a11y === false ? undefined : findAxe(dir)
              // Baselines stay keyed to the file URL; the page itself is rendered from a local http origin.
              const local = url.startsWith("file:") ? yield* attempt(() => serveLocal(fileURLToPath(url))) : undefined
              const result = yield* attempt(() =>
                runCheck({ chrome, url: local?.url ?? url, plan, fullPage: input.full_page !== false, axeSource: axePath, basicAudit: input.a11y !== false && !axePath, mockup, storage: input.storage, setup: input.setup, baseline: (label) => readBaseline(file(label))?.toString("base64") }),
              ).pipe(Effect.ensuring(local ? Effect.promise(() => local.close()) : Effect.void))
              const saved: string[] = []
              for (const shot of result.shots)
                if (input.save_baseline || !shot.baseline) {
                  writeBaseline(file(shot.label), Buffer.from(shot.png, "base64"))
                  saved.push(shot.label)
                }
              const formatted = formatReport(result, input.a11y === false ? "off" : axePath ? "ran" : "basic", input.target)
              // Console errors name the temporary origin; show the files they mean instead.
              const mapped = local ? formatted.split(`${local.origin}/`).join(`${local.root}${path.sep}`) : formatted
              const report = local?.missing.length ? `${mapped}\nMissing files: the page requests ${local.missing.join(", ")}, which do not exist. Create them or fix the links.` : mapped
              const parts: Tool.Content[] = [{ type: "text", text: report + (saved.length ? `\nSaved as the baseline for later diffs: ${saved.join(", ")}.` : "") }]
              for (const shot of result.shots) {
                parts.push(image(`${shot.label}.png`, shot.png))
                if (shot.diff && shot.diff.changedPct > 0.01) parts.push(image(`diff-${shot.label}.png`, shot.diff.png))
              }
              if (result.mockup) parts.push(image(`${result.mockup.shot.label}.png`, result.mockup.shot.png), image("diff-mockup.png", result.mockup.diff.png))
              return { content: parts }
            }).pipe(Effect.mapError(toolError)),
        })

        const scanTool = (name: string, description: string, pattern: RegExp, format: (files: ReturnType<typeof load>) => string) =>
          editor.add({
            name,
            options: { codemode: false },
            description,
            input: Schema.Struct({ path: Schema.optionalKey(Schema.String).annotate({ description: "Directory inside the project to scan. Default: the project root." }) }),
            execute: (input) => attempt(() => text(format(load(inside(cwd(), input.path), pattern)))),
          })
        scanTool(
          "design_tokens",
          "List the project's design tokens: CSS custom properties grouped as color, type, space, radius, shadow and motion (with dark/theme alternates), and the Tailwind config theme. Read this before writing new UI so it uses the existing palette, type scale and spacing instead of invented values.",
          /\.(css|scss|sass|less|pcss|html?|vue|svelte|astro|tsx|jsx)$|^tailwind\.config\.[mc]?[jt]s$/,
          (files) => formatTokens(extractTokens(files)),
        )
        scanTool(
          "component_catalog",
          "List the project's existing UI components (React, Vue, Svelte, Astro) with file, props and how many files use each. Check it before creating a component so you reuse or extend what exists.",
          /\.(tsx|jsx|vue|svelte|astro)$/,
          (files) => formatCatalog(catalog(files)),
        )
        scanTool(
          "prune_scan",
          "Static scan of a JS/TS project for files that nothing imports and exports that nothing uses. Reports candidates only; never deletes. Use for the /prune command or when cleaning up dead code.",
          /\.(m?[jt]sx?|cjs|json)$/,
          (files) => formatPrune(prune(files)),
        )

        editor.add({
          name: "license_check",
          options: { codemode: false },
          description: "Check the license of code you are vendoring or copying into the project (a directory or file): finds LICENSE/COPYING files, package.json license and SPDX headers, classifies permissive/copyleft/unknown and says what is needed. Run it whenever you add third-party code to the repository.",
          input: Schema.Struct({ path: Schema.String.annotate({ description: "File or directory of the vendored code" }) }),
          execute: (input) =>
            attempt(() => {
              const dir = cwd()
              const target = inside(dir, input.path)
              const own = scanLicense(dir, dir).ids[0]
              return text(formatLicense(input.path, scanLicense(target, dir), own))
            }),
        })

        editor.add({
          name: "coverage_delta",
          options: { codemode: false },
          description: "Run the project's coverage command and report line coverage and the change versus the stored baseline. The first call (or one with save_baseline) stores the baseline. Without a command it uses a coverage script from package.json or node's built-in coverage. Call it after adding tests or changing code to see whether coverage went down.",
          input: Schema.Struct({
            command: Schema.optionalKey(Schema.String).annotate({ description: "Coverage command. Default: detected from package.json." }),
            save_baseline: Schema.optionalKey(Schema.Boolean).annotate({ description: "Store this result as the new baseline." }),
          }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const dir = cwd()
              const pkg = existsSync(path.join(dir, "package.json")) ? readFileSync(path.join(dir, "package.json"), "utf8") : undefined
              const command = input.command ?? detectCommand(pkg)
              if (!command) return text("No coverage tooling detected (no coverage script in package.json, no node --test script). Pass the project's coverage command, or tell the user coverage is not measured here.")
              yield* askShell(command, context)
              const result = yield* attempt(() => run(command, dir, 300_000))
              const totals = parseCoverage(result.output) ?? readReport(dir)
              if (!totals) return text(`Ran \`${command}\` (exit ${result.exit ?? "none"}${result.timedOut ? ", timed out" : ""}) but found no coverage totals in its output or in coverage/. Output tail:\n${tail(result.output)}`)
              const file = path.join(projectDir(dir), "coverage.json")
              const before = readJson<Totals>(file)
              if (input.save_baseline || !before) writeBaseline(file, JSON.stringify(totals))
              const failed = result.exit ? `\nThe command exited with ${result.exit}: some tests failed, so coverage may be incomplete.` : ""
              return text(fmtDelta(before, totals) + failed)
            }).pipe(Effect.mapError(toolError)),
        })

        editor.add({
          name: "mutation_check",
          options: { codemode: false },
          description: "Check that your new tests really test the code: flips one condition in a source file (=== to !==, < to >=, && to ||, true to false), runs the test command and expects a failure, then restores the file. 'killed' means a test caught the change; 'SURVIVED' means no test depends on that line, so add or strengthen a test. Pass line to target code you just changed. The test suite must pass before the mutation.",
          input: Schema.Struct({
            file: Schema.String.annotate({ description: "Source file to mutate (not a test file)" }),
            test_command: Schema.String.annotate({ description: "Command that runs the relevant tests" }),
            line: Schema.optionalKey(Schema.Number).annotate({ description: "1-based line to mutate. Default: the first line with a condition." }),
          }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const dir = cwd()
              const target = yield* access.resolve({ path: input.file, kind: "file" })
              yield* access.authorizeExternal([target], context)
              yield* permission.assert({ action: "edit", resources: [target.resource], save: ["*"], sessionID: context.sessionID, agent: context.agent, source: { type: "tool", messageID: context.messageID, id: context.id } })
              yield* askShell(input.test_command, context)
              const original = yield* attempt(() => readFileSync(target.absolute, "utf8"))
              const mutation = mutate(original, input.line)
              if (!mutation) return text(`No flippable condition found in ${input.file}${input.line ? ` at line ${input.line}` : ""}. Pick a line with a comparison, boolean or logical operator.`)
              const baseline = yield* attempt(() => run(input.test_command, dir))
              if (baseline.exit !== 0) return text(`The tests do not pass before mutating (exit ${baseline.exit ?? "none"}), so a failure would prove nothing. Fix them first. Output tail:\n${tail(baseline.output)}`)
              const backup = path.join(projectDir(dir), "mutation-backup", `${createHash("sha1").update(target.absolute).digest("hex").slice(0, 10)}-${path.basename(target.absolute)}`)
              yield* attempt(() => writeBaseline(backup, original))
              const mutated = yield* attempt(() => {
                writeFileSync(target.absolute, mutation.text)
                return run(input.test_command, dir)
              }).pipe(Effect.ensuring(Effect.sync(() => writeFileSync(target.absolute, original))))
              const where = `${input.file}:${mutation.line}  \`${mutation.before}\`  ->  \`${mutation.after}\``
              return text(
                mutated.exit === 0
                  ? `SURVIVED: the tests still pass with ${where}. No test depends on this condition: add or strengthen a test for it. The file was restored (backup: ${backup}).`
                  : `killed: the tests fail with ${where}${mutated.timedOut ? " (timed out)" : ""}, so this line is covered. The file was restored (backup: ${backup}).\n${tail(mutated.output, 8)}`,
              )
            }).pipe(Effect.mapError(toolError)),
        })

        editor.add({
          name: "bench_guard",
          options: { codemode: false },
          description: "Run the project's benchmark command (best of several runs) and compare wall time with the stored baseline; warns on regression. The command comes from `command`, or `bench.command` in .infiniteoc/quality.json. The first call (or save_baseline) stores the baseline: call it before a performance-sensitive change and again after.",
          input: Schema.Struct({
            command: Schema.optionalKey(Schema.String).annotate({ description: "Benchmark command. Default: bench.command in .infiniteoc/quality.json." }),
            runs: Schema.optionalKey(Schema.Number).annotate({ description: "Runs to take the best of. Default 3." }),
            tolerance_pct: Schema.optionalKey(Schema.Number).annotate({ description: "Slowdown that counts as a regression. Default 15." }),
            save_baseline: Schema.optionalKey(Schema.Boolean).annotate({ description: "Store this result as the new baseline." }),
          }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const dir = cwd()
              const config = readConfig(dir).bench
              const command = input.command ?? config?.command
              if (!command) return text('No benchmark command configured. Pass `command`, or ask the user to add {"bench": {"command": "npm run bench"}} to .infiniteoc/quality.json.')
              yield* askShell(command, context)
              const count = Math.min(Math.max(Math.round(input.runs ?? config?.runs ?? 3), 1), 10)
              let best = Infinity
              for (let i = 0; i < count; i++) {
                const result = yield* attempt(() => run(command, dir, 300_000))
                if (result.exit !== 0) return text(`The benchmark command failed on run ${i + 1} (exit ${result.exit ?? "none"}${result.timedOut ? ", timed out" : ""}):\n${tail(result.output)}`)
                best = Math.min(best, result.ms)
              }
              const file = path.join(projectDir(dir), "bench.json")
              const before = readJson<{ ms: number; command: string }>(file)
              const verdict = compareBench(before?.command === command ? before.ms : undefined, best, input.tolerance_pct ?? config?.tolerancePct ?? 15)
              if (input.save_baseline || !before || before.command !== command) writeBaseline(file, JSON.stringify({ ms: best, command }))
              return text(verdict.message)
            }).pipe(Effect.mapError(toolError)),
        })
      })
      .pipe(Effect.orDie)

    // Pointers appended to results: one UI reminder per edit streak, dependency/license notes, flaky reruns.
    const reminded = new Set<string>()
    const started = new Map<string, number>()
    const seenDeps = new Set<string>()
    const seenLicense = new Set<string>()
    const snapshots = new Map<string, string>()
    const gitShow = (dir: string, name: string) => {
      const result = spawnSync("git", ["-C", dir, "show", `HEAD:./${name}`], { encoding: "utf8" })
      return result.status === 0 ? result.stdout : undefined
    }

    // Whether the request last built for a session holds a /testfirst start. Without one the gate is off,
    // so a source edit skips loading the whole transcript (slow in long sessions).
    const gated = new Map<string, boolean>()
    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        gated.set(event.sessionID, event.messages.some((message) => message.role === "user" && message.content.some((part) => part.type === "text" && part.text.includes(MARK.start))))
      }),
    )

    yield* ctx.tool.hook("execute.before", (event) => {
      if (event.tool === "shell") started.set(event.id, Date.now())
      const files = targets(event.tool, event.input).filter(isSourceFile)
      if (files.length === 0 || gated.get(event.sessionID) === false) return Effect.void
      return ctx.session.context({ sessionID: event.sessionID }).pipe(
        Effect.map((messages) => testFirstPhase(eventsFromMessages(messages))),
        // Fail open: an unreadable transcript must not block editing.
        Effect.catchCause((cause) => Effect.logWarning("InfiniteOC testfirst gate check failed", { cause }).pipe(Effect.as("off" as const))),
        Effect.flatMap((phase) => (phase === "need-test" || phase === "need-red" ? Effect.fail(new Tool.Error({ message: testFirstRefusal(phase, files) })) : Effect.void)),
      )
    })

    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        const began = started.get(event.id)
        started.delete(event.id)
        if (event.status !== "completed") return
        if (event.tool === "ui_check") reminded.delete(event.sessionID)
        const dir = cwd()
        const notes: string[] = []
        const files = targets(event.tool, event.input)
        const input = (event.input ?? {}) as { command?: string; workdir?: string }

        if (files.some((file) => UI_FILE.test(file)) && !reminded.has(event.sessionID)) {
          reminded.add(event.sessionID)
          notes.push("UI file changed. Before reporting done, render it with the ui_check tool (the HTML file of a static page, no server needed; or the URL of a framework's running dev server) to see phone, tablet, desktop and dark mode plus an accessibility audit; design_tokens and component_catalog show what to reuse.")
        }

        // A file the call left unparseable is reported now, not steps later when something imports it.
        for (const file of files.filter(checkable)) {
          const absolute = path.resolve(dir, file)
          try {
            const problem = statSync(absolute).size <= 2_000_000 ? syntaxProblem(path.relative(dir, absolute) || file, readFileSync(absolute, "utf8")) : undefined
            if (problem) notes.push(problem)
          } catch {}
        }

        const manifests = files.filter((file) => MANIFEST.test(file)).map((file) => path.resolve(dir, file))
        if (event.tool === "shell" && input.command && INSTALL.test(input.command)) {
          const base = path.resolve(dir, input.workdir ?? ".")
          for (const name of ["package.json", "requirements.txt"]) if (existsSync(path.join(base, name))) manifests.push(path.join(base, name))
        }
        for (const manifest of manifests) {
          if (!existsSync(manifest)) continue
          const now = readFileSync(manifest, "utf8")
          const before = gitShow(path.dirname(manifest), path.basename(manifest)) ?? snapshots.get(manifest)
          snapshots.set(manifest, now)
          if (before === undefined) continue
          const fresh = addedDeps(manifest, before, now).filter((dep) => !seenDeps.has(`${manifest}:${dep.name}`))
          if (fresh.length === 0) continue
          for (const dep of fresh) seenDeps.add(`${manifest}:${dep.name}`)
          const described = yield* Effect.promise(() => describeAdded(path.dirname(manifest), fresh, networkAllowed(dir)))
          notes.push(`Dependency guard: ${path.relative(dir, manifest)} gains ${fresh.length} new package${fresh.length === 1 ? "" : "s"}:\n${described}\nConfirm each is needed; prefer the standard library or a package the project already uses.${networkAllowed(dir) ? "" : " Release dates need network access (INFINITEOC_QUALITY_NETWORK=1)."}`)
        }

        const vendored = new Set<string>()
        for (const file of files) {
          const match = VENDOR.exec(file)
          if (match) vendored.add(file.slice(0, match.index + match[0].length))
        }
        if (event.tool === "shell" && input.command && /\b(git clone|curl|wget|degit|svn export|cp -r?)\b/.test(input.command))
          for (const match of input.command.matchAll(new RegExp(VENDOR.source, "gi"))) vendored.add(input.command.slice(input.command.lastIndexOf(" ", match.index + 1) + 1, match.index + match[0].length).replace(/^['"]/, ""))
        for (const unit of vendored) {
          const absolute = path.resolve(dir, unit)
          if (!existsSync(absolute)) continue
          const result = scanLicense(absolute, dir)
          const key = `${absolute}:${result.ids.join(",")}`
          if (seenLicense.has(key)) continue
          seenLicense.add(key)
          notes.push(formatLicense(path.relative(dir, absolute) || unit, result, scanLicense(dir, dir).ids[0]))
        }

        const output = event.result.output as { exit?: number; timeout?: boolean } | undefined
        if (event.tool === "shell" && input.command && isTestCommand(input.command) && output?.exit && !output.timeout && process.env.INFINITEOC_QUALITY_FLAKY !== "0" && began && Date.now() - began <= FLAKY_MAX_MS) {
          const base = path.resolve(dir, input.workdir ?? ".")
          const exits: Array<number | undefined> = [output.exit]
          for (let i = 0; i < 2; i++) exits.push((yield* Effect.promise(() => run(input.command!, base, 120_000))).exit)
          const passed = exits.slice(1).filter((exit) => exit === 0).length
          notes.push(
            flakyVerdict(exits) === "consistent"
              ? `Flaky check: reran the failing test command twice and it failed all 3 times (consistent failure, not flaky).`
              : `Flaky check: FLAKY. The command failed once, then passed on ${passed} of 2 reruns. Do not treat the pass as proof the code is right or the failure as proof it is wrong: find the nondeterminism (timing, ordering, shared state, network) and report the test as flaky.`,
          )
        }

        if (notes.length > 0) event.result = { ...event.result, content: [...asArray(event.result.content), { type: "text", text: notes.join("\n\n") }] }
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("InfiniteOC quality hook failed", { cause }))),
    )

    // /testfirst and /prune are prompts to the agent; the testfirst state lives in the transcript.
    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "testfirst",
        description: "write a failing test before the fix, then prove it passes · /testfirst stop",
        execute: (input) => {
          const task = input.prompt.text.trim()
          if (/^(stop|off|cancel)$/i.test(task))
            return ctx.session.synthetic({ sessionID: input.sessionID, text: `${MARK.stopped}\nTest-first mode ended.`, description: "Test-first mode ended", resume: false }).pipe(Effect.asVoid)
          if (!task) return toast("Test first", "Usage: /testfirst <the bug or behavior>, and /testfirst stop to end it.")
          gated.delete(input.sessionID)
          return ctx.session
            .prompt({
              ...input.prompt,
              sessionID: input.sessionID,
              text: `${MARK.start}\nTask: ${task}\n\nTest-first mode is on for this session. A gate refuses edits to source files until the evidence below exists.\n1. Write or extend a test that captures the task (the bug, or the new behavior). Edit only test files until the test exists.\n2. Run the test command and confirm the new test FAILS, for the right reason (an assertion about the behavior, not a syntax or import error).\n3. Only then change the source, with the smallest fix.\n4. Run the tests again; they must pass. Finish by showing the failing run and the passing run.`,
              delivery: input.delivery,
            })
            .pipe(Effect.asVoid)
        },
      })
      editor.add({
        name: "prune",
        description: "list unused exports and files (static scan, nothing is deleted)",
        execute: (input) =>
          ctx.session
            .prompt({
              ...input.prompt,
              sessionID: input.sessionID,
              text: `Run the prune_scan tool${input.prompt.text.trim() ? ` on ${input.prompt.text.trim()}` : ""} and show the user the unused files and exports it lists. Spot-check the most likely candidates with grep before presenting them (dynamic imports, framework routing and public APIs can look unused). Do not delete or edit anything unless the user asks.`,
              delivery: input.delivery,
            })
            .pipe(Effect.asVoid),
      })
    })

    // When a run ends in test-first mode: confirm a finished red-green cycle, or remind the agent (at most twice).
    const busy = new Set<string>()
    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        if (event.type !== "session.execution.succeeded") return Effect.void
        const sessionID = event.data.sessionID
        if (busy.has(sessionID)) return Effect.void
        busy.add(sessionID)
        return ctx.session.context({ sessionID }).pipe(
          Effect.flatMap((messages) => {
            const phase = testFirstPhase(eventsFromMessages(messages))
            const action = testFirstEnd(phase, reminderCount(messages))
            if (action === "none") return Effect.void
            if (action === "done")
              return toast("Test first", "Confirmed: the new test failed before the fix and passes after it.", "success").pipe(
                Effect.andThen(ctx.session.synthetic({ sessionID, text: `${MARK.done}\nTest-first cycle confirmed: failing run, then passing run.`, description: "Test-first cycle confirmed", resume: false })),
              )
            if (action === "gave-up") return toast("Test first", "The agent stopped without a failing-then-passing test run. Source edits stay gated; /testfirst stop ends the mode.", "warning")
            const reminder =
              phase === "need-test"
                ? "You have not written the failing test yet. Write or extend a test for the task, run it, and show it failing before changing source."
                : phase === "need-red"
                  ? "You wrote a test but no run shows it failing. Run the test command and confirm it fails for the right reason before changing source."
                  : "The test failed, but no passing run followed your fix. Run the tests again and show they pass."
            return ctx.session.synthetic({ sessionID, text: `${MARK.reminder}\n${reminder}`, description: "Test-first reminder", resume: true })
          }),
          Effect.catchCause((cause) => Effect.logWarning("InfiniteOC testfirst check failed", { sessionID, cause })),
          Effect.ensuring(Effect.sync(() => busy.delete(sessionID))),
        )
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
