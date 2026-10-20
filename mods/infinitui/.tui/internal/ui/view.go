package ui

import (
	"fmt"
	"math"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/api"
	"infiniteoc/infinitui/internal/theme"
)

type layout struct {
	transcriptTop int
	transcriptH   int
	activityY     int
	boxY          int
	boxH          int
	statusY       int
	box           string // rendered prompt box or card
}

func (a *App) contentWidth() int { return max(20, a.mainWidth()-4) }

// layout measures every region for the current frame.
func (a *App) layout() layout {
	var l layout
	l.box = a.renderBottom()
	l.boxH = lipgloss.Height(l.box)
	l.statusY = a.height
	l.boxY = l.statusY - l.boxH
	l.activityY = l.boxY - 1
	l.transcriptTop = 2
	l.transcriptH = max(1, l.activityY-1-l.transcriptTop)
	return l
}

// rebuild re-renders the transcript for the current width.
func (a *App) rebuild() {
	a.ropts.width = a.contentWidth()
	a.tr.instant = !a.opt.Animations
	a.ropts.now = time.Now().UnixMilli()
	a.ropts.waiting = ""
	if a.running() {
		name := "the model"
		if mm, ok := a.store.Model(a.model); ok {
			name = mm.Name
		}
		a.ropts.waiting = "waiting for " + name + "…"
	}
	d, _ := a.store.Get(a.sessionID)
	a.tr.Build(d, a.ropts)
}

// View draws the frame.
func (a *App) View() tea.View {
	var v tea.View
	v.AltScreen = true
	v.MouseMode = tea.MouseModeAllMotion
	v.ReportFocus = true
	v.BackgroundColor = theme.Current.Bg
	v.WindowTitle = a.windowTitle()
	if a.running() {
		// Tabs and taskbars that understand OSC 9;4 show the agent working.
		v.ProgressBar = tea.NewProgressBar(tea.ProgressBarIndeterminate, 0)
		v.WindowTitle = spinnerFrames[a.frame%len(spinnerFrames)] + " " + v.WindowTitle
	}
	if a.width == 0 || a.height == 0 {
		v.SetContent("")
		return v
	}
	a.prompt.SetWidth(a.contentWidth() - 6)
	l := a.layout()
	a.rebuild()
	a.tr.SetHeight(l.transcriptH)

	rows := make([]string, a.height)
	rows[0] = a.renderHeader()
	if a.home() {
		home := strings.Split(a.renderHome(l.transcriptH), "\n")
		for i, line := range home {
			if l.transcriptTop+i < l.activityY {
				rows[l.transcriptTop+i] = line
			}
		}
	} else {
		top := a.tr.Shown()
		bar := a.scrollbar(l.transcriptH)
		for i, line := range a.tr.View() {
			line = a.highlightSelection(top+i, line)
			if a.hover != "" && a.tr.OwnerAt(i) == a.hover {
				line = lightThread(line)
			}
			rows[l.transcriptTop+i] = line
		}
		if bar != nil {
			mw := a.mainWidth()
			for i := 0; i < l.transcriptH; i++ {
				r := rows[l.transcriptTop+i]
				if w := ansi.StringWidth(r); w < mw-1 {
					r += strings.Repeat(" ", mw-1-w)
				} else if w > mw-1 {
					r = ansi.Truncate(r, mw-1, "")
				}
				rows[l.transcriptTop+i] = r + bar[i]
			}
		}
		if bar := a.scrollIndicator(l); bar != "" {
			rows[l.activityY-1] = bar
		}
	}
	rows[l.activityY] = a.renderActivity()
	for i, line := range strings.Split(l.box, "\n") {
		if l.boxY+i >= 0 && l.boxY+i < a.height {
			rows[l.boxY+i] = "  " + line
		}
	}
	if a.sidebarOn() {
		mw := a.mainWidth()
		side := a.renderSidebar(l.statusY)
		for i := 0; i < l.statusY; i++ {
			r := rows[i]
			if w := ansi.StringWidth(r); w < mw {
				r += strings.Repeat(" ", mw-w)
			} else if w > mw {
				r = ansi.Truncate(r, mw, "")
			}
			rows[i] = r + side[i]
		}
	}
	base := strings.Join(rows, "\n")

	layers := []*lipgloss.Layer{lipgloss.NewLayer(base)}
	if a.comp != nil && a.dialog == nil && a.activePermission() == nil && a.activeForm() == nil {
		if pop := a.comp.render(a); pop != "" {
			h := lipgloss.Height(pop)
			layers = append(layers, lipgloss.NewLayer(pop).X(3).Y(max(0, l.boxY-h)).Z(2))
		}
	}
	if a.dialog != nil {
		layers[0] = lipgloss.NewLayer(dim(base))
		w := min(a.width-4, a.dialog.Width(a.width))
		h := min(a.height-2, 28)
		box := a.dialog.View(w, h)
		bw, bh := lipgloss.Width(box), lipgloss.Height(box)
		layers = append(layers, lipgloss.NewLayer(box).X(max(0, (a.width-bw)/2)).Y(max(0, (a.height-bh)/3)).Z(3))
	}
	if a.toast != nil {
		t := a.toast.render(min(56, a.width-4))
		tw := lipgloss.Width(t)
		x := max(0, a.width-tw-2)
		if a.opt.Animations {
			x += a.toast.slide(tw + 2)
		}
		if x < a.width {
			// Clip what has not slid on screen yet.
			lines := strings.Split(t, "\n")
			for i, l := range lines {
				lines[i] = ansi.Truncate(l, a.width-x, "")
			}
			layers = append(layers, lipgloss.NewLayer(strings.Join(lines, "\n")).X(x).Y(1).Z(4))
		}
	}
	if len(layers) == 1 {
		v.SetContent(base)
	} else {
		v.SetContent(lipgloss.NewCompositor(layers...).Render())
	}

	if a.dialog == nil && a.activePermission() == nil && a.activeForm() == nil {
		if c := a.prompt.Cursor(); c != nil {
			c.Position.X += 2 + 2 + 2 // gutter + border + padding + glyph
			c.Position.Y += l.boxY + 1
			c.Color = theme.Current.Primary
			v.Cursor = c
		}
	}
	a.dirty = false
	return v
}

