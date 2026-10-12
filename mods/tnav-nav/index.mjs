import { readFile, readdir } from "node:fs/promises"

const dir = "packages/tui/src/feature-plugins/tnav"
const tui = "packages/tui/src"

// Every anchor is a single line or short block that other mods have no reason to touch.
export const patches = [
  [`${tui}/plugin/builtins.ts`, 'import Latex from "@opencode/latex/plugin"', 'import Latex from "@opencode/latex/plugin"\nimport TuiNav from "../feature-plugins/tnav"'],
  [`${tui}/plugin/builtins.ts`, "  Merman,\n", "  TuiNav,\n  Merman,\n"],
  [`${tui}/routes/session/index.tsx`, 'import { DialogMessage } from "./dialog-message"', 'import { DialogMessage } from "./dialog-message"\nimport { loaderJump, registerJump } from "../../feature-plugins/tnav/jump"'],
  [`${tui}/routes/session/index.tsx`, "  function toBottom() {", "  onCleanup(\n    registerJump(\n      route.sessionID,\n      loaderJump({\n        has: (id) => !!data.session.message.get(route.sessionID, id),\n        more: () => data.session.message.more(route.sessionID),\n        size: () => data.session.message.list(route.sessionID).length,\n        loadMore: () => data.session.message.loadMore(route.sessionID),\n        jump: jumpToMessage,\n      }),\n    ),\n  )\n\n  function toBottom() {"],
  [`${tui}/routes/session/dialog-message.tsx`, 'import { projectedPromptInput } from "../../prompt/codec"', 'import { projectedPromptInput } from "../../prompt/codec"\nimport { useBookmarks } from "../../feature-plugins/tnav/marks"'],
  [`${tui}/routes/session/dialog-message.tsx`, "  const message = createMemo(() => data.session.message.get(props.sessionID, props.messageID))\n", "  const message = createMemo(() => data.session.message.get(props.sessionID, props.messageID))\n  const bookmarks = useBookmarks()\n"],
  [
    `${tui}/routes/session/dialog-message.tsx`,
    '        {\n          title: "Copy",',
    `        {
          title: bookmarks.has(props.sessionID, props.messageID) ? "Remove bookmark" : "Bookmark",
          value: "message.bookmark",
          description: "jump back with /bookmarks or alt+n / alt+p",
          onSelect: (dialog) => {
            const value = message()
            void bookmarks.toggle(props.sessionID, props.messageID, value && "text" in value ? String(value.text) : "")
            dialog.clear()
          },
        },
        {
          title: "Copy",`,
  ],
  [`${tui}/routes/session/sidebar.tsx`, 'import "../../component/title-shimmer"', 'import "../../component/title-shimmer"\nimport { InlineTitle } from "../../feature-plugins/tnav/title"'],
  [`${tui}/routes/session/sidebar.tsx`, "        <box flexShrink={0} paddingRight={2} paddingBottom={1}>\n          <title_shimmer", "        <box flexShrink={0} paddingRight={2} paddingBottom={1}>\n          <InlineTitle sessionID={props.sessionID}>\n          <title_shimmer"],
  [`${tui}/routes/session/sidebar.tsx`, "          </title_shimmer>\n        </box>", "          </title_shimmer>\n          </InlineTitle>\n        </box>"],
  [`${tui}/component/command-palette.tsx`, 'import { DialogConfig, settingID, settings } from "./dialog-config"', 'import { DialogConfig, settingID, settings } from "./dialog-config"\nimport { paletteExtras } from "../feature-plugins/tnav/palette"'],
  [`${tui}/component/command-palette.tsx`, "  let ref: DialogSelectRef<string>\n  const list = () => {\n    if (ref?.filter) return [...options(), ...settingOptions]", "  const extras = paletteExtras()\n  let ref: DialogSelectRef<string>\n  const list = () => {\n    if (ref?.filter) return [...options(), ...settingOptions, ...extras.options(ref.filter)]"],
  [`${tui}/component/command-palette.tsx`, 'title="Commands" options={list()} flat={true} filterThreshold={0.7} />', 'title="Commands" options={list()} flat={true} filterThreshold={0.7} onFilter={extras.setFilter} />'],
]

export default {
  id: "tnav-nav",
  version: "1.0.0",
  async setup(api) {
    const source = new URL("./tui/", import.meta.url)
    for (const file of await readdir(source)) await api.write(`${dir}/${file}`, await readFile(new URL(file, source), "utf8"))
    for (const [file, before, after] of patches) await api.patchExact(file, before, after)
  },
}
