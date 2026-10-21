# path-repair — survive file text leaked into a path argument

Some models (seen with `opencode/beam-free`) emit a write call whose `path` is the
real path, then `">`, then the whole file body, while `content` also carries
that body. Upstream then fails the write (`Unable to write …`) or, when the
leaked text contains slashes, creates nested junk directories named after the
HTML. In one measured run this cost about half the output tokens and half the
wall time, plus cleanup steps.

- `packages/core/src/tool/path-guard.ts` (new): `repairLeakedPath` and `pathProblem`.
- `plugin/tool-input-repair.ts`: after the existing schema repairs, strips a
  leaked `">` + body from `path` **only when that body matches another string
  argument** (`content`, `newString`, …). A real path is never rewritten on a
  guess. This runs in `execute.before`, so permission prompts and the
  external-directory check see the repaired path.
- `tool/plugin/write.ts`, `edit.ts`, `patch.ts`: any remaining path with a line
  break, markup or a name over 255 bytes is refused before `access.resolve` with
  a short model-facing message that says how to retry. Nothing is written.

No permission, approval or message text of the existing tools changes.