func (a *App) windowTitle() string {
	if d, ok := a.store.Get(a.sessionID); ok && d.known {
		return "InfiniteOC · " + d.info.DisplayTitle()
	}
	return "InfiniteOC"
}

func (a *App) renderHeader() string {
	s := theme.S
	w := a.mainWidth()
	left := " " + lipgloss.NewStyle().Foreground(theme.Current.Accent).Bold(true).Render("∞") + " "
	if d, ok := a.store.Get(a.sessionID); ok && a.sessionID != "" {
		title := a.headerTitle(d)
		for i, id := range a.trail {
			if pd, ok := a.store.Get(id); ok && i == len(a.trail)-1 {
				left += s.Muted.Render(ansi.Truncate(pd.info.DisplayTitle(), 24, "…")) + s.Subtle.Render(" › ")
			}
		}
		left += s.Bold.Render(ansi.Truncate(a.typedTitle(title), max(10, w/2), "…"))
		if len(a.trail) > 0 {
			left += s.Subtle.Render("  esc back")
		}
		if a.running() {
			left += "  " + spinnerInf(a.frame)
		}
	} else {
		left += theme.Gradient("infiniteoc", theme.Current.Gradient, 0)
	}
	dir := tildify(a.cwd)
	branch := ""
	if b := a.store.vcs.Branch.Current; b != "" {
		branch = s.Subtle.Render(" · ") + s.Muted.Render(b)
	}
	room := w - ansi.StringWidth(left) - ansi.StringWidth(branch) - 4
	if ansi.StringWidth(dir) > room {
		// Keep the end of the path: it names the project.
		r := []rune(dir)
		keep := max(0, room-1)
		if keep < len(r) {
			dir = "…" + string(r[len(r)-keep:])
		}
	}
	right := s.Muted.Render(dir) + branch + " "
	gap := w - ansi.StringWidth(left) - ansi.StringWidth(right)
	if gap < 2 {
		return ansi.Truncate(left, w, "…")
	}
	return left + strings.Repeat(" ", gap) + right
}

func (a *App) scrollIndicator(l layout) string {
	if a.tr.follow || len(a.tr.lines) <= a.tr.height {
		return ""
	}
	below := len(a.tr.lines) - a.tr.Shown() - a.tr.height
	if below <= 0 {
		return ""
	}
	label := fmt.Sprintf(" ↓ %d more lines · end to jump ", below)
	st := lipgloss.NewStyle().Foreground(theme.Current.Text).Background(theme.Current.PanelAlt)
	pad := max(0, (a.mainWidth()-ansi.StringWidth(label))/2)
	return strings.Repeat(" ", pad) + st.Render(label)
}

