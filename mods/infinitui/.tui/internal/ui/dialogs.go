package ui

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/api"
	"infiniteoc/infinitui/internal/render"
	"infiniteoc/infinitui/internal/theme"
)

// Dialog is a modal drawn over the app.
type Dialog interface {
	Update(msg tea.Msg) (cmd tea.Cmd, done bool)
	View(w, h int) string
	Width(screen int) int
	Closable() bool
}

// pickerDialog wraps a Picker.
type pickerDialog struct {
	p     *Picker
	width int
}

func (d *pickerDialog) Update(msg tea.Msg) (tea.Cmd, bool) {
	if k, ok := msg.(tea.KeyPressMsg); ok && k.String() == "esc" {
		return nil, true
	}
	if w, ok := msg.(tea.MouseWheelMsg); ok {
		if w.Button == tea.MouseWheelUp {
			d.p.move(-1)
		} else {
			d.p.move(1)
		}
		return nil, false
	}
	return d.p.Update(msg)
}
func (d *pickerDialog) View(w, h int) string { return d.p.Render(w, h) }
func (d *pickerDialog) Width(screen int) int { return min(d.width, screen-4) }
func (d *pickerDialog) Closable() bool       { return true }

// textDialog shows scrollable text.
type textDialog struct {
	title  string
	lines  []string
	offset int
	width  int
}

func (d *textDialog) Update(msg tea.Msg) (tea.Cmd, bool) {
	switch m := msg.(type) {
	case tea.KeyPressMsg:
		switch m.String() {
		case "esc", "q", "enter":
			return nil, true
		case "up", "k":
			d.offset = max(0, d.offset-1)
		case "down", "j":
			d.offset++
		case "pgup":
			d.offset = max(0, d.offset-10)
		case "pgdown", "space":
			d.offset += 10
		}
	case tea.MouseWheelMsg:
		if m.Button == tea.MouseWheelUp {
			d.offset = max(0, d.offset-2)
		} else {
			d.offset += 2
		}
	}
	return nil, false
}

func (d *textDialog) View(w, h int) string {
	s := theme.S
	inner := h - 8
	d.offset = min(d.offset, max(0, len(d.lines)-inner))
	end := min(len(d.lines), d.offset+inner)
	body := d.lines[d.offset:end]
	foot := ""
	if len(d.lines) > inner {
		foot = fmt.Sprintf("%d–%d of %d · ↑↓ scroll", d.offset+1, end, len(d.lines))
	}
	_ = s
	return dialogFrame(w, d.title, body, foot)
}
func (d *textDialog) Width(screen int) int { return min(d.width, screen-4) }
func (d *textDialog) Closable() bool       { return true }

// confirmDialog asks yes/no.
type confirmDialog struct {
	title, text, yes string
	onYes            func() tea.Cmd
	choice           int
}

func newConfirmDialog(title, text, yes string, onYes func() tea.Cmd) *confirmDialog {
	return &confirmDialog{title: title, text: text, yes: yes, onYes: onYes}
}

func (d *confirmDialog) Update(msg tea.Msg) (tea.Cmd, bool) {
	k, ok := msg.(tea.KeyPressMsg)
	if !ok {
		return nil, false
	}
	switch k.String() {
	case "esc", "n":
		return nil, true
	case "left", "right", "tab", "h", "l":
		d.choice = 1 - d.choice
	case "y":
		return d.onYes(), true
	case "enter":
		if d.choice == 0 {
			return d.onYes(), true
		}
		return nil, true
	}
	return nil, false
}

func (d *confirmDialog) View(w, h int) string {
	s := theme.S
	p := theme.Current
	btn := func(label string, on bool) string {
		st := lipgloss.NewStyle().Padding(0, 2).Foreground(p.Muted).Background(p.PanelAlt)
		if on {
			st = st.Foreground(p.Bg).Background(p.Primary).Bold(true)
		}
		return st.Render(label)
	}
	parts := wrapText(d.text, w-6)
	parts = append(parts, "", btn(d.yes, d.choice == 0)+"  "+btn("Cancel", d.choice == 1))
	_ = s
	return dialogFrame(w, d.title, parts, "y yes · n no · ←→ choose")
}
func (d *confirmDialog) Width(screen int) int { return min(64, screen-4) }
func (d *confirmDialog) Closable() bool       { return true }

