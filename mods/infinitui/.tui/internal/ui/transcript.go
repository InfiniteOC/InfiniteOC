package ui

import (
	"fmt"
	"math"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/api"
	"infiniteoc/infinitui/internal/render"
	"infiniteoc/infinitui/internal/theme"
)

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// renderOpts are inputs that change how messages render.
type renderOpts struct {
	width       int // content width (without the side gutters)
	expandAll   bool
	expanded    map[string]bool // block keys toggled open
	cwd         string
	store       *Store
	now         int64
	frame       int
	showThought bool
	reveal      map[*api.Block]int // bytes of a streaming text block shown so far
	waiting     string             // label for the pending node while the model has not answered
}

type cachedLines struct {
	key    string
	lines  []string
	owners []string
}

// Transcript renders a session's messages into a scrollable list of lines.
type Transcript struct {
	cache   map[string]cachedLines
	lines   []string
	owners  []string // block key that owns each line, for click-to-expand
	msgAt   []string // message ID that owns each line
	offset  int      // target first line
	pos     float64  // displayed first line, gliding toward offset
	primed  bool
	instant bool // skip the glide (reduced motion)
	follow  bool
	height  int
	// per-message counter bumped when a block inside it is toggled
	expandGen map[string]int
	// first line of each unit, by owner key
	unitStart map[string]int
	// decorated rows of finished turns
	turnCache map[string]cachedTurn
}

// NewTranscript returns an empty transcript that follows new output.
func NewTranscript() *Transcript {
	return &Transcript{cache: map[string]cachedLines{}, follow: true, expandGen: map[string]int{}, unitStart: map[string]int{}, turnCache: map[string]cachedTurn{}}
}

func blockKey(msgID, blockID string) string { return msgID + "|" + blockID }

// Toggle flips one block's expansion.
func (t *Transcript) Toggle(opts *renderOpts, key string) {
	opts.expanded[key] = !opts.expanded[key]
	msgID := strings.SplitN(key, "|", 2)[0]
	t.expandGen[msgID]++
}

// live reports whether a message is still changing (never cached).
func live(m *api.Message) bool {
	switch m.Type {
	case "assistant":
		if m.Time.Completed == 0 {
			return true
		}
		for _, b := range m.Content {
			if b.Type == "tool" && b.State != nil && (b.State.Status == "streaming" || b.State.Status == "running") {
				return true
			}
			if b.Type == "tool" && (b.Name == "subagent" || b.Name == "task") {
				return true // child progress changes without touching this message
			}
		}
	case "shell", "compaction":
		return m.Status == "running"
	}
	return m.Pending
}

// SetHeight sets the visible rows and keeps the bottom pinned when following.
func (t *Transcript) SetHeight(h int) {
	t.height = max(1, h)
	t.clamp()
}

func (t *Transcript) maxOffset() int { return max(0, len(t.lines)-t.height) }

func (t *Transcript) clamp() {
	if t.follow {
		t.offset = t.maxOffset()
	}
	t.offset = max(0, min(t.offset, t.maxOffset()))
}

// Scroll moves by n lines (negative = up).
func (t *Transcript) Scroll(n int) {
	t.offset += n
	t.follow = false
	if t.offset >= t.maxOffset() {
		t.follow = true
	}
	t.clamp()
}

// Top jumps to the first line.
func (t *Transcript) Top() { t.offset = 0; t.follow = false; t.clamp() }

// Bottom jumps to the end and follows output again.
func (t *Transcript) Bottom() { t.follow = true; t.clamp() }

// AtTop reports whether the first line is visible.
func (t *Transcript) AtTop() bool { return t.offset == 0 }

// ScrollToMessage puts a message at the top of the view.
func (t *Transcript) ScrollToMessage(id string) {
	for i, m := range t.msgAt {
		if m == id && t.owners[i] != "" {
			t.offset = max(0, i-1)
			t.follow = false
			t.clamp()
			return
		}
	}
}

