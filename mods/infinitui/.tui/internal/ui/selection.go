package ui

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/render"
	"infiniteoc/infinitui/internal/theme"
)

// Mouse capture hides the terminal's own selection, so the transcript has its own:
// drag to select, release to copy. A click without a drag still expands blocks.

type point struct{ row, col int } // row: transcript line index; col: screen column

type selection struct {
	down     bool
	dragging bool
	from, to point
	shown    bool // keep highlighting after the copy until the next click
}

func (a *App) transcriptPoint(m tea.Mouse) (point, bool) {
	l := a.layout()
	r := m.Y - l.transcriptTop
	if m.X >= a.mainWidth() || a.home() {
		return point{}, false
	}
	if r < 0 {
		r = 0
	}
	if r >= a.tr.height {
		r = a.tr.height - 1
	}
	return point{row: a.tr.Shown() + r, col: max(0, m.X)}, m.Y >= l.transcriptTop && m.Y < l.transcriptTop+a.tr.height
}

func (a *App) mouseDown(m tea.Mouse) {
	if a.dialog != nil || m.Button != tea.MouseLeft {
		return
	}
	if a.sidebarOn() && m.X >= a.mainWidth() {
		if id, ok := a.outlineRows[m.Y]; ok {
			a.tr.ScrollToMessage(id)
		}
		return
	}
	p, inside := a.transcriptPoint(m)
	a.sel = selection{}
	if !inside {
		return
	}
	a.sel = selection{down: true, from: p, to: p}
}

func (a *App) mouseDrag(m tea.Mouse) tea.Cmd {
	if !a.sel.down {
		// Plain motion: light up the block under the pointer.
		a.hover = ""
		if a.dialog == nil {
			if pt, inside := a.transcriptPoint(m); inside {
				a.hover = a.tr.OwnerAt(pt.row - a.tr.Shown())
			}
		}
		return nil
	}
	p, _ := a.transcriptPoint(m)
	// Dragging past the edges scrolls.
	l := a.layout()
	if m.Y < l.transcriptTop {
		a.tr.Scroll(-1)
	} else if m.Y >= l.transcriptTop+a.tr.height {
		a.tr.Scroll(1)
	}
	if p != a.sel.from {
		a.sel.dragging = true
		a.sel.shown = true
	}
	a.sel.to = p
	return nil
}

func (a *App) mouseUp(m tea.Mouse) tea.Cmd {
	if !a.sel.down {
		return nil
	}
	a.sel.down = false
	if !a.sel.dragging {
		a.sel = selection{}
		return a.handleClick(m)
	}
	a.sel.dragging = false
	text := a.selectedText()
	if strings.TrimSpace(text) == "" {
		a.sel = selection{}
		return nil
	}
	n := strings.Count(text, "\n") + 1
	return tea.Batch(tea.SetClipboard(text), copyNative(text), a.showToast("success", "", fmt.Sprintf("Copied %s", plural(n, "line", "lines")), 1500*time.Millisecond))
}

func (s selection) ordered() (point, point) {
	a, b := s.from, s.to
	if b.row < a.row || (b.row == a.row && b.col < a.col) {
		a, b = b, a
	}
	return a, b
}

// span returns the selected column range on a transcript line, or ok=false.
func (a *App) span(row, width int) (int, int, bool) {
	if !a.sel.shown {
		return 0, 0, false
	}
	from, to := a.sel.ordered()
	if row < from.row || row > to.row {
		return 0, 0, false
	}
	start, end := 0, width
	if row == from.row {
		start = from.col
	}
	if row == to.row {
		end = to.col + 1
	}
	if end <= start {
		return 0, 0, false
	}
	return start, end, true
}

func (a *App) highlightSelection(row int, line string) string {
	w := ansi.StringWidth(line)
	start, end, ok := a.span(row, max(w, 1))
	if !ok || start >= w {
		return line
	}
	end = min(end, w)
	st := lipgloss.NewStyle().Background(theme.Current.PanelAlt).Foreground(theme.Current.Text)
	return ansi.Cut(line, 0, start) + st.Render(ansi.Strip(ansi.Cut(line, start, end))) + ansi.Cut(line, end, w)
}

