package ui

import (
	"sort"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/sahilm/fuzzy"

	"infiniteoc/infinitui/internal/theme"
)

// PickItem is one row of a picker.
type PickItem struct {
	ID       string
	Title    string
	Detail   string // dim text after the title
	Right    string // right-aligned hint (keybind, time, price)
	Category string
	Mark     string // leading glyph, e.g. "●" for current
	Key      string // shortcut, drawn as keycaps ("ctrl+x u" = two caps)
	Value    any
	Keywords string // extra text matched by the filter
}

// Picker is a filterable, grouped list shown in a dialog.
type Picker struct {
	Title       string
	Placeholder string
	Empty       string
	items       []PickItem
	shown       []PickItem
	cursor      int
	offset      int
	input       textinput.Model
	width       int
	height      int
	// Grouped keeps category headers when the filter is empty.
	Grouped bool
	// OnPick runs on enter. Returning nil closes the dialog.
	OnPick func(PickItem) tea.Cmd
	// Keys maps extra keys (e.g. "ctrl+d") to actions on the highlighted item.
	Keys map[string]func(PickItem) tea.Cmd
	// Footer is shown under the list (key hints).
	Footer string
	// Side, when set, draws a preview of the highlighted item beside the list.
	Side func(it PickItem, w, h int) []string
}

// NewPicker builds a picker over items.
func NewPicker(title string, items []PickItem) *Picker {
	in := textinput.New()
	in.Prompt = ""
	in.Placeholder = "Type to filter"
	in.Focus()
	p := &Picker{Title: title, items: items, input: in, Grouped: true, Empty: "No matches"}
	p.refilter()
	return p
}

// SetItems replaces the rows, keeping the filter.
func (p *Picker) SetItems(items []PickItem) {
	p.items = items
	p.refilter()
}

// SelectID moves the cursor to the row with id.
func (p *Picker) SelectID(id string) {
	for i, it := range p.shown {
		if it.ID == id {
			p.cursor = i
			return
		}
	}
}

// Query is the current filter text.
func (p *Picker) Query() string { return p.input.Value() }

// Current returns the highlighted item.
func (p *Picker) Current() (PickItem, bool) {
	if p.cursor < 0 || p.cursor >= len(p.shown) {
		return PickItem{}, false
	}
	return p.shown[p.cursor], true
}

type pickSource []PickItem

func (s pickSource) String(i int) string {
	return s[i].Title + " " + s[i].Detail + " " + s[i].Keywords
}
func (s pickSource) Len() int { return len(s) }

func (p *Picker) refilter() {
	q := strings.TrimSpace(p.input.Value())
	if q == "" {
		p.shown = append(p.shown[:0], p.items...)
		if p.Grouped {
			// Stable grouping by first appearance of each category.
			order := map[string]int{}
			for _, it := range p.items {
				if _, ok := order[it.Category]; !ok {
					order[it.Category] = len(order)
				}
			}
			sort.SliceStable(p.shown, func(i, j int) bool { return order[p.shown[i].Category] < order[p.shown[j].Category] })
		}
	} else {
		matches := fuzzy.FindFrom(q, pickSource(p.items))
		p.shown = p.shown[:0]
		for _, m := range matches {
			p.shown = append(p.shown, p.items[m.Index])
		}
		// Whole-word substring hits in the title beat scattered fuzzy matches.
		lq := strings.ToLower(q)
		rank := func(it PickItem) int {
			t := strings.ToLower(it.Title + " " + it.Detail)
			switch {
			case strings.HasPrefix(t, lq):
				return 0
			case strings.Contains(t, " "+lq) || strings.Contains(t, "/"+lq):
				return 1
			case strings.Contains(t, lq):
				return 2
			}
			return 3
		}
		sort.SliceStable(p.shown, func(i, j int) bool { return rank(p.shown[i]) < rank(p.shown[j]) })
	}
	if p.cursor >= len(p.shown) {
		p.cursor = max(0, len(p.shown)-1)
	}
	if p.offset > p.cursor {
		p.offset = p.cursor
	}
}

// Update handles keys. done reports that the dialog should close.
func (p *Picker) Update(msg tea.Msg) (cmd tea.Cmd, done bool) {
	switch m := msg.(type) {
	case tea.KeyPressMsg:
		switch m.String() {
		case "up", "ctrl+p", "ctrl+k":
			p.move(-1)
			return nil, false
		case "down", "ctrl+n", "ctrl+j", "tab":
			p.move(1)
			return nil, false
		case "pgup":
			p.move(-p.listHeight())
			return nil, false
		case "pgdown":
			p.move(p.listHeight())
			return nil, false
		case "enter":
			it, ok := p.Current()
			if !ok || p.OnPick == nil {
				return nil, true
			}
			return p.OnPick(it), true
		}
		if fn, ok := p.Keys[m.String()]; ok {
			if it, ok := p.Current(); ok {
				return fn(it), false
			}
			return nil, false
		}
	}
	before := p.input.Value()
	var c tea.Cmd
	p.input, c = p.input.Update(msg)
	if p.input.Value() != before {
		p.cursor, p.offset = 0, 0
		p.refilter()
	}
	return c, false
}

func (p *Picker) move(d int) {
	if len(p.shown) == 0 {
		return
	}
	p.cursor = (p.cursor + d + len(p.shown)) % len(p.shown)
	if d > 1 || d < -1 {
		p.cursor = max(0, min(len(p.shown)-1, p.cursor))
	}
}

func (p *Picker) listHeight() int { return max(3, p.height-8) }