// inputDialog asks for one line of text.
type inputDialog struct {
	title, hint string
	in          textinput.Model
	onSubmit    func(string) tea.Cmd
}

func newInputDialog(title, hint, value string, onSubmit func(string) tea.Cmd) *inputDialog {
	in := textinput.New()
	in.Prompt = ""
	in.SetValue(value)
	in.CursorEnd()
	in.Focus()
	return &inputDialog{title: title, hint: hint, in: in, onSubmit: onSubmit}
}

func (d *inputDialog) Update(msg tea.Msg) (tea.Cmd, bool) {
	if k, ok := msg.(tea.KeyPressMsg); ok {
		switch k.String() {
		case "esc":
			return nil, true
		case "enter":
			return d.onSubmit(d.in.Value()), true
		}
	}
	var cmd tea.Cmd
	d.in, cmd = d.in.Update(msg)
	return cmd, false
}

func (d *inputDialog) View(w, h int) string {
	s := theme.S
	d.in.SetWidth(w - 8)
	_ = s
	parts := []string{lipgloss.NewStyle().Foreground(theme.Current.Primary).Render("❯ ") + d.in.View()}
	return dialogFrame(w, d.title, parts, nonEmpty(d.hint, "enter save · esc cancel"))
}
func (d *inputDialog) Width(screen int) int { return min(70, screen-4) }
func (d *inputDialog) Closable() bool       { return true }

// --- sessions ---

type sessionDialog struct {
	pickerDialog
	confirmDel string
}

func (a *App) openSessions() tea.Cmd {
	p := NewPicker("Sessions", nil)
	p.Grouped = true
	p.Empty = "Loading…"
	p.Footer = "enter open · ctrl+d delete · ctrl+r rename · ctrl+n new"
	d := &sessionDialog{pickerDialog: pickerDialog{p: p, width: 128}}
	p.Side = func(it PickItem, w, h int) []string { return a.sessionPreview(it.ID, w, h) }
	p.OnPick = func(it PickItem) tea.Cmd {
		if it.ID == "" {
			return nil
		}
		return a.openSession(it.ID, false)
	}
	p.Keys = map[string]func(PickItem) tea.Cmd{
		"ctrl+d": func(it PickItem) tea.Cmd {
			if d.confirmDel != it.ID {
				d.confirmDel = it.ID
				return a.showToast("warning", "", "Press ctrl+d again to delete “"+it.Title+"”", 3*time.Second)
			}
			d.confirmDel = ""
			id := it.ID
			if id == a.sessionID {
				a.sessionID = ""
			}
			return func() tea.Msg {
				if err := a.client.DeleteSession(a.bg(), id); err != nil {
					return errMsg{"delete session", err}
				}
				return a.listSessions()()
			}
		},
		"ctrl+r": func(it PickItem) tea.Cmd {
			id := it.ID
			a.dialog = newInputDialog("Rename session", "", it.Title, func(v string) tea.Cmd {
				return func() tea.Msg {
					if err := a.client.Rename(a.bg(), id, strings.TrimSpace(v)); err != nil {
						return errMsg{"rename", err}
					}
					return nil
				}
			})
			return nil
		},
		"ctrl+n": func(PickItem) tea.Cmd {
			a.dialog = nil
			return a.newSession()
		},
	}
	a.dialog = d
	if len(a.sessions) > 0 {
		d.setSessions(a, a.sessions)
	}
	return a.listSessions()
}

func (a *App) listSessions() tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 10*time.Second)
		defer cancel()
		list, err := a.client.SessionList(ctx, 200, "", true, "")
		if err != nil {
			return errMsg{"list sessions", err}
		}
		return sessionsMsg{list}
	}
}