// View returns the visible lines.
func (t *Transcript) View() []string {
	t.clamp()
	if !t.primed && len(t.lines) > 0 {
		t.pos, t.primed = float64(t.offset), true
	}
	top := t.Shown()
	end := min(len(t.lines), top+t.height)
	return t.lines[top:end]
}

// JumpTurn scrolls to the previous (dir<0) or next prompt band.
func (t *Transcript) JumpTurn(dir int) {
	cur := t.offset
	isBand := func(i int) bool {
		o := t.owners[i]
		return (strings.HasSuffix(o, "|user") || strings.HasSuffix(o, "|shell")) && (i == 0 || t.owners[i-1] != o)
	}
	if dir < 0 {
		for i := min(cur-1, len(t.owners)-1); i >= 0; i-- {
			if isBand(i) {
				t.offset, t.follow = max(0, i-1), false
				t.clamp()
				return
			}
		}
		t.Top()
		return
	}
	for i := cur + 2; i < len(t.owners); i++ {
		if isBand(i) {
			t.offset, t.follow = i-1, false
			if t.offset >= t.maxOffset() {
				t.follow = true
			}
			t.clamp()
			return
		}
	}
	t.Bottom()
}

// CurrentTurn is the prompt whose turn is at the top of the view.
func (t *Transcript) CurrentTurn() string {
	top := min(t.Shown()+2, len(t.owners)-1)
	for i := top; i >= 0; i-- {
		if strings.HasSuffix(t.owners[i], "|user") {
			return t.msgAt[i]
		}
	}
	return ""
}

// BandRows lists the line index of every prompt band.
func (t *Transcript) BandRows() []int {
	var out []int
	for i, o := range t.owners {
		if strings.HasSuffix(o, "|user") && (i == 0 || t.owners[i-1] != o) {
			out = append(out, i)
		}
	}
	return out
}

// Shown is the first line actually on screen.
func (t *Transcript) Shown() int {
	return max(0, min(int(math.Round(t.pos)), t.maxOffset()))
}

// glide eases the displayed position toward the target, one frame at a time.
func (t *Transcript) glide() {
	d := float64(t.offset) - t.pos
	if math.Abs(d) < 0.6 || t.instant {
		t.pos = float64(t.offset)
		return
	}
	// Far jumps cover most of the distance at once; the last lines ease in.
	t.pos += d * 0.42
}

func (t *Transcript) gliding() bool {
	if t.instant {
		t.pos = float64(t.offset)
	}
	return math.Abs(float64(t.offset)-t.pos) >= 0.6
}

// OwnerAt returns the block key for a visible row.
func (t *Transcript) OwnerAt(row int) string {
	i := t.Shown() + row
	if i < 0 || i >= len(t.owners) {
		return ""
	}
	return t.owners[i]
}

// Lines exposes everything for copy/search.
func (t *Transcript) Lines() []string { return t.lines }

// Offset is the first visible line index.
func (t *Transcript) Offset() int { return t.offset }

// --- message renderers ---

func wrapText(s string, width int) []string {
	if width < 4 {
		width = 4
	}
	return strings.Split(ansi.Wrap(s, width, ""), "\n")
}

func indentLines(lines []string, first, rest string) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		if i == 0 {
			out[i] = first + l
		} else {
			out[i] = rest + l
		}
	}
	return out
}