// activity describes what the agent is doing right now.
func (a *App) activity() (verb string, detail string) {
	d, ok := a.store.Get(a.sessionID)
	if !ok {
		return "", ""
	}
	verb = "Working"
	for i := len(d.msgs) - 1; i >= 0; i-- {
		m := d.msgs[i]
		if m.Type != "assistant" {
			continue
		}
		if len(m.Content) == 0 {
			verb = "Thinking"
			break
		}
		b := m.Content[len(m.Content)-1]
		switch b.Type {
		case "reasoning":
			verb = "Thinking"
		case "text":
			verb = "Writing"
		case "tool":
			c := toolContext(b, 40, false, a.cwd, a.store, 0)
			v := renderTool(c)
			verb = map[string]string{"Read": "Reading", "Update": "Editing", "Write": "Writing", "Bash": "Running", "Search": "Searching", "Grep": "Searching", "Fetch": "Fetching", "Web Search": "Searching the web", "List": "Listing"}[v.title]
			if verb == "" {
				if strings.HasPrefix(v.title, "Task") {
					verb = "Delegating"
				} else {
					verb = "Using " + v.title
				}
			}
			detail = v.arg
		}
		if m.Retry != nil {
			verb = "Retrying"
		}
		break
	}
	return verb, detail
}

func (a *App) renderActivity() string {
	s := theme.S
	if !a.running() {
		if d, ok := a.store.Get(a.sessionID); ok {
			queued := 0
			for _, m := range d.msgs {
				if m.Pending && m.Type == "user" {
					queued++
				}
			}
			if queued > 0 {
				return "  " + s.Subtle.Render(plural(queued, "message", "messages")+" queued")
			}
		}
		if !a.connected && a.everConnected {
			return "  " + s.Error.Render("▲ Connection lost · reconnecting…")
		}
		return ""
	}
	d, _ := a.store.Get(a.sessionID)
	verb, detail := a.activity()
	star := spinnerInf(a.frame)
	parts := []string{}
	started := d.started
	if started == 0 {
		// Joined mid-run: count from the latest prompt.
		for i := len(d.msgs) - 1; i >= 0; i-- {
			if d.msgs[i].Type == "user" && !d.msgs[i].Pending {
				started = d.msgs[i].Time.Created
				break
			}
		}
	}
	if started > 0 && time.Since(time.UnixMilli(started)) >= time.Second {
		parts = append(parts, humanDuration(time.Since(time.UnixMilli(started)).Truncate(time.Second)))
	}
	out := d.info.Tokens.Output + d.info.Tokens.Reasoning - a.tokensAt[a.sessionID]
	// Usage only arrives per step; estimate the tokens streaming right now (~4 bytes each).
	if est := a.streamedEstimate(d); est > out {
		out = est
	}
	if out > 0 {
		parts = append(parts, "↓ "+humanTokens(out)+" tokens")
		if secs := time.Since(time.UnixMilli(started)).Seconds(); started > 0 && secs > 2 && out > 40 {
			parts = append(parts, fmt.Sprintf("%.0f tok/s", out/secs))
		}
	}
	line := "  " + star + " " + shimmer(verb+"…", a.frame)
	if detail != "" {
		line += " " + s.Muted.Render(ansi.Truncate(detail, max(10, a.width/3), "…"))
	}
	if len(parts) > 0 {
		line += s.Subtle.Render("  " + strings.Join(parts, " · "))
	}
	return line
}

