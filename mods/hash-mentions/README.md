# hash-mentions — `#` completes files, `@` completes skills and agents

Typing `#` in the prompt opens the reference popup filtered to file search
only; `@` opens it filtered to skills, reference aliases and agents only.
The nearest trigger before the cursor wins, so `@skill #file` mixes in one
prompt. Inserted mentions keep their typed prefix (`#path`, `@skill-id`):
mention realignment is text-based and prefix-agnostic, and `@https://` URL
attaches are untouched.

Rules, mirroring the upstream `@` trigger:

- The trigger fires only at the start of the prompt or after whitespace, with
  no whitespace in the query. `# ` (markdown heading) and `path#12`
  (line-range suffix inside an existing mention) never trigger.
- Programmatic file mentions (`editor.onMention`) keep the upstream `@`
  prefix; only typed `#` produces `#` mentions.

The popup's trigger character is read back from the prompt text at the stored
index on every use (nothing is stored), so editing the trigger character
while the popup is open stays correct. Reference mode never lists slash
commands, even with the trigger at position 0. No other commands, tools,
permissions, provider code or session behavior are touched: nine `patchExact`
edits in `packages/tui/src/component/prompt/autocomplete.tsx` and one new
`hashTriggerIndex` in `packages/tui/src/prompt/display.ts` that mirrors
`mentionTriggerIndex` exactly apart from the character.

Speed: the network-backed file search fires 150 ms after the last keystroke
(empty query fires immediately); skills, agents and alias matching stay
instant. This removes the per-keystroke `file.find` roundtrip storm that made
the popup feel laggy. Nothing about ranking, limits, or results changed.

Tests, from the checkout root:

```sh
node --test mods/hash-mentions/test.mjs
node bin/infiniteoc.mjs feature check hash-mentions
```

Enable with `node bin/infiniteoc.mjs feature enable hash-mentions`, then
rebuild and restart; rollback with `feature disable hash-mentions`.
