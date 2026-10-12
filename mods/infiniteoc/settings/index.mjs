import { readFile } from "node:fs/promises"

function replace(source, before, after) {
  if (source.includes(after)) return source
  if (source.split(before).length !== 2) throw new Error("InfiniteOC settings: incompatible upstream dialog-config anchor")
  return source.replace(before, after)
}
export async function installSettings(api) {
  for (const name of ["dialog-infiniteoc.tsx", "settings-store.ts", "settings-store.mjs"]) {
    await api.write(`packages/tui/src/component/${name}`, await readFile(new URL(name, import.meta.url), "utf8"))
  }
  await api.patch("packages/tui/src/component/dialog-config.tsx", (source) => {
    source = replace(source, 'import { useToast } from "../ui/toast"', 'import { useToast } from "../ui/toast"\nimport { useDialog } from "../ui/dialog"\nimport { DialogInfiniteOC } from "./dialog-infiniteoc"')
    source = replace(source, 'export const settings: Setting[] = [', 'export const settings: Setting[] = [\n  { title: "InfiniteOC Settings", category: "InfiniteOC", path: ["infiniteoc"], default: "open", format: () => "open", keywords: ["proxy", "tor", "provider", "api key"] },')
    source = replace(source, 'export function DialogConfig(props: { current?: string }) {\n  const config = useConfig()', 'export function DialogConfig(props: { current?: string }) {\n  const dialog = useDialog()\n  const config = useConfig()')
    return replace(source, '    const setting = settings[index]\n    const current = value(setting)', '    const setting = settings[index]\n    if (setting.path[0] === "infiniteoc") {\n      dialog.replace(() => <DialogInfiniteOC />)\n      return\n    }\n    const current = value(setting)')
  })
}