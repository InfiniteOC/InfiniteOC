# safe-guard

Safety gates and git workflow commands, written as two core plugins
(`infiniteoc-safety.ts`, `infiniteoc-gitflow.ts`) and registered in `internal.ts`.
Nothing here weakens a permission rule: the permission hook only turns `allow` into
`ask`, a rule that denies never reaches it, and the optional allow list only turns
`ask` into `allow` for commands you list and that are not on the always-ask list.

## Settings

The `safety` key of the InfiniteOC settings file (`INFINITEOC_SETTINGS_FILE`, default
`~/.config/infiniteoc/settings.json`), read on every use so edits apply without a restart:

```json
{
  "safety": {
    "protectedPaths": [".env*", "*.lock", "package-lock.json", "bun.lockb", "go.sum", "migrations/"],
    "allow": ["npm test*", "git status*"],
    "ask": ["make deploy*"],
    "secretScan": true,
    "diffBudget": { "files": 15, "lines": 500 },
    "autoCommit": false,
    "commitCheck": true,
    "hooks": { "before-edit": ["./scripts/guard.sh"], "after-edit": [], "prompt-submit": [], "session-end": [] },
    "projects": { "/abs/path/to/project": { "allow": ["make check"] } }
  }
}
```

A project may add `.infiniteoc/safety.json` with `protectedPaths` and `ask` only. A checked-in
file can tighten the rules, never grant commands or run hooks. `allow`, `hooks`,
`autoCommit` and the budget are read from your settings only (per project through `projects`).

## Gates

- Protected paths: an edit, write or patch of a matching path (`dir/` anywhere, `*.ext`, a file
  name, or a path glob) always asks, even when edits are normally allowed or "always" was
  answered earlier. A shell command that redirects into, `tee`s, `rm`s, `mv`s or `sed -i`s such a
  path asks too.
- Always-ask commands: recursive `rm`, any `git push`, `git reset --hard`, `git clean`,
  `git checkout .`, force branch delete, `rebase`, `merge`, `--amend`, destructive SQL, `sudo`,
  `dd of=`, `chmod -R`, `curl | sh`, `gh pr/issue/release` writes, `npm publish`, `kubectl delete`,
  plus your `ask` globs. Each command of a chain is checked separately.
- Both gates set their message on every request they cover, including requests that were already
  `ask`. The TUI's auto-approve (`--auto`, `/yolo`) uses that message to leave the request to you.
- Allow list: globs like permission rules (`npm test*`). Every command in a chain must match.
- Secret scan: a write, edit or patch whose new text has a private key block, an AWS, GitHub,
  Slack, Google, Stripe, Anthropic or OpenAI key, or a long quoted `secret/token/password =`
  value is refused when the target file is not git-ignored. Placeholders (`example`, `your_`,
  `${...}`, `process.env`) pass; put `infiniteoc:allow-secret` on a line to allow a fixture.
- Commit conventions: when 60% of the last 30 commit subjects follow Conventional Commits, a
  `git commit` whose subject does not is refused with the recent subjects as examples. The
  agent guidance also tells it to read `git log` before committing.
- Diff budget: after a turn's edits pass the file or line budget, the next tool result gets a
  note telling the agent to stop widening the change unless you asked for that much, and a toast
  warns you. Once per turn. Lines of newly created files count toward the file limit only, so a
  new project is not stopped by its first large file. `0` disables a limit.
- User hooks: shell commands run with the event JSON on stdin (`event`, `sessionID`, `tool`,
  `files`, `input`/`prompt`). `before-edit` blocks the edit on a non-zero exit and the hook's
  output is shown to the agent. `after-edit`, `prompt-submit` (cannot block) and `session-end`
  (when an agent run finishes) are informational. 30 second timeout each.

## Commands

| Command | What it does |
| --- | --- |
| `/readonly [on\|off\|status]` | Refuses every edit, write, patch, editing subagent and shell command that is not clearly read-only (best effort parse; unclear means refused). Persists across restarts. |
| `/rewind` | Lists this session's turns. `/rewind <n>` restores files and conversation to before turn n through upstream's snapshot revert (the same mechanism as `/undo`, which only goes one turn back); `/redo` undoes it. |
| `/squash [message]` | Collapses the auto-commit branch's turns into one commit; the old tip is kept under `refs/infiniteoc/backup/`. |
| `/fork-task <task>` | New git worktree (branch `infiniteoc/fork-...`) and a new session rooted there that starts on the task; selects it. |
| `/merge [branch]` | The agent reviews a fork branch's diff and merges it (the merge asks first); never deletes the branch or worktree. |
| `/pr` | The agent commits in repo style, drafts the PR title and body from the session and diff, shows them, then `git push` and `gh pr create` (both ask). |
| `/issue <n>` | `gh issue view`, `git switch -c issue-n-slug`, then a `/goal` on it. |
| `/changelog [since]` | Draft grouped from commits since the last tag (or `since`), polished by the agent. |
| `/resolve` | Walks merge conflicts hunk by hunk with an explanation; does not `git add` or continue. |
| `/blame-why file:line` | `git blame` plus `git log -L` for that line, explained. |
| `/split` | Plans and creates a stack of small commits from the working tree changes. |
| `/debt` | Lists `ponytail:`, `TODO`, `FIXME`, `HACK`, `XXX` (tracked and untracked files), new ones since HEAD first. |

`/review` already exists upstream (reviews uncommitted changes, a commit, a branch or a PR number
through `gh pr view` and `gh pr diff`); `gh pr review/comment` are on the always-ask list, so it
cannot post without your approval.

## Snapshots and auto-commit

Upstream already snapshots the tree for each turn in a separate git directory under the data
directory (never your repository), which is what `/undo`, `/redo` and `/rewind` restore.

`autoCommit: true` additionally commits the working tree after each finished turn to
`infiniteoc/auto/<session>` using a temporary index, so your branch, index, stash and working
tree are never touched. `/squash` collapses it; bring the result in with `git merge --squash`.

## Caveats

- `/readonly` cannot see inside MCP tools; it blocks the built-in editing tools, editing
  subagents and unclear shell commands.
- `/fork-task` branches from HEAD; uncommitted changes in the main checkout are not copied.
- `/issue` and `/pr` need an authenticated `gh`.
