package ui

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/api"
	"infiniteoc/infinitui/internal/theme"
)

// mention is a completion the user inserted; it becomes an attachment on submit.
type mention struct {
	text  string // as it appears in the prompt, e.g. "@src/main.go"
	kind  string // file | agent | skill | reference
	value string // absolute path, agent ID or skill ID
	name  string
}

// Prompt is the message composer.
type Prompt struct {
	ta       textarea.Model
	mentions []mention
	history  []string
	histPos  int // len(history) = editing a fresh draft
	draft    string
	width    int
	pastes   map[string]string // chip -> pasted text
}

func promptKeyMap() textarea.KeyMap {
	k := textarea.DefaultKeyMap()
	k.InsertNewline = key.NewBinding(key.WithKeys("shift+enter", "alt+enter", "ctrl+j"))
	k.LineNext = key.NewBinding(key.WithKeys("down"))
	k.LinePrevious = key.NewBinding(key.WithKeys("up"))
	k.CharacterBackward = key.NewBinding(key.WithKeys("left"))
	k.CharacterForward = key.NewBinding(key.WithKeys("right"))
	k.DeleteCharacterForward = key.NewBinding(key.WithKeys("delete"))
	k.TransposeCharacterBackward = key.NewBinding(key.WithKeys())
	k.Paste = key.NewBinding(key.WithKeys("ctrl+v"))
	return k
}

// NewPrompt creates the composer and loads shared prompt history.
func NewPrompt() *Prompt {
	ta := textarea.New()
	ta.ShowLineNumbers = false
	ta.Prompt = ""
	ta.DynamicHeight = true
	ta.MinHeight = 1
	ta.MaxHeight = 12
	ta.MaxContentHeight = 0
	ta.CharLimit = 0
	ta.KeyMap = promptKeyMap()
	ta.Placeholder = "Ask anything…"
	// The real terminal cursor: native blinking, and the text can be recoloured freely.
	ta.SetVirtualCursor(false)
	p := &Prompt{ta: ta}
	p.styles()
	p.history = loadHistory()
	p.histPos = len(p.history)
	ta.Focus()
	p.ta = ta
	p.ta.Focus()
	return p
}

func (p *Prompt) styles() {
	pal := theme.Current
	st := textarea.DefaultStyles(pal.Dark)
	base := lipgloss.NewStyle()
	st.Focused.Base = base
	st.Focused.Text = base.Foreground(pal.Text)
	st.Focused.CursorLine = base
	st.Focused.Placeholder = base.Foreground(pal.Subtle)
	st.Focused.EndOfBuffer = base
	st.Focused.Selection = base.Background(pal.PanelAlt)
	st.Blurred = st.Focused
	st.Cursor.Color = pal.Primary
	p.ta.SetStyles(st)
}

// SetWidth sizes the input area.
func (p *Prompt) SetWidth(w int) {
	p.width = w
	p.ta.SetWidth(w)
}

// Value is the full text.
func (p *Prompt) Value() string { return p.ta.Value() }

// SetValue replaces the text and puts the cursor at the end.
func (p *Prompt) SetValue(s string) {
	p.ta.SetValue(s)
	p.ta.MoveToEnd()
}

// Reset clears text and mentions.
func (p *Prompt) Reset() {
	p.ta.Reset()
	p.mentions = nil
	p.pastes = nil
	p.histPos = len(p.history)
	p.draft = ""
}

// Height is the number of rows the input uses.
func (p *Prompt) Height() int { return max(1, p.ta.Height()) }

// ShellMode reports a `!command` prompt.
func (p *Prompt) ShellMode() bool { return strings.HasPrefix(p.ta.Value(), "!") }

// Cursor returns the textarea's cursor for positioning the real terminal cursor.
func (p *Prompt) Cursor() *tea.Cursor { return p.ta.Cursor() }

// View renders the input lines with commands, mentions and paste chips coloured.
func (p *Prompt) View() string {
	if p.ta.Value() == "" {
		return p.ta.View()
	}
	lines := strings.Split(p.ta.View(), "\n")
	for i, l := range lines {
		lines[i] = p.colorize(ansi.Strip(l), i == 0)
	}
	return strings.Join(lines, "\n")
}