// renderBottom draws the composer frame, or the permission/question card that replaces it.
func (a *App) renderBottom() string {
	w := a.contentWidth()
	if card := a.activePermission(); card != nil {
		return card.render(a, w)
	}
	if f := a.activeForm(); f != nil {
		return f.render(a, w)
	}
	p := theme.Current
	edge := p.Primary
	glyph := lipgloss.NewStyle().Foreground(p.Primary).Bold(true).Render("❯")
	if a.prompt.ShellMode() {
		edge = p.Accent
		glyph = lipgloss.NewStyle().Foreground(p.Accent).Bold(true).Render("$")
	} else if a.model.Variant == "infinicode" {
		edge = theme.InfiniCode.Primary
	} else if a.running() {
		edge = p.Border
	}
	switch {
	case a.running():
		a.prompt.SetPlaceholder("Steer it · lands at the next step")
	case a.home():
		a.prompt.SetPlaceholder("What should we build?")
	default:
		a.prompt.SetPlaceholder("Reply, or / for commands")
	}
	var body []string
	for i, l := range strings.Split(a.prompt.View(), "\n") {
		if i == 0 {
			body = append(body, glyph+" "+l)
		} else {
			body = append(body, "  "+l)
		}
	}
	left, right := a.statusLeft(), a.statusRight()
	if len(a.store.models) == 0 {
		label := "loading models…"
		if !a.everConnected {
			label = "connecting…"
		}
		left = spinnerInf(a.frame) + " " + theme.S.Subtle.Render(label)
	}
	hint, hintR := a.composerHints()
	if a.running() && a.opt.Animations {
		return frame(w, edge, left, right, body, hint, hintR, math.Mod(float64(a.frame)*2.5, float64(2*w)))
	}
	return frame(w, edge, left, right, body, hint, hintR)
}

// frame draws a rounded box whose top and bottom borders carry labels. An optional orbit position
// (0..2w) sends a comet of light around the border: along the top, then back along the bottom.
func frame(w int, edge colorT, tl, tr string, body []string, bl, br string, orbit ...float64) string {
	b := lipgloss.NewStyle().Foreground(edge)
	inner := w - 2
	glow := func(x int, top bool) colorT {
		if len(orbit) == 0 {
			return edge
		}
		pos := orbit[0]
		if !top {
			pos = float64(2*w) - pos
		}
		d := math.Abs(float64(x) - pos)
		if (top && orbit[0] >= float64(w)) || (!top && orbit[0] < float64(w)) || d > 10 {
			return edge
		}
		return theme.Blend([]colorT{theme.Current.Accent, edge}, d/10)
	}
	line := func(from, n int, top bool) string {
		if len(orbit) == 0 {
			return b.Render(strings.Repeat("─", n))
		}
		var sb strings.Builder
		for i := 0; i < n; i++ {
			sb.WriteString(lipgloss.NewStyle().Foreground(glow(from+i, top)).Render("─"))
		}
		return sb.String()
	}
	border := func(l, r, left, right string) string {
		top := l == "╭"
		used := 0
		seg := b.Render(l + "─")
		used += 2
		if left != "" {
			seg += " " + left + " "
			used += ansi.StringWidth(left) + 2
		}
		tail := ""
		tailW := 0
		if right != "" {
			tail = " " + right + " "
			tailW = ansi.StringWidth(right) + 2
		}
		fill := w - used - tailW - 2
		if fill < 1 && right != "" {
			tail, tailW = "", 0
			fill = w - used - 2
		}
		if fill < 1 {
			return b.Render(l) + line(1, w-2, top) + b.Render(r)
		}
		return seg + line(used, fill, top) + tail + b.Render("─"+r)
	}
	out := []string{border("╭", "╮", tl, tr)}
	for _, line := range body {
		pad := max(0, inner-2-ansi.StringWidth(line))
		out = append(out, b.Render("│")+" "+line+strings.Repeat(" ", pad)+" "+b.Render("│"))
	}
	out = append(out, border("╰", "╯", bl, br))
	return strings.Join(out, "\n")
}

// statusLeft: who you are talking to.
func (a *App) statusLeft() string {
	s := theme.S
	p := theme.Current
	var parts []string
	agentName, agentColor := a.agent, p.Accent
	if ag, ok := a.store.Agent(a.agent); ok {
		agentName = ag.Label()
		if strings.HasPrefix(ag.Color, "#") {
			agentColor = lipgloss.Color(ag.Color)
		}
	}
	if agentName != "" {
		parts = append(parts, lipgloss.NewStyle().Foreground(agentColor).Bold(true).Render(agentName))
	}
	if !a.model.Empty() {
		name := a.model.ID
		if mm, ok := a.store.Model(a.model); ok {
			name = mm.Name
		}
		m := s.Text.Render(name)
		switch a.model.Variant {
		case "":
		case "infinicode":
			m += " " + lipgloss.NewStyle().Foreground(theme.InfiniCode.Primary).Bold(true).Render("InfiniCode")
		default:
			m += " " + s.Warning.Render(a.model.Variant)
		}
		parts = append(parts, m)
	}
	if a.yolo {
		parts = append(parts, s.Warning.Bold(true).Render("YOLO"))
	}
	if d, ok := a.store.Get(a.sessionID); ok {
		if text, step := goalState(d); step != "" {
			g := s.Accent.Render("◎ goal ") + s.Muted.Render(step)
			if text != "" && !a.sidebarOn() {
				g += s.Subtle.Render(" " + ansi.Truncate(text, 28, "…"))
			}
			parts = append(parts, g)
		}
	}
	return strings.Join(parts, s.Subtle.Render(" · "))
}