func dayLabel(t time.Time) string {
	now := time.Now()
	y1, m1, d1 := now.Date()
	y2, m2, d2 := t.Date()
	switch {
	case y1 == y2 && m1 == m2 && d1 == d2:
		return "Today"
	case now.Sub(t) < 48*time.Hour && d1-d2 == 1:
		return "Yesterday"
	case now.Sub(t) < 7*24*time.Hour:
		return t.Format("Monday")
	}
	return t.Format("January 2")
}

func (d *sessionDialog) setSessions(a *App, list []api.Session) {
	sortSessions(list)
	var items []PickItem
	for _, s := range list {
		if s.Time.Archived > 0 {
			continue
		}
		t := time.UnixMilli(s.Time.Updated)
		mark := " "
		if s.ID == a.sessionID {
			mark = "●"
		} else if sd, ok := a.store.Get(s.ID); ok && sd.running {
			mark = "◐"
		} else if s.Time.Idle > 0 && s.Time.Idle > s.Time.Viewed {
			mark = "•"
		}
		dir := ""
		if s.Location.Directory != a.cwd {
			dir = tildify(s.Location.Directory)
		}
		items = append(items, PickItem{ID: s.ID, Title: s.DisplayTitle(), Detail: dir, Right: t.Format("15:04"), Category: dayLabel(t), Mark: mark})
	}
	d.p.Empty = "No sessions yet"
	d.p.SetItems(items)
	d.p.SelectID(a.sessionID)
}

// --- models ---

func (a *App) openModels() tea.Cmd {
	var items []PickItem
	add := func(m api.Model, cat string) {
		mark := " "
		if m.ProviderID == a.model.ProviderID && m.ID == a.model.ID {
			mark = "●"
		}
		right := ""
		if len(m.Cost) > 0 && (m.Cost[0].Input > 0 || m.Cost[0].Output > 0) {
			right = fmt.Sprintf("$%.2g/$%.2g", m.Cost[0].Input, m.Cost[0].Output)
		} else if len(m.Cost) > 0 {
			right = "free"
		}
		if m.Limit.Context > 0 {
			right = contextLabel(m.Limit.Context) + "  " + right
		}
		fav := ""
		if a.mprefs.isFavorite(m.Ref()) {
			fav = "★ "
		}
		detail := ""
		if cat == "Favorites" || cat == "Recent" {
			detail = a.store.ProviderName(m.ProviderID)
		}
		items = append(items, PickItem{ID: m.ProviderID + "/" + m.ID, Title: fav + m.Name, Detail: detail, Right: right, Category: cat, Mark: mark, Value: m.Ref(), Keywords: m.ID + " " + m.ProviderID + " " + a.store.ProviderName(m.ProviderID)})
	}
	seen := map[string]bool{}
	for _, f := range a.mprefs.Favorite {
		if m, ok := a.store.Model(api.ModelRef{ProviderID: f.ProviderID, ID: f.ModelID}); ok {
			add(m, "Favorites")
			seen[m.ProviderID+"/"+m.ID] = true
		}
	}
	for _, r := range a.mprefs.Recent {
		k := r.ProviderID + "/" + r.ModelID
		if seen[k] {
			continue
		}
		if m, ok := a.store.Model(api.ModelRef{ProviderID: r.ProviderID, ID: r.ModelID}); ok {
			add(m, "Recent")
			seen[k] = true
		}
	}
	byProvider := map[string][]api.Model{}
	var provs []string
	for _, m := range a.store.models {
		if seen[m.ProviderID+"/"+m.ID] || m.Status == "deprecated" {
			continue
		}
		if _, ok := byProvider[m.ProviderID]; !ok {
			provs = append(provs, m.ProviderID)
		}
		byProvider[m.ProviderID] = append(byProvider[m.ProviderID], m)
	}
	sort.Strings(provs)
	for _, pid := range provs {
		for _, m := range byProvider[pid] {
			add(m, a.store.ProviderName(pid))
		}
	}
	p := NewPicker("Models", items)
	p.Footer = "enter select · ctrl+f favorite · ctrl+t effort after selecting"
	p.SelectID(a.model.Key())
	p.OnPick = func(it PickItem) tea.Cmd {
		ref := it.Value.(api.ModelRef)
		return a.setModel(ref)
	}
	p.Keys = map[string]func(PickItem) tea.Cmd{
		"ctrl+f": func(it PickItem) tea.Cmd {
			a.mprefs.toggleFavorite(it.Value.(api.ModelRef))
			a.mprefs.save()
			a.dialog = nil
			return a.openModels()
		},
	}
	a.dialog = &pickerDialog{p: p, width: 92}
	return nil
}

