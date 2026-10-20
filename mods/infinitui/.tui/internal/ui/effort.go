package ui

import (
	"fmt"
	"math"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/theme"
)

var effortHints = map[string]string{
	"":           "the model's own default",
	"none":       "no extended reasoning",
	"minimal":    "fastest replies, almost no reasoning",
	"low":        "quick answers, light reasoning",
	"medium":     "balanced speed and depth",
	"high":       "thinks longer on hard problems",
	"xhigh":      "extended reasoning for tough tasks",
	"max":        "the largest reasoning budget",
	"auto":       "picks a level for each request",
	"infinicode": "strongest effort · workflows on · red theme",
}

// effortDialog is a horizontal slider over the current model's effort levels.
type effortDialog struct {
	a       *App
	model   string
	stops   []string // "" is the model default
	sel     int
	current int
	pos     float64 // knob position in stops, gliding toward sel
}

func (a *App) openEffort() tea.Cmd {
	mm, ok := a.store.Model(a.model)
	if !ok {
		return a.showToast("info", "", "Pick a model first", 2*time.Second)
	}
	stops := []string{""}
	for _, v := range mm.Variants {
		if v.ID != "default" {
			stops = append(stops, v.ID)
		}
	}
	if len(stops) == 1 {
		return a.showToast("info", "", mm.Name+" has no effort levels", 2*time.Second)
	}
	d := &effortDialog{a: a, model: mm.Name, stops: stops}
	for i, s := range stops {
		if s == a.model.Variant {
			d.sel, d.current = i, i
		}
	}
	d.pos = float64(d.sel)
	a.dialog = d
	return nil
}

func (d *effortDialog) move(to int) {
	d.sel = max(0, min(len(d.stops)-1, to))
}

func (d *effortDialog) Update(msg tea.Msg) (tea.Cmd, bool) {
	switch m := msg.(type) {
	case tea.KeyPressMsg:
		switch k := m.String(); k {
		case "esc", "q":
			return nil, true
		case "left", "h", "shift+tab":
			d.move(d.sel - 1)
		case "right", "l", "tab":
			d.move(d.sel + 1)
		case "home":
			d.move(0)
		case "end":
			d.move(len(d.stops) - 1)
		case "enter", "space":
			if d.sel == d.current {
				return nil, true
			}
			return d.a.setVariant(d.stops[d.sel]), true
		default:
			if len(k) == 1 && k[0] >= '1' && k[0] <= '9' {
				d.move(int(k[0] - '1'))
			}
		}
	case tea.MouseWheelMsg:
		if m.Button == tea.MouseWheelUp {
			d.move(d.sel - 1)
		} else {
			d.move(d.sel + 1)
		}
	}
	return nil, false
}

// gliding moves the knob a step toward the selection; it reports whether it is still moving.
func (d *effortDialog) gliding() bool {
	diff := float64(d.sel) - d.pos
	if math.Abs(diff) < 0.02 || !d.a.opt.Animations {
		d.pos = float64(d.sel)
		return false
	}
	d.pos += diff * 0.35
	return true
}

func (d *effortDialog) moving() bool {
	return math.Abs(float64(d.sel)-d.pos) >= 0.02 && d.a.opt.Animations
}

func (d *effortDialog) Width(screen int) int { return min(84, screen-4) }
func (d *effortDialog) Closable() bool       { return true }

func (d *effortDialog) View(w, h int) string {
	s := theme.S
	p := theme.Current
	inner := w - 6
	track := inner - 6 // room for a label overhang at both ends
	n := len(d.stops)
	at := func(i float64) int { return int(math.Round(i * float64(track-1) / float64(n-1))) }
	knob := at(d.pos)
	stopAt := map[int]int{}
	for i := range d.stops {
		stopAt[at(float64(i))] = i
	}
	hot := d.stops[d.sel] == "infinicode"
	ramp := p.Gradient
	if hot {
		ramp = theme.InfiniCode.Gradient
	}

	var line strings.Builder
	for x := 0; x < track; x++ {
		c := theme.Blend(ramp, float64(x)/float64(max(1, track-1)))
		filled := x <= knob
		i, isStop := stopAt[x]
		switch {
		case x == knob:
			line.WriteString(lipgloss.NewStyle().Foreground(c).Bold(true).Render("◉"))
		case isStop && filled:
			line.WriteString(lipgloss.NewStyle().Foreground(c).Render("●"))
		case isStop:
			mark := "○"
			if i == d.current {
				mark = "◌"
			}
			line.WriteString(lipgloss.NewStyle().Foreground(p.Subtle).Render(mark))
		case filled:
			line.WriteString(lipgloss.NewStyle().Foreground(c).Render("━"))
		default:
			line.WriteString(lipgloss.NewStyle().Foreground(p.Border).Render("─"))
		}
	}

	// Labels centred under their stops; when they would collide, alternate between two rows.
	label := func(i int) string {
		if d.stops[i] == "" {
			return "default"
		}
		return d.stops[i]
	}
	spacing := track / max(1, n-1)
	longest := 0
	for i := range d.stops {
		longest = max(longest, len(label(i)))
	}
	rows := 1
	if longest+1 > spacing {
		rows = 2
	}
	labelRows := make([][]rune, rows)
	for r := range labelRows {
		labelRows[r] = []rune(strings.Repeat(" ", track+6))
	}
	type span struct{ row, from, to, stop int }
	var spans []span
	for i := range d.stops {
		l := []rune(label(i))
		r := 0
		if rows == 2 {
			r = i % 2
		}
		from := max(0, min(track+6-len(l), at(float64(i))+3-len(l)/2))
		copy(labelRows[r][from:], l)
		spans = append(spans, span{r, from, from + len(l), i})
	}
	var labels []string
	for r := range labelRows {
		var b strings.Builder
		text := labelRows[r]
		x := 0
		for _, sp := range spans {
			if sp.row != r {
				continue
			}
			b.WriteString(string(text[x:sp.from]))
			st := s.Muted
			switch {
			case sp.stop == d.sel && hot:
				st = lipgloss.NewStyle().Foreground(theme.InfiniCode.Primary).Bold(true)
			case sp.stop == d.sel:
				st = lipgloss.NewStyle().Foreground(p.Accent).Bold(true)
			case sp.stop == d.current:
				st = s.Text
			}
			b.WriteString(st.Render(string(text[sp.from:sp.to])))
			x = sp.to
		}
		b.WriteString(string(text[x:]))
		labels = append(labels, b.String())
	}

	ends := s.Subtle.Render("faster") + strings.Repeat(" ", max(1, track+6-13)) + s.Subtle.Render("smarter")
	name := label(d.sel)
	hint := effortHints[d.stops[d.sel]]
	head := lipgloss.NewStyle().Foreground(p.Accent).Bold(true).Render(name)
	if hot {
		head = lipgloss.NewStyle().Foreground(theme.InfiniCode.Primary).Bold(true).Render("InfiniCode")
	}
	if hint != "" {
		head += s.Muted.Render("  ·  " + hint)
	}
	if d.sel == d.current {
		head += s.Subtle.Render("  (current)")
	}

	body := []string{
		ansi.Truncate(head, inner, "…"),
		"",
		"   " + line.String(),
	}
	body = append(body, labels...)
	body = append(body, "", ends)
	foot := "←→ adjust · 1–9 jump · enter apply"
	return dialogFrame(w, fmt.Sprintf("Effort · %s", d.model), body, foot)
}