// statusRight: how full the context is and what it cost.
func (a *App) statusRight() string {
	s := theme.S
	var parts []string
	if used, limit := a.store.ContextUsage(a.sessionID); used > 0 {
		pct := 0.0
		if limit > 0 {
			pct = used / limit
		}
		parts = append(parts, meter(pct, 10)+" "+s.Muted.Render(pctLabel(pct, used)))
	}
	if d, ok := a.store.Get(a.sessionID); ok && d.info.Cost > 0 {
		parts = append(parts, s.Muted.Render(fmt.Sprintf("$%.2f", d.info.Cost)))
	}
	if !a.connected && a.everConnected {
		parts = append(parts, s.Error.Render("offline"))
	}
	return strings.Join(parts, s.Subtle.Render(" · "))
}

func (a *App) composerHints() (string, string) {
	s := theme.S
	k := func(key, desc string) string { return s.Key.Render(key) + " " + s.KeyDesc.Render(desc) }
	sep := s.Subtle.Render("  ")
	if a.leader {
		return k("ctrl+x", "n new · l sessions · m model · a agent · u undo · r redo · c compact · e editor · b sidebar"), ""
	}
	switch {
	case a.prompt.ShellMode():
		return k("enter", "run in the session shell"), k("esc", "clear")
	case a.running():
		return k("esc", "interrupt") + sep + k("ctrl+b", "background") + sep + k("ctrl+o", "expand"), k("ctrl+p", "commands")
	case a.prompt.Value() != "":
		return k("enter", "send") + sep + k("⇧enter", "newline") + sep + k("ctrl+x e", "editor"), k("ctrl+p", "commands")
	}
	return k("/", "commands") + sep + k("@", "mention") + sep + k("!", "shell") + sep + k("⇧tab", "agent") + sep + k("ctrl+t", "effort"), k("f1", "help")
}

func pctLabel(pct, used float64) string {
	if pct <= 0 {
		return humanTokens(used)
	}
	return fmt.Sprintf("%d%%", int(math.Round(pct*100)))
}

// meter draws a thin bar in the brand gradient, warming to amber and red as it fills.
func meter(pct float64, cells int) string {
	p := theme.Current
	filled := int(math.Round(math.Min(1, pct) * float64(cells)))
	if pct > 0 && filled == 0 {
		filled = 1
	}
	stops := p.Gradient
	switch {
	case pct >= 0.9:
		stops = []colorT{p.Warning, p.Error}
	case pct >= 0.7:
		stops = []colorT{p.Primary, p.Warning}
	}
	var b strings.Builder
	for i := 0; i < cells; i++ {
		if i < filled {
			b.WriteString(lipgloss.NewStyle().Foreground(theme.Blend(stops, float64(i)/float64(max(1, cells-1)))).Render("━"))
		} else {
			b.WriteString(lipgloss.NewStyle().Foreground(p.Border).Render("─"))
		}
	}
	return b.String()
}

// homeLoop is how long the comet keeps circling the mark after start.
const homeLoop = 9 * time.Second