func (a *App) openAgents() tea.Cmd {
	var items []PickItem
	for _, ag := range a.store.PrimaryAgents() {
		mark := " "
		if ag.ID == a.agent {
			mark = "●"
		}
		items = append(items, PickItem{ID: ag.ID, Title: ag.Label(), Detail: firstLine(ag.Description), Mark: mark})
	}
	p := NewPicker("Agents", items)
	p.Grouped = false
	p.SelectID(a.agent)
	p.OnPick = func(it PickItem) tea.Cmd {
		a.agent = it.ID
		if ag, ok := a.store.Agent(it.ID); ok && !a.modelSet && ag.Model != nil && a.validModel(*ag.Model) {
			a.model = *ag.Model
		}
		return nil
	}
	a.dialog = &pickerDialog{p: p, width: 70}
	return nil
}

// --- timeline: jump to, rewind to, or fork from a user message ---

func (a *App) openTimeline() tea.Cmd {
	d, ok := a.store.Get(a.sessionID)
	if !ok {
		return nil
	}
	var items []PickItem
	for i := len(d.msgs) - 1; i >= 0; i-- {
		m := d.msgs[i]
		if m.Type != "user" {
			continue
		}
		t := time.UnixMilli(m.Time.Created)
		items = append(items, PickItem{ID: m.ID, Title: ansi.Truncate(strings.ReplaceAll(goalText(m.Text), "\n", " "), 70, "…"), Right: t.Format("15:04"), Value: m})
	}
	p := NewPicker("Timeline", items)
	p.Grouped = false
	p.Empty = "No messages yet"
	p.Footer = "enter jump · ctrl+u rewind here (restores files) · ctrl+f fork from here"
	p.OnPick = func(it PickItem) tea.Cmd {
		a.tr.ScrollToMessage(it.ID)
		return nil
	}
	p.Keys = map[string]func(PickItem) tea.Cmd{
		"ctrl+u": func(it PickItem) tea.Cmd {
			a.dialog = nil
			return a.revertTo(it.Value.(*api.Message))
		},
		"ctrl+f": func(it PickItem) tea.Cmd {
			a.dialog = nil
			return a.forkAt(it.ID)
		},
	}
	a.dialog = &pickerDialog{p: p, width: 90}
	return nil
}

func (a *App) openHistory() tea.Cmd {
	h := a.prompt.History()
	var items []PickItem
	seen := map[string]bool{}
	for i := len(h) - 1; i >= 0; i-- {
		if seen[h[i]] {
			continue
		}
		seen[h[i]] = true
		items = append(items, PickItem{ID: fmt.Sprint(i), Title: strings.ReplaceAll(h[i], "\n", " ⏎ "), Value: h[i]})
	}
	p := NewPicker("Prompt history", items)
	p.Grouped = false
	p.Empty = "No history yet"
	p.OnPick = func(it PickItem) tea.Cmd {
		a.prompt.SetValue(it.Value.(string))
		return nil
	}
	a.dialog = &pickerDialog{p: p, width: 90}
	return nil
}

