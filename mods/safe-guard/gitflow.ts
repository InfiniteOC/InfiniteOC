// InfiniteOC git workflow commands: /rewind, /squash, /fork-task, /merge, /pr, /issue, /changelog,
// /resolve, /blame-why, /split, /debt, and opt-in auto-commit per turn.
// Written to packages/core/src/plugin/infiniteoc-gitflow.ts by mods/safe-guard.
// Most commands gather git/gh facts here and hand the agent a focused prompt, the way /goal does;
// anything outward-facing (git push, gh pr create) stays behind the permission prompt that
// infiniteoc-safety forces for it. Everything above the Plugin definition is pure or sync git and
// is unit tested by mods/safe-guard/test.mjs.
import { define } from "@opencode/plugin/effect/plugin"
import { TuiEvent } from "@opencode/schema/tui-event"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Stream } from "effect"
import { execFileSync } from "child_process"
import { rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Bus } from "../bus.js"
import { Session as SessionService } from "../session.js"
import { startText } from "./infiniteoc-goal.js"
import { loadConfig } from "./infiniteoc-safety.js"

const MAX = 24000

/** Run a command and return stdout (trimmed, capped), or the failure text. Never throws. */
export function sh(cwd: string, command: string, args: string[], env?: Record<string, string>): { ok: boolean; out: string } {
  try {
    const out = execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30000, stdio: ["ignore", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env })
    return { ok: true, out: out.length > MAX ? out.slice(0, MAX) + "\n[truncated]" : out.trim() }
  } catch (error) {
    const text = error as { stderr?: string; message?: string }
    return { ok: false, out: (text.stderr || text.message || "failed").toString().trim() }
  }
}

export const slug = (text: string, max = 40) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "task"

// --- changelog ------------------------------------------------------------------------------

const SECTIONS: ReadonlyArray<readonly [string, string]> = [["feat", "Added"], ["fix", "Fixed"], ["perf", "Performance"], ["refactor", "Changed"], ["docs", "Documentation"], ["revert", "Reverted"]]

/** Pure: a Keep-a-Changelog style draft from commit subjects. Non-conventional subjects go under Other. */
export function changelogDraft(subjects: ReadonlyArray<string>): string {
  const groups = new Map<string, string[]>()
  for (const subject of subjects) {
    const match = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/.exec(subject)
    const heading = (match && SECTIONS.find(([type]) => type === match[1])?.[1]) ?? "Other"
    const line = match && heading !== "Other" ? `${match[2] ? `**${match[2]}:** ` : ""}${match[4]}${match[3] ? " (breaking)" : ""}` : subject
    groups.set(heading, [...(groups.get(heading) ?? []), line])
  }
  const order = [...SECTIONS.map(([, heading]) => heading), "Other"]
  return [...new Set(order)].filter((heading) => groups.has(heading)).map((heading) => `### ${heading}\n${groups.get(heading)!.map((line) => `- ${line}`).join("\n")}`).join("\n\n")
}

// --- debt -----------------------------------------------------------------------------------

const DEBT = /ponytail:|\b(?:TODO|FIXME|HACK|XXX)\b/

