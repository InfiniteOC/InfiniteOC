import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Plugin } from "@opencode/plugin/tui"
import { sessionChanges } from "./diffs"
import { slug, toHtml, toMarkdown, type Message } from "./logic"

const unwrap = (value: any) => (value && !Array.isArray(value) && "data" in value ? value.data : value)
const exists = (file: string) => access(file).then(() => true, () => false)

/** Writes the session as Markdown or HTML, including the file diffs it produced. Asks before overwriting. */
export async function exportTranscript(context: Plugin.Context, sessionID: string, argument?: string) {
  const ui = context.ui.dialog
  const wanted = argument?.trim().toLowerCase()
  const format =
    wanted === "md" || wanted === "markdown" ? "md" : wanted === "html" ? "html" : await ui.select({
      title: "Export transcript",
      options: [
        { title: "Markdown", value: "md" as const, description: "turns, tool calls and a Changes section with diffs" },
        { title: "HTML", value: "html" as const, description: "single self-contained page with coloured diffs" },
      ],
    })
  if (!format) return
  const info = context.data.session.get(sessionID)
  const exported = unwrap(await context.client.session.export({ sessionID }))
  const diffs = await sessionChanges(context.client, sessionID).catch(() => [])
  const title = exported.info.title || info?.title || sessionID
  const directory = exported.info.location?.directory ?? info?.location.directory ?? process.cwd()
  const date = new Date().toISOString().slice(0, 10)
  const answer = await ui.prompt({ title: "Save transcript as", value: path.join(directory, `${slug(title)}-${date}.${format}`) })
  if (!answer?.trim()) return
  const file = path.resolve(directory, answer.trim())
  if ((await exists(file)) && !(await ui.confirm({ title: "File exists", message: `Overwrite ${file}?`, label: { confirm: "Overwrite" } }))) return
  const input = { title, id: sessionID, created: exported.info.time.created, updated: exported.info.time.updated, messages: exported.messages as Message[], diffs }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, format === "md" ? toMarkdown(input) : toHtml(input))
  context.ui.toast.show({ variant: "success", title: "Transcript saved", message: `${file} (${diffs.length} changed files)`, duration: 8000 })
}
