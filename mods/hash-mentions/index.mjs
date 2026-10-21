const tui = "packages/tui/src"

// Hash-prefixed file mentions: "#" completes files, "@" completes skills and
// agents. The trigger character is read back from the prompt text at the
// popup's stored index (hide() only deletes text in command mode), so no
// popup state changes are needed and edited triggers stay correct.
// realignPromptMentions is text-based and prefix-agnostic, so "#file"
// mentions realign like "@file" ones. "@https://" URL attaches are untouched.
export const patches = [
  [`${tui}/prompt/display.ts`, `export function mentionTriggerIndex(text: string, widthMethod: WidthMethod) {
  const index = text.lastIndexOf("@")
  if (index === -1) return

  const before = index === 0 ? undefined : text[index - 1]
  const query = text.slice(index)
  if ((before === undefined || /\\s/.test(before)) && !/\\s/.test(query)) {
    return measureEditText(text.slice(0, index), { widthMethod })
  }
}`, `export function mentionTriggerIndex(text: string, widthMethod: WidthMethod) {
  const index = text.lastIndexOf("@")
  if (index === -1) return

  const before = index === 0 ? undefined : text[index - 1]
  const query = text.slice(index)
  if ((before === undefined || /\\s/.test(before)) && !/\\s/.test(query)) {
    return measureEditText(text.slice(0, index), { widthMethod })
  }
}

export function hashTriggerIndex(text: string, widthMethod: WidthMethod) {
  const index = text.lastIndexOf("#")
  if (index === -1) return

  const before = index === 0 ? undefined : text[index - 1]
  const query = text.slice(index)
  if ((before === undefined || /\\s/.test(before)) && !/\\s/.test(query)) {
    return measureEditText(text.slice(0, index), { widthMethod })
  }
}`],
  [`${tui}/component/prompt/autocomplete.tsx`, `import { mentionTriggerIndex, slashTriggerIndex } from "../../prompt/display"`, `import { hashTriggerIndex, mentionTriggerIndex, slashTriggerIndex } from "../../prompt/display"`],
  // The trigger character at the popup's stored editor offset, read from the input itself.
  [`${tui}/component/prompt/autocomplete.tsx`, `  const renderer = useRenderer()
`, `  const renderer = useRenderer()
  const triggerAt = () => props.input().getTextRange(store.index, store.index + 1)
`],
  [`${tui}/component/prompt/autocomplete.tsx`, `  const referenceMatch = createMemo(() => {
    if (store.visible !== "reference") return`, `  const referenceMatch = createMemo(() => {
    if (store.visible !== "reference" || triggerAt() !== "@") return`],
  [`${tui}/component/prompt/autocomplete.tsx`, `    const fileOptions: AutocompleteOption[] = store.visible === "reference" ? fileSearch.options : []
    const nonFileOptions: AutocompleteOption[] =
      store.visible === "reference"
        ? [...skillOptions(), ...referenceAliasesValue, ...agentsValue]
        : store.index === 0
          ? [...commandsValue]
          : []`, `    const triggerChar = store.visible === "reference" ? triggerAt() : undefined
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
  [`${tui}/component/prompt/autocomplete.tsx`, `    const needsSpace = input.getTextRange(currentCursorOffset, currentCursorOffset + 1) !== " "
    const prefix = "@"`, `    const needsSpace = input.getTextRange(currentCursorOffset, currentCursorOffset + 1) !== " "
    const prefix = triggerAt() === "#" ? "#" : "@"`],
  [`${tui}/component/prompt/autocomplete.tsx`, `    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    input.insertText("@" + selectedPath + "/")`, `    const expandPrefix = triggerAt() === "#" ? "#" : "@"
    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    input.insertText(expandPrefix + selectedPath + "/")`],
  [`${tui}/component/prompt/autocomplete.tsx`, `        // Check for "@" trigger - find the nearest "@" before cursor with no whitespace between
        const idx = mentionTriggerIndex(beforeCursor, renderer.widthMethod)
        if (idx !== undefined) {
          show("reference")
          setStore("index", idx)
        }`, `        // "@" completes skills and agents, "#" completes files - the nearest trigger wins
        const at = mentionTriggerIndex(beforeCursor, renderer.widthMethod)
        const hash = hashTriggerIndex(beforeCursor, renderer.widthMethod)
        const idx = at !== undefined && hash !== undefined ? Math.max(at, hash) : (at ?? hash)
        if (idx !== undefined) {
          show("reference")
          setStore("index", idx)
        }`],
  [`${tui}/component/prompt/autocomplete.tsx`, `    return "No matching files, agents, or references"`, `    return triggerAt() === "#"
      ? "No matching files"
      : "No matching skills, agents, or references"`],
  [`${tui}/component/prompt/autocomplete.tsx`, `  const [search, setSearch] = createSignal("")
  createEffect(() => {
    const next = filter()
    setSearch(next ? next : "")
  })`, `  const [search, setSearch] = createSignal("")
  createEffect(() => {
    const next = filter()
    setSearch(next ? next : "")
  })
  // Debounce only the network-backed file search: without this every keystroke
  // fires a full file.find roundtrip and re-renders the popup. Local filtering
  // (skills, agents, aliases) keeps using search() and stays instant.
  const [debouncedSearch, setDebouncedSearch] = createSignal("")
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const next = search()
    if (searchTimer) clearTimeout(searchTimer)
    if (!next) {
      setDebouncedSearch(next)
      return
    }
    searchTimer = setTimeout(() => setDebouncedSearch(next), 150)
  })
  onCleanup(() => {
    if (searchTimer) clearTimeout(searchTimer)
  })`],
  [`${tui}/component/prompt/autocomplete.tsx`, `  const [files] = createResource(
    () => ({ query: search(), location: location.current, visible: store.visible }),`, `  const [files] = createResource(
    () => ({ query: debouncedSearch(), location: location.current, visible: store.visible }),`],
]

export default {
  id: "hash-mentions",
  version: "1.2.0",
  async setup(api) {
    for (const [path, before, after] of patches) await api.patchExact(path, before, after)
  },
}