// renderHome is the welcome screen: the mark, then where you are and where you left off.
func (a *App) renderHome(h int) string {
	s := theme.S
	p := theme.Current
	w := a.mainWidth()
	elapsed := time.Since(a.started)
	if !a.opt.Animations {
		elapsed = homeLoop
	}
	var block []string
	if h >= 16 {
		block = append(block, strings.Split(Logo(w-4, elapsed, elapsed < homeLoop), "\n")...)
	} else {
		block = append(block, Wordmark(0))
	}
	ver := a.opt.Version
	if ver == "" {
		ver = "dev"
	}
	block = append(block, s.Subtle.Render("terminal agent · opencode "+ver), "")

	where := s.Muted.Render(tildify(a.cwd))
	if b := a.store.vcs.Branch.Current; b != "" {
		where += s.Subtle.Render(" on ") + lipgloss.NewStyle().Foreground(p.Accent).Render(b)
	}
	block = append(block, where)

	var recent []string
	for _, ss := range a.recentSessions() {
		cap := keycaps(fmt.Sprintf("alt+%d", len(recent)+1), false)
		recent = append(recent, cap+"  "+s.Text.Render(ansi.Truncate(ss.DisplayTitle(), 44, "…"))+s.Subtle.Render("  "+relTime(time.UnixMilli(ss.Time.Updated))))
	}
	// Left-align the list as one block so it centres as a unit.
	rw := 0
	for _, r := range recent {
		rw = max(rw, ansi.StringWidth(r))
	}
	for i, r := range recent {
		recent[i] = r + strings.Repeat(" ", rw-ansi.StringWidth(r))
	}
	if h >= 14 {
		tip := homeTips[int(a.started.UnixNano()/1e6)%len(homeTips)]
		block = append(block, "", s.Subtle.Render("tip · ")+s.Muted.Render(tip))
	}
	if len(recent) > 0 && h >= 22 {
		block = append(block, "", s.Subtle.Render("pick up where you left off · ")+s.Key.Render("ctrl+l"))
		block = append(block, recent...)
	}

	maxW := 0
	for _, l := range block {
		maxW = max(maxW, ansi.StringWidth(l))
	}
	top := max(0, (h-len(block))/2)
	out := make([]string, 0, h)
	for i := 0; i < top; i++ {
		out = append(out, "")
	}
	for _, l := range block {
		pad := max(0, (w-ansi.StringWidth(l))/2)
		out = append(out, strings.Repeat(" ", pad)+l)
	}
	return strings.Join(out, "\n")
}

// wrapJoin joins items with sep, wrapping into lines no wider than width.
func wrapJoin(items []string, sep string, width int) []string {
	var lines []string
	cur := ""
	for _, it := range items {
		cand := it
		if cur != "" {
			cand = cur + sep + it
		}
		if ansi.StringWidth(cand) > width && cur != "" {
			lines = append(lines, cur)
			cur = it
			continue
		}
		cur = cand
	}
	if cur != "" {
		lines = append(lines, cur)
	}
	return lines
}

// applyVariantTheme fades to the InfiniCode palette while that effort level is on.
func (a *App) applyVariantTheme() {
	want := a.basePalette()
	if a.model.Variant == "infinicode" {
		want = theme.InfiniCode
	}
	if a.fadeTo != nil && a.fadeTo.Name == want.Name {
		return
	}
	if theme.Current.Name != want.Name {
		if !a.opt.Animations || a.width == 0 {
			theme.Apply(want)
			a.prompt.styles()
			a.tr.cache = map[string]cachedLines{}
			return
		}
		from := theme.Current
		a.fadeFrom, a.fadeTo, a.fadeStart = &from, &want, time.Now()
	}
}

func (a *App) basePalette() theme.Palette {
	if p, ok := theme.ByName(a.uprefs.Theme); ok && a.uprefs.Theme != "" {
		return p
	}
	if a.lightTerm {
		return theme.Light
	}
	return theme.InfiniteOC
}

var _ = api.Session{}

// dim re-tints a frame in the subtle colour, as a backdrop behind dialogs.
func dim(frame string) string {
	st := lipgloss.NewStyle().Foreground(theme.Current.Subtle)
	lines := strings.Split(frame, "\n")
	for i, l := range lines {
		lines[i] = st.Render(ansi.Strip(l))
	}
	return strings.Join(lines, "\n")
}

// relTime prints "just now", "5m ago", "3h ago", "2d ago".
func relTime(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
	return fmt.Sprintf("%dd ago", int(d.Hours()/24))
}

// streamedEstimate guesses the output tokens of the running turn from what has streamed so far.
func (a *App) streamedEstimate(d *sessionData) float64 {
	var bytes int
	for i := len(d.msgs) - 1; i >= 0; i-- {
		m := d.msgs[i]
		if m.Type == "user" && !m.Pending {
			break
		}
		if m.Type != "assistant" {
			continue
		}
		for _, b := range m.Content {
			bytes += len(b.Text) + len(b.PartialInput)
			if b.State != nil && b.State.Status != "streaming" {
				bytes += len(b.State.Input)
			}
		}
	}
	return float64(bytes) / 4
}