/** Pure: debt markers from `git grep -n` output ("file:line:text"), marking those also present in the diff's added lines. */
export function harvestDebt(grep: string, diff: string): Array<{ file: string; line: number; text: string; added: boolean }> {
  const added = new Set(diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++") && DEBT.test(line)).map((line) => line.slice(1).trim()))
  return grep.split("\n").flatMap((entry) => {
    const match = /^(.+?):(\d+):(.*)$/.exec(entry)
    if (!match || !DEBT.test(match[3])) return []
    const text = match[3].trim()
    return [{ file: match[1], line: Number(match[2]), text: text.slice(0, 160), added: added.has(text) }]
  })
}

/** Pure: "src/a.ts:42" -> parts (the last :N is the line). */
export function parseLocation(arg: string): { file: string; line: number } | undefined {
  const match = /^(.+?):(\d+)(?:-\d+)?$/.exec(arg.trim())
  return match ? { file: match[1], line: Number(match[2]) } : undefined
}

/** Pure: the user turns of a transcript, newest first, skipping goal/readonly control messages. */
export function userTurns(messages: ReadonlyArray<SessionMessage.Info>): Array<{ id: string; text: string }> {
  return messages
    .flatMap((message) => (message.type === "user" && message.text.trim() && !message.text.startsWith("[InfiniteOC") ? [{ id: message.id as string, text: message.text.trim().split("\n")[0].slice(0, 70) }] : []))
    .reverse()
}

// --- auto-commit on a scratch branch --------------------------------------------------------

export const AUTO = "[auto] "
export const autoBranch = (sessionID: string) => `infiniteoc/auto/${sessionID.slice(-10)}`

/**
 * Commit the working tree onto refs/heads/<branch> with plumbing and a temporary index, so the user's
 * branch, index, stash and working tree are never touched. Returns the commit, or undefined when
 * nothing changed since the branch tip (or since HEAD for the first commit).
 */
export function autoCommit(cwd: string, branch: string, message: string): { commit?: string; error?: string } {
  const index = path.join(tmpdir(), `infiniteoc-index-${process.pid}-${Date.now()}`)
  const env = { GIT_INDEX_FILE: index }
  const run = (...args: string[]) => sh(cwd, "git", args, env)
  try {
    const ref = `refs/heads/${branch}`
    const parent = [ref, "HEAD"].map((name) => run("rev-parse", "--verify", "-q", name)).find((result) => result.ok && result.out)?.out
    if (parent && !run("read-tree", parent).ok) return { error: "read-tree failed" }
    const added = run("add", "-A")
    if (!added.ok) return { error: added.out }
    const tree = run("write-tree")
    if (!tree.ok) return { error: tree.out }
    if (parent && run("rev-parse", `${parent}^{tree}`).out === tree.out) return {}
    const identity = run("config", "user.email").out ? [] : ["-c", "user.name=InfiniteOC", "-c", "user.email=infiniteoc@localhost"]
    const commit = run(...identity, "commit-tree", tree.out, ...(parent ? ["-p", parent] : []), "-m", message)
    if (!commit.ok) return { error: commit.out }
    const updated = run("update-ref", ref, commit.out)
    return updated.ok ? { commit: commit.out } : { error: updated.out }
  } finally {
    rmSync(index, { force: true })
  }
}

/** Pure: given `git log --first-parent --format=%H%x09%s` of the scratch branch, the auto commits at its tip and the base below them. */
export function autoChain(log: string): { count: number; subjects: string[]; tip?: string } {
  const rows = log.split("\n").filter(Boolean).map((row) => row.split("\t"))
  const chain: Array<[string, string]> = []
  for (const [hash, subject = ""] of rows) {
    if (!subject.startsWith(AUTO)) break
    chain.push([hash, subject.slice(AUTO.length)])
  }
  return { count: chain.length, subjects: chain.map(([, subject]) => subject).reverse(), tip: chain[0]?.[0] }
}

/** Squash the scratch branch's auto commits into one commit on the same base. The old tip is kept under refs/infiniteoc/backup. */
export function squashAuto(cwd: string, branch: string, message?: string): { ok: boolean; text: string } {
  const ref = `refs/heads/${branch}`
  if (!sh(cwd, "git", ["rev-parse", "--verify", "-q", ref]).ok) return { ok: false, text: `No auto-commit branch ${branch} yet. Turn on "autoCommit" in the safety settings.` }
  const chain = autoChain(sh(cwd, "git", ["log", "--first-parent", "--format=%H%x09%s", ref]).out)
  if (chain.count < 2) return { ok: false, text: `Nothing to squash: ${chain.count} auto commit on ${branch}.` }
  const base = sh(cwd, "git", ["rev-parse", `${chain.tip}~${chain.count}`]).out
  const tree = sh(cwd, "git", ["rev-parse", `${chain.tip}^{tree}`]).out
  const body = message?.trim() || `${chain.subjects[0]}\n\nSquashed ${chain.count} turns:\n${chain.subjects.map((subject) => `- ${subject}`).join("\n")}`
  const identity = sh(cwd, "git", ["config", "user.email"]).out ? [] : ["-c", "user.name=InfiniteOC", "-c", "user.email=infiniteoc@localhost"]
  const commit = sh(cwd, "git", [...identity, "commit-tree", tree, "-p", base, "-m", body])
  if (!commit.ok) return { ok: false, text: commit.out }
  sh(cwd, "git", ["update-ref", `refs/infiniteoc/backup/${branch}-${Date.now()}`, chain.tip!])
  const updated = sh(cwd, "git", ["update-ref", ref, commit.out])
  return updated.ok ? { ok: true, text: `Squashed ${chain.count} turns into ${commit.out.slice(0, 8)} on ${branch}. The old tip is kept under refs/infiniteoc/backup/. Your branch is untouched; bring it in with git merge --squash ${branch} or git cherry-pick ${commit.out.slice(0, 8)}.` } : { ok: false, text: updated.out }
}

// --- prompts --------------------------------------------------------------------------------

const defaultBase = (cwd: string) => {
  const head = sh(cwd, "git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
  if (head.ok && head.out) return head.out
  return ["main", "master"].find((name) => sh(cwd, "git", ["rev-parse", "--verify", "-q", name]).ok) ?? "HEAD~1"
}

const recent = (cwd: string, n = 15) => sh(cwd, "git", ["log", "-n", String(n), "--format=%s"]).out

export function prPrompt(cwd: string, extra: string): string {
  const base = defaultBase(cwd)
  return [
    "[InfiniteOC /pr] Prepare a pull request for the current branch.",
    `Branch: ${sh(cwd, "git", ["branch", "--show-current"]).out || "(detached)"}   Base: ${base}`,
    `Uncommitted changes:\n${sh(cwd, "git", ["status", "--short"]).out || "(none)"}`,
    `Commits on this branch:\n${sh(cwd, "git", ["log", `${base}..HEAD`, "--format=%h %s"]).out || "(none)"}`,
    `Diffstat against the base:\n${sh(cwd, "git", ["diff", `${base}...HEAD`, "--stat"]).out || "(none)"}`,
    `Recent commit subjects (follow this style):\n${recent(cwd)}`,
    "Steps: 1) If there are uncommitted changes that belong to this work, commit them with a message in the style above (no attribution trailers). 2) Write a PR title (under 70 characters) and a body from this session and the diff: what changed, why, how it was verified, anything reviewers should check. Read the diff and the session; do not invent. 3) Show the title and body to the user. 4) Only then push the branch and run `gh pr create`; both ask for the user's approval. Never force push, never merge, never post other comments.",
    extra && `User notes: ${extra}`,
  ].filter(Boolean).join("\n\n")
}

export function changelogPrompt(cwd: string, ref: string): string | undefined {
  const since = ref || sh(cwd, "git", ["describe", "--tags", "--abbrev=0"]).out
  const range = since && sh(cwd, "git", ["rev-parse", "--verify", "-q", since]).ok ? `${since}..HEAD` : "HEAD"
  const log = sh(cwd, "git", ["log", range, "--no-merges", "--format=%s"])
  if (!log.ok || !log.out) return undefined
  return [
    `[InfiniteOC /changelog] Write a changelog for ${range === "HEAD" ? "the whole history (no tag found)" : range}.`,
    `Draft grouped from the commit subjects:\n\n${changelogDraft(log.out.split("\n"))}`,
    "Rewrite it for readers: merge duplicates, drop noise (chores, merges), say what changed for users, keep breaking changes first. Output the final section in Keep a Changelog format in your reply. Do not edit CHANGELOG.md unless the user asks.",
  ].join("\n\n")
}

export function resolvePrompt(cwd: string): string | undefined {
  const files = sh(cwd, "git", ["diff", "--name-only", "--diff-filter=U"]).out
  if (!files) return undefined
  return [
    "[InfiniteOC /resolve] Walk the merge conflicts one hunk at a time.",
    `Conflicted files:\n${files}`,
    `Operation in progress: ${["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"].find((name) => sh(cwd, "git", ["rev-parse", "--verify", "-q", name]).ok) ?? "unknown"}`,
    "For each file, read it, and for each conflict hunk explain in two or three lines: what ours changed, what theirs changed, why they collide, and which resolution you recommend and why (check callers and tests when the choice is not obvious; use git log -p for either side when intent is unclear). Then apply the resolution with the edit tool and remove the markers. After each file say what you decided. Do not run git add, git commit, git merge --continue or git rebase --continue; tell the user to once all hunks are resolved. If a hunk needs a product decision, ask the user instead of guessing.",
  ].join("\n\n")
}

export function blamePrompt(cwd: string, where: { file: string; line: number }): string {
  const { file, line } = where
  return [
    `[InfiniteOC /blame-why] Explain why ${file}:${line} is the way it is.`,
    `Current line and blame:\n${sh(cwd, "git", ["blame", "-L", `${line},${line}`, "--porcelain", "--", file]).out}`,
    `History of that line (newest first):\n${sh(cwd, "git", ["log", "-L", `${line},${line}:${file}`, "-n", "5", "--no-color", "--format=commit %h %an %ad%n%s%n%b", "--date=short"]).out.slice(0, 12000)}`,
    "Answer from the commits above: who introduced the line, when, what the message says about intent, and how it changed since. Read the surrounding code and linked issue numbers in messages if the intent is unclear. Say plainly when the history does not explain the why; do not invent a reason.",
  ].join("\n\n")
}

export function splitPrompt(cwd: string): string {
  return [
    "[InfiniteOC /split] Split the current changes into small, reviewable commits (a stacked series).",
    `Status:\n${sh(cwd, "git", ["status", "--short"]).out || "(clean)"}`,
    `Diffstat:\n${sh(cwd, "git", ["diff", "HEAD", "--stat"]).out || "(none)"}`,
    `Commit style (recent subjects):\n${recent(cwd, 10)}`,
    "Plan first: group changes by purpose (refactor before feature, tests with the code they test, mechanical renames alone), so each commit builds and tests on its own and reads as one idea. Show the plan as a numbered list of commit subjects with their files and wait for the user's go-ahead. Then commit in order by staging only that commit's files (git add <paths>; for a file shared by two commits use git apply --cached with a trimmed patch). Run the tests between commits when cheap. Never use git add -A, reset, stash, rebase or amend, and never push.",
  ].join("\n\n")
}

export function debtPrompt(cwd: string): string {
  const grep = sh(cwd, "git", ["grep", "-n", "-I", "-E", "ponytail:|TODO|FIXME|HACK|XXX", "--", ".", ":(exclude)*.lock", ":(exclude)package-lock.json", ":(exclude)skills"]).out
  const items = harvestDebt(grep, sh(cwd, "git", ["diff", "HEAD", "-U0"]).out)
  const lines = items.slice(0, 120).map((item) => `${item.added ? "NEW " : "    "}${item.file}:${item.line}  ${item.text}`)
  return [
    "[InfiniteOC /debt] Report the debt markers (ponytail:, TODO, FIXME, HACK, XXX) in this repository.",
    `${items.length} found, ${items.filter((item) => item.added).length} added since HEAD (marked NEW):\n${lines.join("\n") || "(none)"}${items.length > 120 ? `\n...and ${items.length - 120} more` : ""}`,
    "Present the NEW ones first, then group the rest by file or theme. For each ponytail: marker name its ceiling and the trigger to upgrade; for each TODO say whether it is still true by reading the code around it. End with the three worth doing next. Report only; do not edit files.",
  ].join("\n\n")
}

export const Plugin = define({
  id: "infiniteoc.gitflow",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const sessions = yield* SessionService.Service
    const dir = ctx.location.directory
    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info", title = "Git") =>
      bus.publish(TuiEvent.ToastShow, { title, message, variant, duration: 9000 })
    const prompts = new Map<string, string>()

    // Prompt-style commands: build the prompt (or a reason to stop) from git facts, then send it.
    const promptCommand = (name: string, description: string, build: (arg: string, id: Session.ID) => string | { toast: string } | undefined) => ({
      name,
      description,
      execute: (input: { sessionID: Session.ID; prompt: { text: string }; delivery: any }) =>
        Effect.suspend(() => {
          const built = build(input.prompt.text.trim(), input.sessionID)
          if (typeof built !== "string") return toast(built?.toast ?? "Nothing to do.", "info", `/${name}`)
          return ctx.session.prompt({ ...(input.prompt as any), sessionID: input.sessionID, text: built, delivery: input.delivery }).pipe(Effect.asVoid)
        }).pipe(Effect.catchCause((cause) => toast(String(cause).slice(0, 300), "error", `/${name} failed`))),
    })

    const forks = () =>
      sh(dir, "git", ["worktree", "list", "--porcelain"]).out.split("\n\n").flatMap((block) => {
        const dirOf = /^worktree (.+)$/m.exec(block)?.[1]
        const branch = /^branch refs\/heads\/(infiniteoc\/fork-.+)$/m.exec(block)?.[1]
        return dirOf && branch ? [{ dir: dirOf, branch }] : []
      })

    yield* ctx.command.transform((editor) => {
      editor.add(promptCommand("pr", "write the commit message and PR body from this session, open the PR with gh (asks first)", (arg) => prPrompt(dir, arg)))
      editor.add(promptCommand("changelog", "changelog from commits since the last tag · /changelog [since-ref]", (arg) => changelogPrompt(dir, arg) ?? { toast: "No commits to summarize." }))
      editor.add(promptCommand("resolve", "walk merge conflicts hunk by hunk with an explanation", () => resolvePrompt(dir) ?? { toast: "No merge conflicts in the working tree." }))
      editor.add(promptCommand("blame-why", "why a line is the way it is · /blame-why file:line", (arg) => {
        const where = parseLocation(arg)
        return where ? blamePrompt(dir, where) : { toast: "Usage: /blame-why path/to/file:42" }
      }))
      editor.add(promptCommand("split", "split this session's changes into reviewable commits (agent-driven)", () => splitPrompt(dir)))
      editor.add(promptCommand("debt", "list ponytail:/TODO/FIXME markers, new ones first", () => debtPrompt(dir)))
      editor.add(promptCommand("merge", "bring a /fork-task branch back after review · /merge [branch]", (arg) => {
        const all = forks()
        const pick = all.find((fork) => fork.branch === arg || fork.branch.endsWith(`/${arg}`) || fork.branch === `infiniteoc/fork-${arg}`) ?? (all.length === 1 && !arg ? all[0] : undefined)
        if (!pick) return { toast: all.length ? `Pick one: ${all.map((fork) => fork.branch).join(", ")}` : "No /fork-task branches found." }
        const base = sh(dir, "git", ["branch", "--show-current"]).out
        return [
          `[InfiniteOC /merge] Bring the fork branch ${pick.branch} (worktree ${pick.dir}) into ${base || "the current branch"}.`,
          `Commits to merge:\n${sh(dir, "git", ["log", `HEAD..${pick.branch}`, "--format=%h %s"]).out || "(none)"}`,
          `Uncommitted work in the fork worktree:\n${sh(pick.dir, "git", ["status", "--short"]).out || "(clean)"}`,
          `Diffstat:\n${sh(dir, "git", ["diff", `HEAD...${pick.branch}`, "--stat"]).out || "(none)"}`,
          "Review the fork's diff first and report anything wrong. If the fork has uncommitted work, stop and tell the user to commit it there. Otherwise run `git merge --no-ff` for that branch (it asks the user for approval). On conflicts follow the /resolve procedure. Do not delete the branch or the worktree; tell the user the commands (git worktree remove, git branch -d) and let them decide.",
        ].join("\n\n")
      }))
      editor.add({
        name: "squash",
        description: "collapse the auto-commit branch's turns into one commit",
        execute: (input) => {
          const result = squashAuto(dir, autoBranch(input.sessionID), input.prompt.text)
          return toast(result.text, result.ok ? "success" : "warning", "/squash")
        },
      })
      editor.add({
        name: "issue",
        description: "fetch a GitHub issue with gh, create a branch and start a /goal on it · /issue <number>",
        execute: (input) =>
          Effect.suspend(() => {
            const number = /^#?(\d+)$/.exec(input.prompt.text.trim())?.[1]
            if (!number) return toast("Usage: /issue 123", "info", "/issue")
            const issue = sh(dir, "gh", ["issue", "view", number, "--json", "number,title,body,labels,url"])
            if (!issue.ok) return toast(`gh could not read issue ${number}: ${issue.out.slice(0, 200)}`, "error", "/issue failed")
            const data = JSON.parse(issue.out) as { title: string; body: string; url: string; labels: Array<{ name: string }> }
            const branch = `issue-${number}-${slug(data.title, 30)}`
            const switched = sh(dir, "git", ["switch", "-c", branch])
            const moved = switched.ok || sh(dir, "git", ["switch", branch]).ok
            if (!moved) return toast(`Could not switch to ${branch}: ${switched.out.slice(0, 200)}`, "error", "/issue failed")
            const goal = `Resolve GitHub issue #${number}: ${data.title}\n${data.url}${data.labels.length ? `\nLabels: ${data.labels.map((label) => label.name).join(", ")}` : ""}\n\nIssue text:\n${data.body.slice(0, 6000)}\n\nWork on branch ${branch}. Done means the issue's behavior is implemented, tested and verified. Commit in the repository's style; do not push or open a PR.`
            return toast(`On branch ${branch}`, "success", `/issue ${number}`).pipe(
              Effect.andThen(ctx.session.prompt({ ...(input.prompt as any), sessionID: input.sessionID, text: startText(goal), delivery: input.delivery })),
              Effect.asVoid,
            )
          }).pipe(Effect.catchCause((cause) => toast(String(cause).slice(0, 300), "error", "/issue failed"))),
      })
      editor.add({
        name: "fork-task",
        description: "work on a task in a new git worktree and session · /fork-task <task>, /merge to bring it back",
        execute: (input) =>
          Effect.gen(function* () {
            const task = input.prompt.text.trim()
            if (!task) return yield* toast("Usage: /fork-task <what to do in the fork>", "info", "/fork-task")
            const name = `fork-${slug(task, 24)}-${Date.now().toString(36).slice(-4)}`
            const info = yield* ctx.worktree.create({ projectID: ctx.location.project.id, from: ctx.location.project.directory as any, name, branch: `infiniteoc/${name}` } as any)
            const created = yield* ctx.session.create({ title: `fork: ${task.slice(0, 50)}`, location: { directory: (info as { directory: string }).directory as any } })
            yield* ctx.session.prompt({ sessionID: created.id, text: `${task}\n\n[InfiniteOC fork] You are in a separate git worktree on branch infiniteoc/${name}, branched from the main checkout. Commit your work here in the repository's style; never push. The user brings it back with /merge after review.`, delivery: input.delivery })
            yield* bus.publish(TuiEvent.SessionSelect, { sessionID: created.id })
            yield* toast(`Started in ${(info as { directory: string }).directory}\nBranch infiniteoc/${name}. Use /merge when it is ready.`, "success", "/fork-task")
          }).pipe(Effect.catchCause((cause) => toast(String(cause).slice(0, 300), "error", "/fork-task failed"))),
      })
      editor.add({
        name: "rewind",
        description: "list this session's turns, /rewind <n> restores files and conversation to before turn n (/redo undoes it)",
        execute: (input) =>
          Effect.gen(function* () {
            const turns = userTurns(yield* ctx.session.context({ sessionID: input.sessionID }))
            const arg = input.prompt.text.trim()
            if (turns.length === 0) return yield* toast("No turns to rewind.", "info", "/rewind")
            if (!/^\d+$/.test(arg)) return yield* toast(`${turns.slice(0, 9).map((turn, index) => `${index + 1}  ${turn.text}`).join("\n")}\n\n/rewind <n> goes back to before that turn`, "info", "/rewind")
            const target = turns[Number(arg) - 1]
            if (!target) return yield* toast(`Only ${turns.length} turns. Pick 1-${turns.length}.`, "warning", "/rewind")
            yield* sessions.revert.stage({ sessionID: input.sessionID, messageID: target.id as SessionMessage.ID, files: true })
            yield* toast(`Back before: ${target.text}\nFiles and conversation restored. /redo undoes this; sending a new prompt makes it permanent.`, "success", "/rewind")
          }).pipe(Effect.catchCause((cause) => toast(`${String(cause).slice(0, 250)}\nStop the running turn first (esc), then retry.`, "error", "/rewind failed"))),
      })
    })

    // Auto-commit: opt-in, one commit per finished turn on infiniteoc/auto/<session>, never the user's branch.
    yield* ctx.session.hook("prompt", (event) => Effect.sync(() => void prompts.set(event.sessionID as string, event.prompt.text)))
    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        if (event.type !== "session.execution.succeeded" || !loadConfig(dir).autoCommit) return Effect.void
        const id = event.data.sessionID as string
        const subject = (prompts.get(id) ?? "turn").split("\n")[0].slice(0, 72)
        const result = autoCommit(dir, autoBranch(id), `${AUTO}${subject}\n\nsession ${id}`)
        if (result.error) return toast(`Auto-commit failed: ${result.error.slice(0, 200)}`, "warning", "Auto-commit")
        return result.commit ? toast(`${result.commit.slice(0, 8)} on ${autoBranch(id)}`, "info", "Auto-commit") : Effect.void
      }),
      Effect.catchCause((cause) => Effect.logWarning("InfiniteOC auto-commit failed", { cause })),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
