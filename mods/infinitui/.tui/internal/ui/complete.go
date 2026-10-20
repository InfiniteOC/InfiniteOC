package ui

import (
	"path/filepath"
	"strings"
	"time"
	"unicode"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/sahilm/fuzzy"

	"infiniteoc/infinitui/internal/api"
	"infiniteoc/infinitui/internal/theme"
)

type compItem struct {
	label  string
	detail string
	insert string
	kind   string // command | agent | skill | reference | file
	value  string
	name   string
}

type completion struct {
	kind      rune // '/', '@', '#'
	start     int  // rune offset of the trigger
	query     string
	items     []compItem
	cursor    int
	files     []api.FSEntry
	fileQuery string
}

type filesMsg struct {
	query   string
	entries []api.FSEntry
}

// detectTrigger finds an active completion trigger before the cursor.
func detectTrigger(before string) (rune, int, string, bool) {
	r := []rune(before)
	if len(r) > 0 && r[0] == '/' {
		ok := true
		for _, c := range r[1:] {
			if unicode.IsSpace(c) {
				ok = false
				break
			}
		}
		if ok {
			return '/', 0, string(r[1:]), true
		}
	}
	i := len(r) - 1
	for i >= 0 && !unicode.IsSpace(r[i]) {
		i--
	}
	tok := r[i+1:]
	if len(tok) == 0 || (tok[0] != '@' && tok[0] != '#') {
		return 0, 0, "", false
	}
	return tok[0], i + 1, string(tok[1:]), true
}

func (a *App) refreshCompletion() tea.Cmd {
	kind, start, query, ok := detectTrigger(a.prompt.BeforeCursor())
	if !ok {
		a.comp = nil
		return nil
	}
	if a.comp == nil || a.comp.kind != kind || a.comp.start != start {
		a.comp = &completion{kind: kind, start: start}
	}
	c := a.comp
	if c.query != query {
		c.cursor = 0
	}
	c.query = query
	c.build(a)
	if (kind == '@' || kind == '#') && query != "" && query != c.fileQuery {
		c.fileQuery = query
		q := query
		return tea.Tick(120*time.Millisecond, func(time.Time) tea.Msg {
			ctx, cancel := timeout(a.bg(), 5*time.Second)
			defer cancel()
			list, err := a.client.FindFiles(ctx, q, 30)
			if err != nil {
				return nil
			}
			return filesMsg{q, list}
		})
	}
	return nil
}

func (c *completion) setFiles(a *App, m filesMsg) {
	if m.query != c.query {
		return
	}
	c.files = m.entries
	c.build(a)
}

type compSource []compItem

func (c *completion) build(a *App) {
	var pool []compItem
	switch c.kind {
	case '/':
		seen := map[string]bool{}
		for _, lc := range localCommands {
			if lc.hidden {
				continue
			}
			seen[lc.name] = true
			pool = append(pool, compItem{label: "/" + lc.name, detail: lc.title, insert: "/" + lc.name, kind: "command"})
		}
		for _, f := range a.store.features {
			if seen[f.Slash] {
				continue
			}
			seen[f.Slash] = true
			pool = append(pool, compItem{label: "/" + f.Slash, detail: f.Title, insert: "/" + f.Slash, kind: "command"})
		}
		for _, sc := range a.store.commands {
			if seen[sc.Name] {
				continue
			}
			seen[sc.Name] = true
			pool = append(pool, compItem{label: "/" + sc.Name, detail: firstLine(sc.Description), insert: "/" + sc.Name, kind: "command"})
		}
	case '@':
		for _, ag := range a.store.agents {
			if ag.Hidden || ag.Mode == "primary" {
				continue
			}
			pool = append(pool, compItem{label: "@" + ag.ID, detail: "agent · " + firstLine(ag.Description), insert: "@" + ag.ID, kind: "agent", value: ag.ID})
		}
		for _, sk := range a.store.skills {
			pool = append(pool, compItem{label: "@" + sk.ID, detail: "skill · " + firstLine(sk.Description), insert: "@" + sk.ID, kind: "skill", value: sk.ID})
		}
		for _, r := range a.store.references {
			if r.Hidden {
				continue
			}
			pool = append(pool, compItem{label: "@" + r.Name, detail: "reference · " + nonEmpty(r.Description, r.Path), insert: "@" + r.Name, kind: "reference", value: r.Path, name: r.Name})
		}
		pool = append(pool, c.fileItems(a, "@")...)
	case '#':
		pool = c.fileItems(a, "#")
	}
	if c.query == "" {
		c.items = pool
	} else {
		// Match names only. Order: name-prefix hits, then files (ranked by the server), then fuzzy hits.
		var local compSource
		var files []compItem
		for _, it := range pool {
			if it.kind == "file" {
				files = append(files, it)
			} else {
				local = append(local, it)
			}
		}
		names := make([]string, len(local))
		for i, it := range local {
			names[i] = strings.TrimLeft(it.label, "/@#")
		}
		q := strings.ToLower(c.query)
		var prefix, rest []compItem
		for _, m := range fuzzy.Find(c.query, names) {
			it := local[m.Index]
			if strings.HasPrefix(strings.ToLower(names[m.Index]), q) {
				prefix = append(prefix, it)
			} else {
				rest = append(rest, it)
			}
		}
		out := append(prefix, files...)
		c.items = append(out, rest...)
	}
	if c.cursor >= len(c.items) {
		c.cursor = max(0, len(c.items)-1)
	}
}