// scrollbar returns one cell per transcript row, or nil when everything fits.
func (a *App) scrollbar(h int) []string {
	total := len(a.tr.lines)
	if total <= h || h < 3 {
		return nil
	}
	p := theme.Current
	thumb := max(1, h*h/total)
	pos := int(math.Round(float64(a.tr.Shown()) / float64(max(1, total-h)) * float64(h-thumb)))
	out := make([]string, h)
	track := lipgloss.NewStyle().Foreground(theme.Blend([]colorT{p.Border, p.Bg}, 0.5)).Render("│")
	marks := map[int]bool{}
	for _, b := range a.tr.BandRows() {
		marks[b*h/total] = true
	}
	tick := lipgloss.NewStyle().Foreground(p.Accent).Render("╴")
	for i := range out {
		out[i] = track
		if marks[i] {
			out[i] = tick
		}
		if i >= pos && i < pos+thumb {
			c := theme.Blend([]colorT{p.Primary, p.Accent}, float64(i-pos)/float64(max(1, thumb-1)))
			out[i] = lipgloss.NewStyle().Foreground(c).Render("┃")
		}
	}
	return out
}

// lightThread brightens the thread segment beside the hovered block.
func lightThread(line string) string {
	plain := ansi.Strip(line)
	r := []rune(plain)
	if len(r) < 3 || (r[2] != '│' && r[2] != '╰') {
		return line
	}
	glyph := "┃"
	if r[2] == '╰' {
		glyph = "┗"
	}
	return ansi.Cut(line, 0, 2) + lipgloss.NewStyle().Foreground(theme.Current.Accent).Bold(true).Render(glyph) + ansi.Cut(line, 3, ansi.StringWidth(line))
}

const fadeLength = 600 * time.Millisecond

// stepFade advances a palette crossfade; it returns whether one is running.
func (a *App) stepFade() bool {
	if a.fadeTo == nil {
		return false
	}
	t := float64(time.Since(a.fadeStart)) / float64(fadeLength)
	if t >= 1 {
		theme.Apply(*a.fadeTo)
		a.fadeFrom, a.fadeTo = nil, nil
	} else {
		ease := t * t * (3 - 2*t)
		theme.Apply(theme.Mix(*a.fadeFrom, *a.fadeTo, ease))
	}
	a.prompt.styles()
	a.tr.cache = map[string]cachedLines{}
	return a.fadeTo != nil
}

var homeTips = []string{
	"click a code block to copy it",
	"click a prompt band to rewind, fork or copy that turn",
	"esc esc opens the timeline: jump, rewind or fork",
	"alt+↑ / alt+↓ jump between turns",
	"a big paste becomes a chip that expands when you send",
	"drag across the transcript to copy text",
	"ctrl+o expands every tool call and thought",
	"ctrl+t cycles effort · /infinicode goes all in",
	"!command runs in the session shell",
	"@file mentions attach a file · #file finds files only",
	"/classic opens this session in the classic interface",
	"ctrl+x b toggles the sidebar and its outline",
}

// typedTitle types a session's title into the header the moment the server names it.
func (a *App) typedTitle(title string) string {
	r := []rune(title)
	if title != a.titleTarget || a.sessionID != a.titleSession {
		named := a.titleTarget == "New session" && a.sessionID == a.titleSession
		a.titleShown = len(r)
		if named && a.opt.Animations {
			a.titleShown = 0
		}
		a.titleTarget, a.titleSession = title, a.sessionID
	}
	if a.titleShown < len(r) {
		a.titleShown += 2
		return string(r[:min(a.titleShown, len(r))]) + "▏"
	}
	return title
}

// headerTitle is the title the header shows for a session.
func (a *App) headerTitle(d *sessionData) string {
	if !d.known && len(d.msgs) == 0 {
		return "New session"
	}
	return d.info.DisplayTitle()
}

// recentSessions are the latest three root sessions of this directory.
func (a *App) recentSessions() []api.Session {
	var out []api.Session
	for _, ss := range a.sessions {
		if ss.ParentID != "" || ss.Location.Directory != a.cwd {
			continue
		}
		out = append(out, ss)
		if len(out) == 3 {
			break
		}
	}
	return out
}