func (a *App) openHelp() tea.Cmd {
	s := theme.S
	sections := []struct {
		title string
		keys  [][2]string
	}{
		{"Prompt", [][2]string{{"enter", "send (while busy: steer the running agent)"}, {"shift+enter · alt+enter · ctrl+j", "newline (or end a line with \\)"}, {"↑ ↓", "prompt history"}, {"ctrl+r", "search history"}, {"/", "commands"}, {"@ · #", "mention agents, skills, files · files only"}, {"!", "run a shell command"}, {"ctrl+v", "paste, or attach the clipboard image (or paste / drag in an image or PDF path)"}, {"ctrl+x e", "edit in $EDITOR"}}},
		{"Agent", [][2]string{{"esc", "interrupt"}, {"esc esc", "timeline: jump, rewind, fork"}, {"shift+tab", "next agent"}, {"ctrl+t", "next effort level"}, {"ctrl+x v", "effort slider (/effort)"}, {"f2", "models"}, {"ctrl+b", "background the running tool"}}},
		{"View", [][2]string{{"ctrl+o", "expand all tool output"}, {"click", "expand one block · open a subagent"}, {"pgup pgdn · shift+↑↓ · wheel", "scroll"}, {"home end", "top / bottom (empty prompt)"}, {"ctrl+x →  ctrl+x ←", "into subagent · back"}}},
		{"App", [][2]string{{"ctrl+p", "command palette"}, {"ctrl+l", "sessions"}, {"ctrl+n", "new session"}, {"ctrl+y", "copy last response"}, {"ctrl+x", "leader: n l m a v u r c y e t g s x q"}, {"ctrl+c ctrl+c · ctrl+d", "exit"}}},
	}
	var lines []string
	for i, sec := range sections {
		if i > 0 {
			lines = append(lines, "")
		}
		lines = append(lines, s.Accent.Bold(true).Render(sec.title))
		for _, k := range sec.keys {
			var caps []string
			for _, alt := range strings.Split(k[0], " · ") {
				caps = append(caps, keycaps(alt, false))
			}
			key := strings.Join(caps, s.Subtle.Render(" or "))
			pad := max(1, 44-ansi.StringWidth(key))
			lines = append(lines, "  "+key+strings.Repeat(" ", pad)+s.Muted.Render(k[1]))
		}
	}
	a.dialog = &textDialog{title: "Keys", lines: lines, width: 96}
	return nil
}

func (a *App) openStatus() tea.Cmd {
	s := theme.S
	p := theme.Current
	const w = 80
	var lines []string
	section := func(title, value string) {
		if len(lines) > 0 {
			lines = append(lines, "")
		}
		label := lipgloss.NewStyle().Foreground(p.Accent).Bold(true).Render(strings.ToUpper(title))
		dots := w - ansi.StringWidth(label) - ansi.StringWidth(value) - 2
		line := label + " " + lipgloss.NewStyle().Foreground(p.Border).Render(strings.Repeat("·", max(1, dots)))
		if value != "" {
			line += " " + value
		}
		lines = append(lines, line)
	}
	row := func(k, v string) {
		v = ansi.Truncate(v, w-14, "…")
		lines = append(lines, s.Subtle.Render(fmt.Sprintf("%-12s", k))+strings.Repeat(" ", max(1, w-12-ansi.StringWidth(v)))+s.Text.Render(v))
	}
	conn := s.Success.Render("● connected")
	if !a.connected {
		conn = s.Error.Render("● disconnected")
	}
	section("Server", conn)
	row("url", a.client.BaseURL)
	row("version", a.opt.Version)
	row("directory", tildify(a.cwd))
	row("branch", nonEmpty(a.store.vcs.Branch.Current, "—"))
	if d, ok := a.store.Get(a.sessionID); ok && a.sessionID != "" {
		section("Session", s.Text.Render(fmt.Sprintf("$%.4f", d.info.Cost)))
		row("title", d.info.DisplayTitle())
		row("id", a.sessionID)
		t := d.info.Tokens
		row("input", humanTokens(t.Input)+" · cache "+humanTokens(t.Cache.Read)+" read / "+humanTokens(t.Cache.Write)+" write")
		row("output", humanTokens(t.Output)+" · reasoning "+humanTokens(t.Reasoning))
		if used, limit := a.store.ContextUsage(a.sessionID); used > 0 {
			pct := 0.0
			if limit > 0 {
				pct = used / limit
			}
			lines = append(lines, s.Subtle.Render(fmt.Sprintf("%-12s", "context"))+meter(pct, w-24)+" "+s.Text.Render(fmt.Sprintf("%10s", humanTokens(used)+"/"+humanTokens(limit))))
		}
	}
	ok := 0
	for _, m := range a.store.mcp {
		if m.Status.Status == "connected" {
			ok++
		}
	}
	section("MCP servers", s.Text.Render(fmt.Sprintf("%d/%d", ok, len(a.store.mcp))))
	if len(a.store.mcp) == 0 {
		lines = append(lines, s.Subtle.Render("none configured · /apps adds some"))
	}
	for _, m := range a.store.mcp {
		c := s.Muted
		switch m.Status.Status {
		case "connected":
			c = s.Success
		case "failed", "needs_auth":
			c = s.Error
		case "pending":
			c = s.Warning
		}
		line := c.Render("● ") + s.Text.Render(m.Name) + s.Subtle.Render("  "+m.Status.Status)
		if m.Status.Error != "" {
			line += s.Error.Render("  " + ansi.Truncate(m.Status.Error, 40, "…"))
		}
		lines = append(lines, line)
	}
	a.dialog = &textDialog{title: "Status", lines: lines, width: w + 8}
	return nil
}

