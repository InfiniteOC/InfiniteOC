import type { FeatureContext } from "./api"
import { addItem, glossaryFile, listItems, memoryFile, projectRoot, removeItem, replaceItem, termKey } from "./ctx-store"

const guard = (ctx: FeatureContext, work: () => void) => {
  try {
    work()
  } catch (error) {
    ctx.toast.show({ variant: "error", title: "Not saved", message: error instanceof Error ? error.message : String(error) })
  }
}

// One browser for both lists: project memory (agent and user notes) and the glossary.
export async function run(ctx: FeatureContext) {
  const root = projectRoot(process.cwd())
  const kinds = {
    memory: { title: "Project memory", file: memoryFile(root), hint: "A fact, e.g. run tests with npm test", key: undefined },
    glossary: { title: "Glossary", file: glossaryFile(root), hint: "term: meaning", key: termKey },
  } as const
  const kind = await ctx.ui.select({
    title: "Project knowledge (loaded into every session)",
    options: [
      { title: "Project memory", value: "memory" as const, description: `${listItems(kinds.memory.file).length} saved notes` },
      { title: "Glossary", value: "glossary" as const, description: `${listItems(kinds.glossary.file).length} terms` },
    ],
  })
  if (!kind) return
  const list = kinds[kind]
  for (;;) {
    const items = listItems(list.file)
    const choice = await ctx.ui.select({
      title: `${list.title} · ${items.length} entries`,
      options: [{ title: "Add an entry", value: "add" }, ...items.map((item, i) => ({ title: item, value: String(i + 1) }))],
    })
    if (!choice) return
    if (choice === "add") {
      const text = await ctx.ui.prompt({ title: `Add to ${list.title.toLowerCase()}`, placeholder: list.hint })
      if (text) guard(ctx, () => addItem(list.file, text, list.key))
      continue
    }
    const position = Number(choice)
    const action = await ctx.ui.select({ title: items[position - 1], options: [{ title: "Edit", value: "edit" }, { title: "Remove", value: "remove" }] })
    if (action === "edit") {
      const text = await ctx.ui.prompt({ title: "Edit entry", value: items[position - 1] })
      if (text) guard(ctx, () => replaceItem(list.file, position, text))
    } else if (action === "remove") guard(ctx, () => removeItem(list.file, position))
  }
}
