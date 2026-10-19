const tui = "packages/tui/src"

// Transcript rows are separated by a single blank line (each row's own
// margin). Two blocks carried one line of vertical padding on top of that, so
// their gap to the neighbouring rows was one line taller:
//   - tool blocks (shell, write, edit, apply_patch, question)
//   - the user prompt bubble
// Dropping the padding leaves the row margin as the only separation, so every
// row pair spaces identically. The rare notices (reverted messages, compaction,
// queued-prompt dock, images) keep their padding by design.
export const patches = [
  [`${tui}/routes/session/index.tsx`, `      border={["left"]}
      flexShrink={0}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      gap={1}`, `      border={["left"]}
      flexShrink={0}
      paddingLeft={2}
      gap={1}`],
  [`${tui}/routes/session/index.tsx`, `          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          backgroundColor={hover() ? theme.decrease(theme.background.raised.base) : theme.background.raised.base}
          flexShrink={0}`, `          paddingLeft={2}
          backgroundColor={hover() ? theme.decrease(theme.background.raised.base) : theme.background.raised.base}
          flexShrink={0}`],
]

export default {
  id: "tool-spacing",
  version: "1.1.0",
  async setup(api) {
    for (const [path, before, after] of patches) await api.patchExact(path, before, after)
  },
}