func (a *App) selectedText() string {
	from, to := a.sel.ordered()
	lines := a.tr.Lines()
	var out []string
	for r := from.row; r <= to.row && r < len(lines); r++ {
		if r < 0 {
			continue
		}
		plain := ansi.Strip(lines[r])
		w := ansi.StringWidth(plain)
		start, end, ok := a.span(r, w)
		if !ok {
			out = append(out, "")
			continue
		}
		end = min(end, w)
		if start >= end {
			out = append(out, "")
			continue
		}
		out = append(out, strings.TrimRight(ansi.Cut(plain, start, end), " "))
	}
	// Drop the transcript's left gutter consistently.
	common := -1
	for _, l := range out {
		if strings.TrimSpace(l) == "" {
			continue
		}
		n := len(l) - len(strings.TrimLeft(l, " "))
		if common < 0 || n < common {
			common = n
		}
	}
	for i, l := range out {
		if common > 0 && len(l) >= common {
			out[i] = l[common:]
		}
	}
	return strings.Join(out, "\n")
}

// codeAt returns the code block under row rel of a text unit, if any.
func (a *App) codeAt(key string, rel int) (string, bool) {
	parts := strings.SplitN(key, "|", 2)
	d, ok := a.store.Get(a.sessionID)
	if !ok || len(parts) != 2 {
		return "", false
	}
	m := d.index[parts[0]]
	if m == nil {
		return "", false
	}
	for i, b := range m.Content {
		id := b.ID
		if id == "" {
			id = fmt.Sprint(i)
		}
		if id != parts[1] {
			continue
		}
		if b.Type == "tool" && b.Name == "write" && b.State != nil && rel > 0 {
			if content := str(parseObj(b.State.Input), "content"); content != "" {
				return content, true
			}
		}
		if b.Type != "text" {
			continue
		}
		_, owner, codes := render.RichMap(strings.TrimSpace(b.Text), mdWidth(a.ropts.width), false)
		if rel >= 0 && rel < len(owner) && owner[rel] >= 0 {
			return codes[owner[rel]], true
		}
	}
	return "", false
}

// openTurnMenu offers actions for a prompt band.
func (a *App) openTurnMenu(key string) tea.Cmd {
	id := strings.SplitN(key, "|", 2)[0]
	d, ok := a.store.Get(a.sessionID)
	if !ok || d.index[id] == nil {
		return nil
	}
	m := d.index[id]
	reply := a.replyAfter(d, id)
	items := []PickItem{
		{ID: "copy", Title: "Copy prompt", Mark: "◇"},
		{ID: "reply", Title: "Copy reply", Mark: "◇", Detail: map[bool]string{true: "", false: "no reply yet"}[reply != ""]},
		{ID: "rewind", Title: "Rewind to here", Detail: "undo this turn and everything after · restores files", Mark: "↶"},
		{ID: "fork", Title: "Fork from here", Detail: "new session with the history before this prompt", Mark: "↳"},
		{ID: "expand", Title: "Expand or collapse", Mark: "↕"},
	}
	p := NewPicker("Turn", items)
	p.Grouped = false
	p.OnPick = func(it PickItem) tea.Cmd {
		switch it.ID {
		case "copy":
			return tea.Batch(tea.SetClipboard(m.Text), copyNative(m.Text), a.showToast("success", "", "Copied the prompt", 1500*time.Millisecond))
		case "reply":
			if reply == "" {
				return nil
			}
			return tea.Batch(tea.SetClipboard(reply), copyNative(reply), a.showToast("success", "", "Copied the reply", 1500*time.Millisecond))
		case "rewind":
			return a.revertTo(m)
		case "fork":
			return a.forkAt(id)
		case "expand":
			a.tr.Toggle(&a.ropts, key)
		}
		return nil
	}
	a.dialog = &pickerDialog{p: p, width: 70}
	return nil
}

// replyAfter collects the assistant text of the turn that starts at prompt id.
func (a *App) replyAfter(d *sessionData, id string) string {
	var parts []string
	seen := false
	for _, m := range d.msgs {
		if m.ID == id {
			seen = true
			continue
		}
		if !seen {
			continue
		}
		if m.Type == "user" && !m.Pending {
			break
		}
		if m.Type == "assistant" {
			for _, b := range m.Content {
				if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
					parts = append(parts, strings.TrimSpace(b.Text))
				}
			}
		}
	}
	return strings.Join(parts, "\n\n")
}
