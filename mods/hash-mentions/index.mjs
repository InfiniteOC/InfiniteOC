const tui = "packages/tui/src"

// Hash-prefixed file mentions: "#" completes files, "@" completes skills and
// agents. The trigger character is read back from the prompt text at the
// popup's stored index (hide() only deletes text in command mode), so no
// popup state changes are needed and edited triggers stay correct.
// realignPromptMentions is text-based and prefix-agnostic, so "#file"
// mentions realign like "@file" ones. "@https://" URL attaches are untouched.
export const patches = [
  [`${tui}/prompt/display.ts`, `export function mentionTriggerIndex(value: string, offset = promptOffsetWidth(value)) {
  const text = displaySlice(value, 0, offset)
  const index = text.lastIndexOf("@")
  if (index === -1) return

  const before = index === 0 ? undefined : text[index - 1]
  const query = text.slice(index)
  if ((before === undefined || /\\s/.test(before)) && !/\\s/.test(query)) {
    return promptOffsetWidth(text.slice(0, index))
  }
}`, `export function mentionTriggerIndex(value: string, offset = promptOffsetWidth(value)) {
  const text = displaySlice(value, 0, offset)
  const index = text.lastIndexOf("@")
  if (index === -1) return

  const before = index === 0 ? undefined : text[index - 1]
  const query = text.slice(index)
  if ((before === undefined || /\\s/.test(before)) && !/\\s/.test(query)) {
    return promptOffsetWidth(text.slice(0, index))
  }
}

export function hashTriggerIndex(value: string, offset = promptOffsetWidth(value)) {
  const text = displaySlice(value, 0, offset)
  const index = text.lastIndexOf("#")
  if (index === -1) return

  const before = index === 0 ? undefined : text[index - 1]
  const query = text.slice(index)
  if ((before === undefined || /\\s/.test(before)) && !/\\s/.test(query)) {
    return promptOffsetWidth(text.slice(0, index))
  }
}`],
  [`${tui}/component/prompt/autocomplete.tsx`, `import { displayCharAt, mentionTriggerIndex, slashTriggerIndex } from "../../prompt/display"`, `import { displayCharAt, hashTriggerIndex, mentionTriggerIndex, slashTriggerIndex } from "../../prompt/display"`],
  [`${tui}/component/prompt/autocomplete.tsx`, `  const referenceMatch = createMemo(() => {
    if (store.visible !== "reference") return`, `  const referenceMatch = createMemo(() => {
    if (store.visible !== "reference" || displayCharAt(props.value, store.index) !== "@") return`],
  [`${tui}/component/prompt/autocomplete.tsx`, `    const fileOptions: AutocompleteOption[] = store.visible === "reference" ? fileSearch.options : []
    const nonFileOptions: AutocompleteOption[] =
      store.visible === "reference"
        ? [...skillOptions(), ...referenceAliasesValue, ...agentsValue]
        : store.index === 0
          ? [...commandsValue]
          : []`, `    const triggerChar = displayCharAt(props.value, store.index)
    const filesOnly = store.visible === "reference" && triggerChar === "#"
    const skillsOnly = store.visible === "reference" && triggerChar !== "#"
    const fileOptions: AutocompleteOption[] = filesOnly ? fileSearch.options : []
    const nonFileOptions: AutocompleteOption[] =
      skillsOnly
        ? [...skillOptions(), ...referenceAliasesValue, ...agentsValue]
        : store.visible === "reference"
          ? []
          : store.index === 0
            ? [...commandsValue]
            : []`],
  [`${tui}/component/prompt/autocomplete.tsx`, `    const charAfterCursor = displayCharAt(props.value, currentCursorOffset)
    const needsSpace = charAfterCursor !== " "
    const prefix = "@"`, `    const charAfterCursor = displayCharAt(props.value, currentCursorOffset)
    const needsSpace = charAfterCursor !== " "
    const prefix = displayCharAt(props.value, store.index) === "#" ? "#" : "@"`],
  [`${tui}/component/prompt/autocomplete.tsx`, `    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    input.insertText("@" + selectedPath + "/")`, `    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    const expandPrefix = displayCharAt(props.value, store.index) === "#" ? "#" : "@"
    input.insertText(expandPrefix + selectedPath + "/")`],
  [`${tui}/component/prompt/autocomplete.tsx`, `        // Check for "@" trigger - find the nearest "@" before cursor with no whitespace between
        const idx = mentionTriggerIndex(value, offset)
        if (idx !== undefined) {
          show("reference")
          setStore("index", idx)
        }`, `        // "@" completes skills and agents, "#" completes files - the nearest trigger wins
        const at = mentionTriggerIndex(value, offset)
        const hash = hashTriggerIndex(value, offset)
        const idx = at !== undefined && hash !== undefined ? Math.max(at, hash) : (at ?? hash)
        if (idx !== undefined) {
          show("reference")
          setStore("index", idx)
        }`],
  [`${tui}/component/prompt/autocomplete.tsx`, `    return "No matching files, agents, or references"`, `    return displayCharAt(props.value, store.index) === "#"
      ? "No matching files"
      : "No matching skills, agents, or references"`],
]

export default {
  id: "hash-mentions",
  version: "1.0.0",
  async setup(api) {
    for (const [path, before, after] of patches) await api.patchExact(path, before, after)
  },
}
