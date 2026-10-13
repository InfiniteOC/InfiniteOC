import { readFile } from "node:fs/promises"

const tui = "packages/tui/src"

// Reuses upstream's auto-approve mode ("autoaccept"): the session route already answers "once" to every
// pending request in that mode and the prompt already shows an indicator. /yolo adds a runtime-only
// switch for it, keeps safe-guard's always-ask requests in front of the user, and labels the indicator.
export const patches = [
  [`${tui}/context/permission.tsx`, 'import { createSimpleContext } from "./helper"', 'import { createSimpleContext } from "./helper"\nimport { yoloEnabled, yoloInherit } from "../infiniteoc-features/yolo-state"'],
  [`${tui}/context/permission.tsx`, "    const config = useConfig()\n    return {\n      get mode(): PermissionMode {\n        return args.auto ? \"autoaccept\" : config.data.session.permissions",
    "    const config = useConfig()\n    yoloInherit(() => args.auto || config.data.session.permissions === \"autoaccept\")\n    return {\n      get mode(): PermissionMode {\n        return yoloEnabled() || args.auto ? \"autoaccept\" : config.data.session.permissions"],
  [`${tui}/routes/session/index.tsx`, 'import { PermissionPrompt } from "./permission"', 'import { PermissionPrompt } from "./permission"\nimport { yoloAlwaysAsk } from "../../infiniteoc-features/yolo-state"'],
  [`${tui}/routes/session/index.tsx`, 'const promptedPermissions = createMemo(() => (local.permission.mode === "autoaccept" ? [] : permissions()))',
    'const promptedPermissions = createMemo(() => (local.permission.mode === "autoaccept" ? permissions().filter(yoloAlwaysAsk) : permissions()))'],
  [`${tui}/routes/session/index.tsx`, '    if (local.permission.mode !== "autoaccept") return\n    permissions().forEach((request) => {',
    '    if (local.permission.mode !== "autoaccept") return\n    permissions().filter((request) => !yoloAlwaysAsk(request)).forEach((request) => {'],
  [`${tui}/routes/session/index.tsx`, '    if (local.permission.mode === "autoaccept") return false\n    const request = data.session.permission.list(ctx.sessionID)?.[0]',
    '    const pending = data.session.permission.list(ctx.sessionID) ?? []\n    const request = local.permission.mode === "autoaccept" ? pending.find(yoloAlwaysAsk) : pending[0]'],
  [`${tui}/component/prompt/metadata.tsx`, 'import { stringWidth } from "../../util/string-width"', 'import { stringWidth } from "../../util/string-width"\nimport { yoloEnabled } from "../../infiniteoc-features/yolo-state"'],
  [`${tui}/component/prompt/metadata.tsx`, "          <text fg={fade(theme.text.muted, props.agentAlpha)}>auto</text>",
    "          <text\n            fg={fade(yoloEnabled() ? theme.text.feedback.warning.base : theme.text.muted, props.agentAlpha)}\n            attributes={yoloEnabled() ? TextAttributes.BOLD : undefined}\n          >\n            {yoloEnabled() ? \"YOLO\" : \"auto\"}\n          </text>"],
]

export default {
  id: "yolo",
  version: "1.0.0",
  async setup(api) {
    const file = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")
    await api.write(`${tui}/infiniteoc-features/yolo-state.ts`, await file("yolo-state.ts"))
    for (const [path, before, after] of patches) await api.patchExact(path, before, after)
    api.tui.command({
      id: "toggle",
      title: "Toggle YOLO mode (auto-approve permissions)",
      category: "Session",
      slash: "yolo",
      source: await file("command.tsx"),
    })
  },
}