// Render draws the picker at the given outer size.
func (p *Picker) Render(width, height int) string {
	pal := theme.Current
	s := theme.S
	p.width, p.height = width, height
	inner := width - 6 // border + padding
	p.input.SetWidth(inner - 2)

	in := lipgloss.NewStyle().Foreground(pal.Primary).Render("› ") + p.input.View()

	lh := p.listHeight()
	// Keep the cursor visible, counting category header rows.
	rows := p.rows()
	curRow := 0
	for i, r := range rows {
		if r.item == p.cursor {
			curRow = i
		}
	}
	if curRow < p.offset {
		p.offset = curRow
	}
	if curRow >= p.offset+lh {
		p.offset = curRow - lh + 1
	}
	if p.offset > max(0, len(rows)-lh) {
		p.offset = max(0, len(rows)-lh)
	}

	var body []string
	if len(rows) == 0 {
		body = append(body, s.Subtle.Render("  "+p.Empty))
	}
	listW := inner
	sideW := 0
	if p.Side != nil && inner >= 90 {
		listW = inner * 9 / 20
		sideW = inner - listW - 3
	}
	for i := p.offset; i < len(rows) && i < p.offset+lh; i++ {
		body = append(body, p.renderRow(rows[i], listW))
	}
	n := min(lh, max(len(rows), 1))
	if sideW > 0 {
		n = lh
	}
	for len(body) < n {
		body = append(body, "")
	}
	if len(rows) > lh {
		pct := float64(p.offset) / float64(max(1, len(rows)-lh))
		body = withScrollbar(body, pct, lh, len(rows), listW)
	}
	if sideW > 0 {
		var side []string
		if it, ok := p.Current(); ok {
			side = p.Side(it, sideW, len(body))
		}
		sep := lipgloss.NewStyle().Foreground(pal.Border).Render("│")
		for i := range body {
			l := body[i]
			if w := ansi.StringWidth(l); w < listW {
				l += strings.Repeat(" ", listW-w)
			}
			r := ""
			if i < len(side) {
				r = ansi.Truncate(side[i], sideW, "…")
			}
			body[i] = l + " " + sep + " " + r
		}
	}

	lines := append([]string{in, ""}, body...)
	return dialogFrame(width, p.Title, lines, p.Footer)
}

type pickRow struct {
	header string
	item   int // -1 for headers
}

func (p *Picker) rows() []pickRow {
	var rows []pickRow
	last := "\x00"
	grouped := p.Grouped && strings.TrimSpace(p.input.Value()) == ""
	for i, it := range p.shown {
		if grouped && it.Category != last && it.Category != "" {
			rows = append(rows, pickRow{header: it.Category, item: -1})
		}
		last = it.Category
		rows = append(rows, pickRow{item: i})
	}
	return rows
}

func (p *Picker) renderRow(r pickRow, width int) string {
	s := theme.S
	pal := theme.Current
	if r.item < 0 {
		return lipgloss.NewStyle().Foreground(pal.Accent).Bold(true).Render(r.header)
	}
	it := p.shown[r.item]
	sel := r.item == p.cursor
	mark := it.Mark
	if mark == "" {
		mark = " "
	}
	left := mark + " " + it.Title
	right := it.Right
	if it.Key != "" {
		right = keycaps(it.Key, sel)
	}
	detail := ""
	if it.Detail != "" {
		detail = "  " + it.Detail
	}
	room := width - 2 - ansi.StringWidth(right)
	if ansi.StringWidth(left) > room {
		left = ansi.Truncate(left, room-1, "…")
		detail = ""
	} else if ansi.StringWidth(left+detail) > room {
		detail = ansi.Truncate(detail, room-ansi.StringWidth(left)-1, "…")
	}
	gap := max(1, width-2-ansi.StringWidth(left+detail+right))
	if sel {
		bg := lipgloss.NewStyle().Background(pal.PanelAlt)
		return bg.Foreground(pal.Primary).Bold(true).Render("▌") +
			bg.Foreground(pal.Text).Bold(true).Render(left) +
			bg.Foreground(pal.Muted).Render(detail+strings.Repeat(" ", gap)) +
			bg.Foreground(pal.Muted).Render(right)
	}
	if it.Key == "" {
		right = s.Subtle.Render(right)
	}
	return " " + s.Text.Render(left) + s.Subtle.Render(detail) + strings.Repeat(" ", gap) + right
}

// keycaps draws a shortcut as little key tops: "ctrl+x u" -> [ctrl+x] [u].
func keycaps(keys string, selected bool) string {
	pal := theme.Current
	bg := pal.PanelAlt
	if selected {
		bg = pal.Border
	}
	cap := lipgloss.NewStyle().Background(bg).Foreground(pal.Text)
	var parts []string
	for _, k := range strings.Fields(keys) {
		parts = append(parts, cap.Render(" "+k+" "))
	}
	return strings.Join(parts, " ")
}

func withScrollbar(lines []string, pct float64, visible, total, width int) []string {
	pal := theme.Current
	thumb := max(1, visible*visible/max(1, total))
	pos := int(pct * float64(visible-thumb))
	out := make([]string, len(lines))
	for i, l := range lines {
		if w := ansi.StringWidth(l); w < width-1 {
			l += strings.Repeat(" ", width-1-w)
		} else if w > width-1 {
			l = ansi.Truncate(l, width-1, "")
		}
		c := lipgloss.NewStyle().Foreground(pal.Border).Render("│")
		if i >= pos && i < pos+thumb {
			c = lipgloss.NewStyle().Foreground(pal.Primary).Render("┃")
		}
		out[i] = l + c
	}
	return out
}