func (c *completion) fileItems(a *App, prefix string) []compItem {
	if c.query == "" || c.query != c.fileQuery {
		return nil
	}
	var out []compItem
	for _, f := range c.files {
		if strings.Trim(f.Path, "/.") == "" {
			continue
		}
		p := f.Path
		if f.Type == "directory" && !strings.HasSuffix(p, "/") {
			p += "/"
		}
		abs := f.Path
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(a.cwd, f.Path)
		}
		detail := "file"
		if f.Type == "directory" {
			detail = "directory"
		}
		out = append(out, compItem{label: prefix + p, detail: detail, insert: prefix + p, kind: "file", value: abs, name: f.Path})
	}
	return out
}

// key handles navigation keys while the popup is open.
func (c *completion) key(a *App, ks string) (tea.Cmd, bool) {
	if len(c.items) == 0 {
		return nil, false
	}
	switch ks {
	case "up", "ctrl+p":
		c.cursor = (c.cursor - 1 + len(c.items)) % len(c.items)
		return nil, true
	case "down", "ctrl+n":
		c.cursor = (c.cursor + 1) % len(c.items)
		return nil, true
	case "tab":
		return c.accept(a, false), true
	case "enter":
		return c.accept(a, c.kind == '/'), true
	}
	return nil, false
}

func (c *completion) accept(a *App, run bool) tea.Cmd {
	it := c.items[c.cursor]
	var m *mention
	if it.kind != "command" {
		m = &mention{text: it.insert, kind: it.kind, value: it.value, name: nonEmpty(it.name, strings.TrimLeft(it.insert, "@#"))}
	}
	a.prompt.ReplaceRange(c.start, it.insert+" ", m)
	a.comp = nil
	if run {
		cmd := findLocal(strings.TrimPrefix(it.insert, "/"))
		// Commands that take arguments wait for them.
		if cmd != nil && cmd.args != "" {
			return nil
		}
		if cmd == nil && strings.TrimPrefix(it.insert, "/") == "goal" {
			return nil
		}
		return a.submit(a.prompt.Value())
	}
	// A directory keeps completing inside itself.
	if strings.HasSuffix(it.insert, "/") && it.kind == "file" {
		a.prompt.ReplaceRange(len([]rune(a.prompt.BeforeCursor()))-1, "", nil)
		return a.refreshCompletion()
	}
	return nil
}

func compIcon(it compItem) string {
	p := theme.Current
	st := lipgloss.NewStyle()
	switch it.kind {
	case "command":
		return st.Foreground(p.Primary).Render("›")
	case "agent":
		return st.Foreground(p.Accent).Render("◈")
	case "skill":
		return st.Foreground(p.Warning).Render("✦")
	case "reference":
		return st.Foreground(p.Info).Render("◇")
	case "file":
		if strings.HasSuffix(it.insert, "/") {
			return st.Foreground(p.Info).Render("▸")
		}
		return st.Foreground(p.Muted).Render("▤")
	}
	return " "
}

func (c *completion) render(a *App) string {
	p := theme.Current
	s := theme.S
	title := map[rune]string{'/': "commands", '@': "mention", '#': "files"}[c.kind]
	head := lipgloss.NewStyle().Foreground(p.Primary).Bold(true).Render(title)
	if len(c.items) == 0 {
		msg := ""
		switch {
		case c.kind == '#' && c.query == "":
			msg = "Type to search files"
		case c.kind == '#':
			msg = "No matching files"
		case c.kind == '@':
			msg = "No matching agents, skills, references or files"
		default:
			msg = "No matching commands"
		}
		return frame(ansi.StringWidth(msg)+6, p.Border, head, "", []string{s.Subtle.Render(msg)}, "", "")
	}
	w := min(a.contentWidth()-4, 88)
	const rows = 8
	start := 0
	if c.cursor >= rows {
		start = c.cursor - rows + 1
	}
	end := min(len(c.items), start+rows)
	labelW := 0
	for _, it := range c.items[start:end] {
		labelW = max(labelW, ansi.StringWidth(it.label))
	}
	inner := w - 4
	labelW = min(labelW, inner/2)
	var lines []string
	for i := start; i < end; i++ {
		it := c.items[i]
		label := ansi.Truncate(it.label, labelW, "…")
		label += strings.Repeat(" ", labelW-ansi.StringWidth(label))
		detail := ansi.Truncate(it.detail, max(0, inner-labelW-6), "…")
		if i == c.cursor {
			bg := lipgloss.NewStyle().Background(p.PanelAlt)
			row := bg.Render(" ") + compIcon(it) + bg.Render(" ") + bg.Foreground(p.Text).Bold(true).Render(label) + bg.Foreground(p.Muted).Render("  "+detail)
			pad := inner - ansi.StringWidth(row)
			lines = append(lines, row+bg.Render(strings.Repeat(" ", max(0, pad))))
		} else {
			lines = append(lines, " "+compIcon(it)+" "+s.Text.Render(label)+s.Subtle.Render("  "+detail))
		}
	}
	count := ""
	if len(c.items) > rows {
		count = s.Subtle.Render(itoa(c.cursor+1) + "/" + itoa(len(c.items)))
	}
	hint := s.Key.Render("tab") + " " + s.KeyDesc.Render("insert") + "  " + s.Key.Render("↵") + " " + s.KeyDesc.Render(map[bool]string{true: "run", false: "insert"}[c.kind == '/'])
	return frame(w, p.Border, head, count, lines, hint, "")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