func renderMessage(m *api.Message, sd *sessionData, idx int, turnStart int64, o renderOpts) ([]string, []string) {
	s := theme.S
	p := theme.Current
	w := o.width
	switch m.Type {
	case "synthetic":
		return renderSynthetic(m, w, o.expandAll), nil
	case "system":
		label := m.Description
		if label == "" {
			label = firstLine(m.Text)
		}
		return []string{s.Subtle.Render("• " + ansi.Truncate(label, w-2, "…"))}, nil
	case "skill":
		return []string{s.Muted.Render("◇ Loaded skill ") + s.Primary.Render(nonEmpty(m.Name, m.Skill))}, nil
	case "agent-switched":
		name := m.Agent
		if a, ok := o.store.Agent(m.Agent); ok {
			name = a.Label()
		}
		return []string{s.Subtle.Render("↳ agent ") + lipgloss.NewStyle().Foreground(p.Accent).Render(name)}, nil
	case "model-switched":
		if m.Model == nil {
			return nil, nil
		}
		label := m.Model.ID
		if mm, ok := o.store.Model(*m.Model); ok {
			label = mm.Name
		}
		if m.Model.Variant != "" && m.Model.Variant != "default" {
			label += " " + m.Model.Variant
		}
		return []string{s.Subtle.Render("↳ model ") + s.Muted.Render(label)}, nil
	case "location-switched":
		dir := ""
		if m.Location != nil {
			dir = m.Location.Directory
		}
		return []string{s.Subtle.Render("↳ moved to ") + s.Muted.Render(dir)}, nil
	case "shell":
		return renderShellMessage(m, o), nil
	case "compaction":
		return renderCompaction(m, o), nil
	}
	return nil, nil
}

func nonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// goalText shows an InfiniteOC goal start as the command the user typed.
func goalText(t string) string {
	if strings.HasPrefix(t, "[InfiniteOC goal]\nGoal: ") {
		rest := strings.TrimPrefix(t, "[InfiniteOC goal]\nGoal: ")
		return "/goal " + firstLine(rest)
	}
	return t
}

func renderSynthetic(m *api.Message, w int, expanded bool) []string {
	s := theme.S
	text := strings.TrimSpace(m.Text)
	if strings.HasPrefix(text, "[InfiniteOC goal") {
		head := firstLine(text)
		return []string{s.Accent.Render("◎ ") + s.Muted.Render(strings.Trim(head, "[]"))}
	}
	label := m.Description
	if label == "" {
		// Context the server injects (e.g. after a !shell command) is plumbing; ctrl+o shows it.
		if !expanded {
			return nil
		}
		label = firstLine(text)
	}
	out := []string{s.Subtle.Render("◇ " + ansi.Truncate(label, w-2, "…"))}
	if expanded && m.Description != "" {
		for _, l := range wrapText(text, w-2) {
			out = append(out, "  "+s.Subtle.Render(l))
		}
	}
	return out
}

func statusGlyph(state *api.ToolState, frame int) string {
	p := theme.Current
	if state == nil {
		return lipgloss.NewStyle().Foreground(p.Subtle).Render("○")
	}
	switch state.Status {
	case "completed":
		return lipgloss.NewStyle().Foreground(p.Success).Render("●")
	case "error":
		return lipgloss.NewStyle().Foreground(p.Error).Render("●")
	case "running":
		return lipgloss.NewStyle().Foreground(p.Primary).Render(spinnerFrames[frame%len(spinnerFrames)])
	}
	return lipgloss.NewStyle().Foreground(p.Subtle).Render(spinnerFrames[frame%len(spinnerFrames)])
}

// errorBox draws a failure as a red card hanging off the thread.
func errorBox(msg string, w int) []string {
	p := theme.Current
	text := lipgloss.NewStyle().Foreground(p.Text)
	var body []string
	for _, l := range wrapText(strings.TrimSpace(msg), w-8) {
		body = append(body, text.Render(l))
	}
	title := lipgloss.NewStyle().Foreground(p.Error).Bold(true).Render("failed")
	box := strings.Split(frame(w-2, p.Error, title, "", body, "", ""), "\n")
	out := make([]string, len(box))
	for i, l := range box {
		if i == 0 {
			out[i] = lipgloss.NewStyle().Foreground(p.Error).Render("✗") + " " + l
		} else {
			out[i] = "  " + l
		}
	}
	return out
}

