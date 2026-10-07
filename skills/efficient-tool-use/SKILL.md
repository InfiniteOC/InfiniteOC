---
name: efficient-tool-use
description: Plan and execute coding-agent commands, reads, searches, edits, verification, and subagent work efficiently. Use for tool-heavy tasks, command-efficiency requests, parallel execution, reducing redundant reads, controlling long-running processes, and avoiding wasted context or unsafe concurrency.
---

# Efficient tool use

Use the shortest reliable inspect/change/check loop. Tools serve the requested outcome; maximizing tool calls, parallel workers, or ceremony is not the goal. Do not use tools for a simple conversational answer with no verification need.

## Each tool round

1. Identify the next decision and the evidence needed. Search filenames/symbols before dumping files. Read targeted ranges and related files together. Re-read only changed content or a genuinely missing dependency.
2. Batch all independent operations whose inputs are known. Use actual batch or parallel facilities, not prose saying work is parallel. Separate dependencies: inspect before editing, finish edits before validating their output.
3. Prefer the dedicated read/search/edit tools when they fit. Use non-interactive shell commands with explicit working directories, quoted paths, exit-status checks, and bounded output. Never interpolate untrusted text as executable shell syntax. Preserve original output when diagnosis needs it.
4. Run edits in parallel only with non-overlapping ownership and no shared state. Do not race builds, dependency installs, generated files, migrations, caches, ports, lockfiles, or services. A single command block is not proof of concurrency.
5. Validate proportionately: reproduce the affected behavior, add a regression test where useful, and run focused checks before broad suites. Do not rerun successful unchanged checks without a reason.

## Processes and delegation

- Background long-running work only when tools permit it. Record its handle/PID and log location. Continue independent work, then wait for completion and inspect exit status. Use a long wait or notification instead of rapid polling. A “started” log is not a successful build.
- Normally use at most two subagents for substantial independent work. Give them a concrete goal, paths/ownership, constraints, and acceptance checks. Keep small tasks local; do not recursively delegate or duplicate investigations.
- Workers return concise evidence, changed files, checks, and blockers. Integrate and verify the combined result yourself.
- After a failure, change the approach based on evidence. Do not repeat the same failing command or scan the entire filesystem blindly. Check prerequisite/tool versions when relevant; prefer installed dependencies over new ones.
- Clean up processes, temporary files, sockets, and listeners you created. Do not stop unrelated services or remove locks without checking their owner.

## Boundaries

Honor planning-only requests and permissions. Efficiency never authorizes destructive operations, credential changes, paid calls, external publication, or shortcuts around approval. Never print secrets to logs. Report a real blocker promptly, with enough evidence to act on it.

Final answer: requested result, meaningful verification, and any required next step. Keep the work thorough and the explanation short. The always-on abbreviated version lives in InfiniteOC's workflow and local AGENTS.md so it does not depend on loading this skill every turn.