// --- InfiniteOC server-built views (mods/webui views.ts) ---

type rpcViewMsg struct {
	feature string
	view    api.RPCView
	err     error
}

func (a *App) runFeature(feature, action, value string) tea.Cmd {
	sid := a.sessionID
	return func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 20*time.Second)
		defer cancel()
		v, err := a.client.RunFeature(ctx, feature, action, value, sid)
		return rpcViewMsg{feature, v, err}
	}
}

func (a *App) showRPCView(m rpcViewMsg) tea.Cmd {
	if m.err != nil {
		return a.showToast("error", "/"+m.feature, m.err.Error(), 5*time.Second)
	}
	var cmds []tea.Cmd
	if m.view.Toast != nil {
		cmds = append(cmds, a.showToast(m.view.Toast.Variant, "", m.view.Toast.Message, 4*time.Second))
	}
	v := m.view
	if len(v.Items) == 0 && len(v.Actions) == 0 && v.Input == nil {
		lines := render.Markdown(v.Text, 80)
		if strings.TrimSpace(v.Text) == "" {
			lines = []string{theme.S.Subtle.Render("Nothing to show.")}
		}
		a.dialog = &textDialog{title: v.Title, lines: lines, width: 92}
		return tea.Batch(cmds...)
	}
	var items []PickItem
	for _, it := range v.Items {
		items = append(items, PickItem{ID: it.ID, Title: it.Title, Detail: it.Description, Category: "Items"})
	}
	for _, it := range v.Actions {
		title := it.Title
		if it.ID == "" {
			title = "‹ " + title
		}
		items = append(items, PickItem{ID: "\x00" + it.ID, Title: title, Detail: it.Description, Category: "Actions"})
	}
	p := NewPicker(v.Title, items)
	if v.Text != "" {
		p.Footer = ansi.Truncate(strings.ReplaceAll(v.Text, "\n", " "), 160, "…")
	}
	if v.Input != nil {
		p.input.Placeholder = v.Input.Placeholder + " · enter on an empty match submits it"
		if v.Input.Value != "" {
			p.input.SetValue(v.Input.Value)
		}
	}
	feature := m.feature
	in := v.Input
	p.OnPick = func(it PickItem) tea.Cmd {
		return a.runFeature(feature, strings.TrimPrefix(it.ID, "\x00"), "")
	}
	d := &rpcDialog{pickerDialog: pickerDialog{p: p, width: 92}, submit: func(val string) tea.Cmd {
		if in == nil {
			return nil
		}
		return a.runFeature(feature, in.Action, val)
	}}
	a.dialog = d
	return tea.Batch(cmds...)
}

// rpcDialog submits typed text when the filter matches nothing.
type rpcDialog struct {
	pickerDialog
	submit func(string) tea.Cmd
}

