# Harness eval: does a change make real runs better?

`infiniteoc bench` compares configurations (model, agent, ponytail) on tiny pass/fail tasks. This kit
compares **two InfiniteOC checkouts** (for example `main` and your branch) on one realistic task with a
real model, and scores what the agent actually shipped.

```bash
git worktree add ../InfiniteOC-main main && (cd ../InfiniteOC-main && node bin/infiniteoc.mjs setup)
node scripts/eval/run.mjs --a ../InfiniteOC-main --b . --model opencode/beam-free --runs 3
```

Each trial gets a fresh git repo, runs the built binary with
`run -m MODEL --format json <task>`, and is then scored three ways:

- `score.mjs`: 22 browser checks for `task-expense-tracker.md`. It finds fields by their labels and buttons by
  their names, so any implementation can be scored. It covers validation, inline errors, focus on the first invalid
  field, totals and filters, edit/delete, CSV quoting, reloads, corrupt and invalid storage, 375 px overflow,
  keyboard access, item-specific row action names, and light and dark contrast (the same built-in audit
  `ui_check` runs).
- The project's own `node --test` suite.
- `stats.mjs`: steps, tokens, tool errors, failed writes, files written through shell heredocs (which skip the
  edit gates), skills loaded, `ui_check` calls and wall time.

Needs Node 22+ and Playwright with Chromium for scoring (`npm i -g playwright && npx playwright install chromium`, or
`PLAYWRIGHT_MODULE`).

## Read the numbers carefully

- **Isolate the agent** (`--user NAME`, Linux, run as root). An agent running as root once ran
  `find / -name "*.test.mjs"`, found the grader and earlier trials, ran the grader against its own app and
  scored 22/22. Without isolation, discard any trial whose log reads files outside its project.
- **Run several trials per side and alternate them** (the runner does). Free models vary a lot from run to
  run, and some failure modes are intermittent. For example, beam-free's leaked-path writes showed up in
  some runs and not in others.
- **More steps is not automatically worse.** With a working `ui_check` the agent spends steps fixing what
  the audit found. Compare score and time together.
