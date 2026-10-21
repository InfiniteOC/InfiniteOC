# path-repair — survive file text leaked into a path argument

Some models (seen with `opencode/beam-free`) emit a write call whose `path` is the
real path, then `">`, then the whole file body, while `content` also carries
that body. Upstream then fails the write (`Unable to write …`) or, when the
leaked text contains slashes, creates nested junk directories named after the
HTML. In one measured run this cost about half the output tokens and half the
wall time, plus cleanup steps.

- `packages/core/src/tool/path-guard.ts` (new): `repairLeakedPath` and `pathProblem`.
- `plugin/tool-input-repair.ts`: after the existing schema repairs, a `path` of
  the form `file">` + text is repaired (`">` never belongs in a real path):
  - an edit whose `oldString` equals `newString` (it could never apply) had its
    arguments shifted left, so the leaked text becomes `oldString`;
  - when another argument repeats the leaked text (either may be cut short), the
    arguments are kept as sent;
  - otherwise, for a write, the leaked text becomes `content` (in observed runs
    it was the intended body while `content` held unrelated text).
  Anything else is left for the tool to refuse. This runs in `execute.before`, so
  permission prompts, diffs and the external-directory check see the repaired
  call, and a wrong guess at an edit only fails with "oldString not found".
  A leak that starts with an argument's own name (`oldString">`) has that marker
  stripped; one with several markers packs more than one value into the call and
  is left for the tool to refuse. Replaying all 99 leaked write/edit calls from 27
  beam-free runs: 97 land on the right file with the intended text, 2 packed calls
  are refused, none is repaired wrongly.
- Several tool calls packed into one: the provider sometimes hands over one call
  whose text holds the first file, the model's own notes, and then its raw chat
  stream with the next calls (`<|end|><|start|>assistant to=write … <rfl:parameter
  name="path">…`). Written as is, the junk went into the first file. In one eval
  run the page rendered it as wide elements and the model spent about 20 steps
  debugging. When any argument holds both `<|end|><|start|>` and
  `<rfl:parameter name=`, the call is never repaired, and the tool refuses it
  and asks for one call per file. Either marker alone is ordinary text. Over
  136 leaked calls from all eval runs, this refuses 12 that were written as junk
  before, and changes no other call.
- A write whose `content` ends like a shell heredoc (`EOF` or `X_EOF`, then at
  most one `echo …` line) loses that tail: the model wrote the file as if
  through `cat <<'EOF'`, and the tail made it unparseable. This does not apply
  to shell scripts or to files that open that heredoc themselves. Over 374
  write/edit calls from all eval runs, it strips exactly the 8 that ended this
  way.
- `tool/plugin/write.ts`, `edit.ts`, `patch.ts`: packed calls (see above), and
  any remaining path with a line break, markup or a name over 255 bytes, are
  refused before `access.resolve` with a short model-facing message that says
  how to retry. Nothing is written. The message never suggests the shell, which
  would bypass the edit gates.

No permission, approval or message text of the existing tools changes.