func (d *rpcDialog) Update(msg tea.Msg) (tea.Cmd, bool) {
	if k, ok := msg.(tea.KeyPressMsg); ok && k.String() == "enter" {
		if _, has := d.p.Current(); !has && strings.TrimSpace(d.p.Query()) != "" {
			return d.submit(d.p.Query()), true
		}
	}
	return d.pickerDialog.Update(msg)
}

// contextLabel prints a context window as 200k / 1M.
func contextLabel(n float64) string {
	switch {
	case n >= 1e6:
		return strings.TrimSuffix(fmt.Sprintf("%.1f", n/1e6), ".0") + "M"
	case n >= 1e3:
		return fmt.Sprintf("%.0fk", n/1e3)
	}
	return fmt.Sprintf("%.0f", n)
}

// dialogFrame draws a modal in the composer's language: title and esc in the top border, hints at the bottom.
func dialogFrame(w int, title string, body []string, footer string) string {
	s := theme.S
	lines := []string{""}
	for _, l := range body {
		lines = append(lines, " "+l)
	}
	lines = append(lines, "")
	foot := ""
	if footer != "" {
		foot = s.Subtle.Render(ansi.Truncate(footer, w-8, "…"))
	}
	return frame(w, theme.Current.BorderHot, s.DialogTitle.Render(title), s.Subtle.Render("esc"), lines, foot, "")
}

// sessionPreview shows the latest exchange of a session, fetched on first view.
func (a *App) sessionPreview(id string, w, h int) []string {
	s := theme.S
	p := theme.Current
	if id == "" {
		return nil
	}
	d, ok := a.store.Get(id)
	if !ok || (!d.loaded && len(d.msgs) == 0) {
		return []string{s.Subtle.Render("loading…")}
	}
	var out []string
	if d.known {
		out = append(out, s.Bold.Render(ansi.Truncate(d.info.DisplayTitle(), w, "…")))
		meta := relTime(time.UnixMilli(d.info.Time.Updated))
		if d.info.Cost > 0 {
			meta += fmt.Sprintf(" · $%.2f", d.info.Cost)
		}
		if t := d.info.Tokens.Output + d.info.Tokens.Input; t > 0 {
			meta += " · " + humanTokens(t) + " tokens"
		}
		out = append(out, s.Subtle.Render(meta), "")
	}
	// Walk back to the last prompt and show it with the reply that followed.
	var prompt *api.Message
	reply := ""
	for i := len(d.msgs) - 1; i >= 0 && prompt == nil; i-- {
		m := d.msgs[i]
		switch m.Type {
		case "user":
			prompt = m
		case "assistant":
			for j := len(m.Content) - 1; j >= 0; j-- {
				if b := m.Content[j]; b.Type == "text" && strings.TrimSpace(b.Text) != "" && reply == "" {
					reply = strings.TrimSpace(b.Text)
				}
			}
		}
	}
	if prompt != nil {
		badge := lipgloss.NewStyle().Background(p.Accent).Foreground(p.Bg).Bold(true).Render(" ❯ ")
		for i, l := range firstN(wrapText(goalText(prompt.Text), w-4), 4) {
			if i == 0 {
				out = append(out, badge+" "+s.Text.Bold(true).Render(l))
			} else {
				out = append(out, "    "+s.Text.Bold(true).Render(l))
			}
		}
		out = append(out, "")
	}
	if reply != "" {
		for _, l := range render.Rich(reply, w-2, false) {
			out = append(out, lipgloss.NewStyle().Foreground(p.Primary).Render("│ ")+l)
		}
	}
	if len(out) > h {
		out = append(out[:h-1], s.Subtle.Render("…"))
	}
	return out
}

func (a *App) loadPreview(id string) tea.Cmd {
	return tea.Batch(a.fetchSession(id), func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 10*time.Second)
		defer cancel()
		msgs, next, err := a.client.Messages(ctx, id, 12, "")
		if err != nil {
			return nil
		}
		return historyMsg{sessionID: id, msgs: msgs, older: next, preview: true}
	})
}
