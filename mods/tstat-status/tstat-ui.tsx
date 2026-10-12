// InfiniteOC tstat: UI pieces used by patches in upstream files. Copied to
// packages/tui/src/feature-plugins/system/tstat-ui.tsx by mods/tstat-status.
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createResource, createSignal, For, Show, type JSX } from "solid-js"
import { useClient } from "../../context/client"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { expandAll, icons, settings } from "./tstat-state"
import { parseGitStatus, relativeTime } from "./tstat-logic"

const CAP = 14

/** Caps a tool body to a few lines. Click the hint, or run /expand for every body at once. */
export function Capped(props: { disabled?: boolean; children: JSX.Element }) {
  const theme = useTheme()
  const [open, setOpen] = createSignal(false)
  const [height, setHeight] = createSignal(0)
  const active = () => !props.disabled && settings().compact && !expandAll()
  const hidden = () => active() && !open()
  return (
    <>
      <box maxHeight={hidden() ? CAP : undefined} overflow="hidden" flexShrink={0}>
        <box
          flexShrink={0}
          onSizeChange={function () {
            setHeight(this.height)
          }}
        >
          {props.children}
        </box>
      </box>
      <Show when={active() && height() > CAP}>
        <text
          fg={theme.text.muted}
          onMouseUp={(event) => {
            event.stopPropagation()
            setOpen((value) => !value)
          }}
        >
          {open() ? "collapse" : `${height() - CAP} more lines hidden, click to expand (/expand opens all)`}
        </text>
      </Show>
    </>
  )
}

function git(args: string[], cwd: string) {
  return new Promise<string>((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    })
    let out = ""
    const timer = setTimeout(() => child.kill(), 4000)
    child.stdout.on("data", (chunk) => (out += chunk))
    child.on("error", () => resolve(""))
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? out.trim() : "")
    })
  })
}

/** Update status of this InfiniteOC checkout, read locally: no network, no fetch. */
async function updateStatus() {
  const skills = process.env.INFINITEOC_SKILLS
  if (!skills) return undefined
  const home = dirname(skills)
  const state = await readFile(join(home, ".runtime", "update.json"), "utf8").then(JSON.parse).catch(() => ({}))
  const behind = Number(await git(["rev-list", "--count", "HEAD..@{u}"], home)) || 0
  const checked = typeof state.checkedAt === "number" ? relativeTime(state.checkedAt) : undefined
  return { behind, checked, error: typeof state.error === "string" ? state.error : undefined }
}

export function Dashboard(props: { directory: string }) {
  const theme = useTheme()
  const client = useClient()
  const route = useRoute()
  const [status] = createResource(() => props.directory, async (directory) => parseGitStatusOrUndefined(await git(["status", "--porcelain=v1", "--branch"], directory)))
  const [update] = createResource(updateStatus)
  const [recent] = createResource(
    () => props.directory,
    (directory) =>
      client.api.session
        .list({ directory, limit: 4, order: "desc", parentID: null })
        .then((response) => response.data)
        .catch(() => []),
  )
  const mark = icons()
  return (
    <box width="100%" maxWidth={75} paddingTop={1} flexShrink={0} flexDirection="column" paddingLeft={1}>
      <Show when={status()}>
        {(value) => (
          <text fg={theme.text.muted} wrapMode="none">
            <span style={{ fg: theme.text.base }}>{mark.branch} {value().branch}</span>
            {value().ahead ? ` · ahead ${value().ahead}` : ""}
            {value().behind ? ` · behind ${value().behind}` : ""}
            {value().clean
              ? " · clean"
              : ` · ${[
                  value().staged ? `${value().staged} staged` : "",
                  value().changed ? `${value().changed} changed` : "",
                  value().untracked ? `${value().untracked} untracked` : "",
                ]
                  .filter(Boolean)
                  .join(", ")}`}
          </text>
        )}
      </Show>
      <Show when={update()}>
        {(value) => (
          <text fg={value().behind ? theme.text.feedback.warning.base : theme.text.muted} wrapMode="none">
            {value().behind
              ? `${mark.update} ${value().behind} update${value().behind === 1 ? "" : "s"} available, applied on the next launch`
              : `${mark.ok} up to date`}
            {value().checked ? ` · checked ${value().checked}` : ""}
            {value().error ? ` · last check failed` : ""}
          </text>
        )}
      </Show>
      <Show when={(recent() ?? []).length > 0}>
        <box paddingTop={1} flexDirection="column">
          <text fg={theme.text.muted}>Recent sessions</text>
          <For each={recent() ?? []}>
            {(session) => (
              <box
                flexDirection="row"
                gap={1}
                onMouseUp={() => route.navigate({ type: "session", sessionID: session.id })}
              >
                <text fg={theme.text.muted} flexShrink={0}>{mark.session}</text>
                <text fg={theme.text.base} wrapMode="none" flexGrow={1} flexShrink={1}>
                  {session.title || "Untitled"}
                </text>
                <text fg={theme.text.muted} flexShrink={0}>{relativeTime(session.time.updated)}</text>
              </box>
            )}
          </For>
          <text fg={theme.text.muted}>click to open, /sessions for all</text>
        </box>
      </Show>
    </box>
  )
}

function parseGitStatusOrUndefined(output: string) {
  return output ? parseGitStatus(output) : undefined
}
