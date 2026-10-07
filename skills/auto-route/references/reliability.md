# Reliable incremental software work

Use for behavioral changes, defects, integrations, and regression risk. This is a
working loop, not a requirement to write a long plan or load every named skill.
Project instructions, actual permissions, and the user's scope still govern.

## 1. Establish the baseline and scope

- Inspect the relevant project instructions, entry points, package scripts,
  dependencies, existing tests, and current diff. Do not assume the stack from a
  screenshot. If there is no Git repository, record the touched files and use
  targeted backups; never initialize or reset a repository just for this workflow.
- Identify one requested behavior, observable acceptance checks, and explicit
  non-goals. Choose a small vertical slice that can actually be exercised.
- List a few existing behaviors that must keep working. Inspect callers of shared
  components, state, CSS, config, data formats, and APIs before changing contracts.
  Preserve established visuals unless the user requested a redesign.
- Run the relevant baseline checks before editing. Classify failures as
  pre-existing, introduced, or uncertain. Unrelated pre-existing failures are not
  permission for a cleanup spree; block only dependent work and report the rest.
- Treat public interfaces, migrations, authentication/permissions, persistent data,
  shared state, and external services as higher risk. Check compatibility, error
  handling, and rollback/recovery without touching production or private data.

## 2. Define proof before implementation

- The oracle is a user-observable outcome, not the implementation's own claim.
  A successful fetch, mounted view, page counter, or screenshot file existing is
  insufficient proof that a book is readable.
- Add the smallest useful regression test or reproducible check. For a bug,
  demonstrate failure for the right reason, then success after the fix. Use a
  disposable copy if replaying the old code would disturb user work.
- Use existing test tools and project conventions. Prefer deterministic fixtures
  for repeatable tests. Separately exercise a real integration when authorized;
  mocked success does not establish remote compatibility or current availability.
- Do not make live requests that incur cost, send private data, or mutate external
  systems merely to satisfy a testing checklist. Report those checks as blocked
  if authorization or a safe environment is missing.

## 3. Implement with a limited blast radius

- One coherent change at a time. Read actual types and installed APIs; consult
  authoritative documentation for uncertain version-specific behavior.
- Prefer existing abstractions. Add a boundary when repeated coupling justifies
  it, not a speculative framework. Separate functional fixes from optional visual
  polish so that regressions are easier to locate.
- Preserve user edits and unrelated behavior. Do not use broad file rewrites,
  global CSS changes, new dependencies, or catch-all error suppression as shortcuts.
- On asynchronous features, test relevant races: switching items before a load
  finishes, stale responses, duplicate listeners, unmounted views, and cleanup.
  An older request must not overwrite the newest selection.
- Parallel workers need distinct ownership and a shared interface agreement.
  Integrate their results, then run combined checks; independent passes are not
  evidence the combined application works.

## 4. Failure changes the route

Pause dependent feature work and use `systematic-debugging`. Record the exact
reproduction, expected versus actual result, and the first failing boundary.
Distinguish observations from hypotheses; a screenshot cannot prove a root cause.

For the reader example, inspect:

    selection -> request -> response type/body -> parsing -> render -> visible content

Collect safe browser errors, failed requests, document/worker versions, layout
dimensions, and completion/error state where relevant. Do not log tokens, headers,
private documents, or whole configuration files. Test one hypothesis with the
smallest discriminating change. Keep errors visible and useful.

After **two unsuccessful fix hypotheses**, stop speculative edits. Re-read the
evidence, reduce to a minimal reproduction, inspect a known-working example,
verify uncertain APIs, or use an independent read-only reviewer. Continue with
new evidence, not a third variation of the same guess. If still blocked, record
the blocker and the next diagnostic step; do not claim a repair or weaken tests.
Undo only your own ineffective changes and only when that will not remove user work.

## 5. Verify behavior, not a convincing shell

- Run targeted tests, relevant integration checks, and the project's applicable
  type/lint/build checks. Run broader regression checks when shared code changed.
- Use actual browser interaction for web changes, a terminal/PTY for TUI, real
  invocations for CLI, and callers/contracts for a library. Check capabilities
  before relying on a skill; file presence does not establish a running browser.
- For web UI, exercise the primary journey with real content and relevant
  loading/empty/error paths. Check keyboard and responsive behavior proportionate
  to the change. Inspect screenshots for visual claims and console/network errors
  for functional ones. Neither alone proves everything.
- Wait for observable application readiness with a timeout, not a guessed sleep
  or an unconditional network-idle requirement that can hang on streaming apps.
- For canvas/PDF rendering, inspect rendered output and the rendering result;
  asserting the canvas exists or has a size cannot detect a blank page. Include a
  known nonblank fixture and inspect a page containing recognizable content.
- Revisit existing flows after the addition. For a reader: library/search, open
  known book and read content, next/previous page changes content, relevant
  zoom/font controls, return to library, and understandable failed-download state.
- If credentials, services, or a browser are unavailable, run what is safe and
  mark the missing check **blocked/unverified**, not passed. Do not install a new
  framework or launch paid probes just to avoid admitting the limitation.

## 6. Complete only with fresh evidence

Use `verification-before-completion`. Review the final diff for accidental scope
expansion, debug leftovers, secrets, and weakened tests. For risky boundaries use
independent review when useful; a review is not a substitute for execution.

Tie results to commands/interactions, working directory, and the final artifact
revision or relevant file hashes. An affected edit invalidates earlier evidence;
re-run those checks. Separate **passed**, **failed**, **blocked**, and **not run**.
Never change a requirement or expected result solely to turn a test green.

Report the requested outcome, what actually ran, and remaining limits. A build
pass, a helper's recommendation, a worker's claim, and published code are not
runtime proof. Do not auto-commit, publish, switch models, or restart the user's
agent under the guise of verification. Use a safe task checkpoint when authorized
and keep a concise state note for longer work, not for every trivial edit.