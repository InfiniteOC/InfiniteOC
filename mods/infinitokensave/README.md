# infinitokensave

Token savings that lose nothing. Two parts:

**Request rewriting** (lossless, cache-stable). Each request's tool outputs are rewritten as a pure
function of their own text (and, for duplicates, of earlier outputs), so consecutive requests share
their prefix and the prompt cache keeps working:

- command output reads the way the terminal showed it: ANSI color and cursor codes are removed and
  progress lines redrawn with `\r` keep their final state;
- a run of identical lines becomes the line once and `[same line N more times]` (only where that is
  shorter);
- an output identical to an earlier one (400+ characters) becomes a reference to that tool call.

File-content tools (read, edit, write, patch) keep their exact text: edits copy it byte for byte.
Errors, images and structured results are never touched. The stored history is unchanged.

**Guidance** (`[InfiniTokenSave]`, build and general agents): the cheapest token is the one a tool
never printed. Search before reading, read ranges, do not re-read unchanged files, bound command
output (quiet flags, `| tail`, `git diff --stat` first), skip lockfiles and generated files, and never
trade correctness for brevity. Constant text, so it costs nothing in cache terms.

Measured on the stored sessions, the rewriting removes 1.6% of tool-output characters: lossless
rewriting after the fact has little to work with. The large savings are elsewhere and need no loss
either: tool output the agent does not request (the guidance), old output paged out of the request
(mods/infiniteoctx, ~21%), and thinking spent where it changes the outcome (mods/infinithink and the
`auto` effort in mods/effort).

```sh
node --test mods/infinitokensave/test.mjs
node bin/infiniteoc.mjs feature check infinitokensave
```

Rollback: `node bin/infiniteoc.mjs feature disable infinitokensave`, restart.