var chipRe = regexp.MustCompile(`\[pasted #\d+ · \d+ lines\]`)

// colorize paints one visual line of the composer.
func (p *Prompt) colorize(line string, first bool) string {
	pal := theme.Current
	text := lipgloss.NewStyle().Foreground(pal.Text)
	if strings.HasPrefix(p.ta.Value(), "!") {
		return lipgloss.NewStyle().Foreground(pal.Accent).Render(line)
	}
	var b strings.Builder
	rest := line
	for rest != "" {
		if loc := chipRe.FindStringIndex(rest); loc != nil && loc[0] == 0 {
			b.WriteString(lipgloss.NewStyle().Background(pal.PanelAlt).Foreground(pal.Muted).Render(rest[:loc[1]]))
			rest = rest[loc[1]:]
			continue
		}
		i := strings.IndexAny(rest, " \t")
		word, sep := rest, ""
		if i >= 0 {
			word, sep = rest[:i], rest[i:i+1]
			rest = rest[i+1:]
		} else {
			rest = ""
		}
		st := text
		switch {
		case first && b.Len() == 0 && strings.HasPrefix(word, "/") && len(word) > 1:
			st = lipgloss.NewStyle().Foreground(pal.Primary).Bold(true)
		case strings.HasPrefix(word, "@") && len(word) > 1:
			st = lipgloss.NewStyle().Foreground(pal.Accent)
		case strings.HasPrefix(word, "#") && len(word) > 1:
			st = lipgloss.NewStyle().Foreground(pal.Info)
		}
		b.WriteString(st.Render(word))
		b.WriteString(sep)
	}
	return b.String()
}

// SetPlaceholder changes the hint.
func (p *Prompt) SetPlaceholder(s string) { p.ta.Placeholder = s }

// Focus / Blur.
func (p *Prompt) Focus() tea.Cmd { return p.ta.Focus() }
func (p *Prompt) Blur()          { p.ta.Blur() }

// cursorOffset returns the rune offset of the cursor in Value().
func (p *Prompt) cursorOffset() int {
	lines := strings.Split(p.ta.Value(), "\n")
	off := 0
	row := min(p.ta.Line(), len(lines)-1)
	for i := 0; i < row; i++ {
		off += len([]rune(lines[i])) + 1
	}
	return off + min(p.ta.Column(), len([]rune(lines[row])))
}

// setCursorOffset moves the cursor to a rune offset.
func (p *Prompt) setCursorOffset(off int) {
	lines := strings.Split(p.ta.Value(), "\n")
	row, col := 0, off
	for row < len(lines)-1 && col > len([]rune(lines[row])) {
		col -= len([]rune(lines[row])) + 1
		row++
	}
	p.ta.MoveToBegin()
	for i := 0; i < row; i++ {
		p.ta.CursorDown()
	}
	p.ta.SetCursorColumn(col)
}

// BeforeCursor returns the text before the cursor.
func (p *Prompt) BeforeCursor() string {
	r := []rune(p.ta.Value())
	return string(r[:min(len(r), p.cursorOffset())])
}

// ReplaceRange swaps runes [start, cursor) for text and records a mention.
func (p *Prompt) ReplaceRange(start int, text string, m *mention) {
	r := []rune(p.ta.Value())
	end := min(len(r), p.cursorOffset())
	start = max(0, min(start, end))
	nv := string(r[:start]) + text + string(r[end:])
	p.ta.SetValue(nv)
	p.setCursorOffset(start + len([]rune(text)))
	if m != nil {
		p.mentions = append(p.mentions, *m)
	}
}

// Paste inserts text; a big paste becomes a compact chip that expands on send.
func (p *Prompt) Paste(text string) {
	lines := strings.Count(text, "\n") + 1
	if lines < 6 && len(text) < 800 {
		p.ta.InsertString(text)
		return
	}
	if p.pastes == nil {
		p.pastes = map[string]string{}
	}
	chip := fmt.Sprintf("[pasted #%d · %d lines]", len(p.pastes)+1, lines)
	p.pastes[chip] = text
	p.ta.InsertString(chip)
}