func lastLines(lines []string, n int) []string {
	if len(lines) > n {
		return lines[len(lines)-n:]
	}
	return lines
}

// splitThinkingTitle extracts a leading **Title** (context/thinking.ts).
func splitThinkingTitle(text string) (string, string) {
	if strings.HasPrefix(text, "**") {
		if end := strings.Index(text[2:], "**"); end > 0 {
			title := text[2 : 2+end]
			if !strings.Contains(title, "\n") {
				return title, strings.TrimSpace(text[4+end:])
			}
		}
	}
	return "", text
}

func renderShellMessage(m *api.Message, o renderOpts) []string {
	s := theme.S
	st := &api.ToolState{Status: "running"}
	switch m.Status {
	case "exited":
		st.Status = "completed"
		if m.Exit != nil && *m.Exit != 0 {
			st.Status = "error"
		}
	case "timeout", "killed":
		st.Status = "error"
	}
	head := statusGlyph(st, o.frame) + " " + s.Accent.Bold(true).Render("$") + " " + s.Text.Render(ansi.Truncate(m.Command, o.width-6, "…"))
	if m.Exit != nil && *m.Exit != 0 {
		head += " " + s.Error.Render(fmt.Sprintf("exit %d", *m.Exit))
	}
	out := []string{head}
	if m.Output != nil {
		lines := splitLines(ansi.Strip(m.Output.Output))
		shown, hidden := tail(lines, 10, o.expandAll)
		gutter := s.Subtle.Render("  ╰  ")
		for j, l := range dimLines(shown, o.width-6) {
			if j == 0 {
				out = append(out, gutter+l)
			} else {
				out = append(out, "     "+l)
			}
		}
		if hidden > 0 {
			out = append(out, "     "+s.Subtle.Render(fmt.Sprintf("… %d earlier lines (ctrl+o)", hidden)))
		}
	}
	return out
}

func renderCompaction(m *api.Message, o renderOpts) []string {
	s := theme.S
	w := o.width
	label := " Context compacted "
	switch m.Status {
	case "running":
		label = " " + spinnerFrames[o.frame%len(spinnerFrames)] + " Compacting context… "
	case "failed":
		label = " Compaction failed "
	}
	if m.Reason == "auto" {
		label = strings.TrimRight(label, " ") + " (auto) "
	}
	side := max(2, (w-ansi.StringWidth(label))/2)
	line := s.Subtle.Render(strings.Repeat("─", side)) + s.Muted.Render(label) + s.Subtle.Render(strings.Repeat("─", max(0, w-side-ansi.StringWidth(label))))
	out := []string{line}
	if o.expandAll && m.Summary != "" {
		for _, l := range render.Markdown(m.Summary, w-2) {
			out = append(out, "  "+l)
		}
	}
	if m.Status == "failed" && m.Error != nil {
		out = append(out, errorBox(m.Error.Message, w)...)
	}
	return out
}

// humanDuration prints 4s, 1m 12s, 2h 3m.
func humanDuration(d time.Duration) string {
	switch {
	case d < time.Second:
		return fmt.Sprintf("%.1fs", d.Seconds())
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm %ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh %dm", int(d.Hours()), int(d.Minutes())%60)
}

// shimmer sweeps a bright band across text in the brand gradient.
func shimmer(text string, frame int) string {
	p := theme.Current
	runes := []rune(text)
	n := len(runes)
	if n == 0 {
		return ""
	}
	pos := frame % (n + 8)
	var b strings.Builder
	for i, r := range runes {
		d := i - (pos - 4)
		if d < 0 {
			d = -d
		}
		c := p.Muted
		if d <= 3 {
			t := 1 - float64(d)/4
			c = theme.Blend([]colorT{p.Muted, p.Primary, p.Accent}, t)
		}
		b.WriteString(lipgloss.NewStyle().Foreground(c).Render(string(r)))
	}
	return b.String()
}