// Expand replaces paste chips with their text.
func (p *Prompt) Expand(text string) string {
	for chip, body := range p.pastes {
		text = strings.ReplaceAll(text, chip, body)
	}
	return text
}

// Insert types text at the cursor.
func (p *Prompt) Insert(s string) { p.ta.InsertString(s) }

// OnFirstLine / OnLastLine decide when up/down walk history.
func (p *Prompt) OnFirstLine() bool { return p.ta.Line() == 0 }
func (p *Prompt) OnLastLine() bool  { return p.ta.Line() >= p.ta.LineCount()-1 }

// HistoryPrev / HistoryNext walk submitted prompts.
func (p *Prompt) HistoryPrev() bool {
	if p.histPos == 0 {
		return false
	}
	if p.histPos == len(p.history) {
		p.draft = p.ta.Value()
	}
	p.histPos--
	p.SetValue(p.history[p.histPos])
	return true
}

func (p *Prompt) HistoryNext() bool {
	if p.histPos >= len(p.history) {
		return false
	}
	p.histPos++
	if p.histPos == len(p.history) {
		p.SetValue(p.draft)
	} else {
		p.SetValue(p.history[p.histPos])
	}
	return true
}

// History returns submitted prompts, oldest first.
func (p *Prompt) History() []string { return p.history }

// Update forwards keys to the textarea.
func (p *Prompt) Update(msg tea.Msg) tea.Cmd {
	var cmd tea.Cmd
	p.ta, cmd = p.ta.Update(msg)
	return cmd
}

// Build turns the text and recorded mentions into a prompt body.
// Mention offsets are display-width positions in the text.
func (p *Prompt) Build(text string) api.Prompt {
	out := api.Prompt{Text: text, Delivery: "steer"}
	used := map[int]bool{}
	for _, m := range p.mentions {
		idx := -1
		from := 0
		for {
			i := strings.Index(text[from:], m.text)
			if i < 0 {
				break
			}
			i += from
			end := i + len(m.text)
			// Whole token only, first unused occurrence.
			if !used[i] && (end == len(text) || strings.ContainsRune(" \n\t,.;:)", rune(text[end]))) {
				idx = i
				break
			}
			from = i + 1
		}
		if idx < 0 {
			continue
		}
		used[idx] = true
		start := ansi.StringWidth(text[:idx])
		ref := &api.Mention{Start: start, End: start + ansi.StringWidth(m.text), Text: m.text}
		switch m.kind {
		case "file", "reference":
			out.Files = append(out.Files, api.PromptFile{URI: fileURI(m.value), Name: m.name, Mention: ref})
		case "agent":
			out.Agents = append(out.Agents, api.PromptAgent{Name: m.value, Mention: ref})
		case "skill":
			out.Skills = append(out.Skills, api.PromptSkill{ID: m.value, Mention: ref})
		}
	}
	return out
}

func fileURI(p string) string {
	return "file://" + filepath.ToSlash(p)
}

// Remember appends a submitted prompt to the shared history file.
func (p *Prompt) Remember(text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	if n := len(p.history); n == 0 || p.history[n-1] != text {
		p.history = append(p.history, text)
	}
	p.histPos = len(p.history)
	appendHistory(text)
}

// prompt-history.jsonl is shared with the classic TUI (prompt/history.tsx).
func historyFile() string { return filepath.Join(stateDir(), "prompt-history.jsonl") }

func loadHistory() []string {
	f, err := os.Open(historyFile())
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 8<<20)
	for sc.Scan() {
		var e struct {
			Text string `json:"text"`
			Mode string `json:"mode"`
		}
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.Text != "" {
			if e.Mode == "shell" && !strings.HasPrefix(e.Text, "!") {
				e.Text = "!" + e.Text
			}
			out = append(out, e.Text)
		}
	}
	return out
}

func appendHistory(text string) {
	entry := map[string]any{"text": text, "pasted": []any{}}
	if strings.HasPrefix(text, "!") {
		entry["text"] = strings.TrimPrefix(text, "!")
		entry["mode"] = "shell"
	}
	b, _ := json.Marshal(entry)
	_ = os.MkdirAll(stateDir(), 0o755)
	f, err := os.OpenFile(historyFile(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(b, '\n'))
}
