package ui

import (
	"context"
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

// The fleet panel (ctrl+f, /fleet) shows the session's workflows (mods/workflows) as a grid of
// live cards, one per step, in place of the transcript. The prompt stays usable below it. It is
// fed by the workflows RPC once a second while it is open, and opens by itself when a workflow
// starts (the server's "Workflow" toast).
type fleet struct {
	open    bool
	polling bool
	wfs     []api.Workflow
	changed map[string]time.Time // "<wf>/<step>" -> when its status last changed, for the finish flash
	status  map[string]string
	hits    []fleetHit
	cells   map[string]string            // group key -> the cells of the previous answer
	flash   map[string]map[int]time.Time // group key -> cell index -> when it finished
}

type fleetHit struct {
	x0, x1, y0, y1 int
	sessionID      string
}

type fleetMsg struct {
	wfs []api.Workflow
	err error
}

type fleetPollMsg struct{}

const fleetCardMin = 34

func (a *App) fleetRoot() string {
	if len(a.trail) > 0 {
		return a.trail[0]
	}
	return a.sessionID
}

func (a *App) toggleFleet() tea.Cmd {
	a.fleet.open = !a.fleet.open
	if a.fleet.open {
		return a.pollFleet()
	}
	return nil
}

func (a *App) openFleet() tea.Cmd {
	if a.fleet.open {
		return nil
	}
	return a.toggleFleet()
}

// fleetCommand runs /fleet [on | off | swarm <n> | preset <name> | claude <mode> | parallel <n> | fast|strong|default <models>].
func (a *App) fleetCommand(args string) tea.Cmd {
	f := strings.Fields(args)
	if len(f) == 0 {
		return a.toggleFleet()
	}
	if f[0] == "on" || f[0] == "off" {
		f = []string{"fleet", f[0]}
	}
	key := map[string]string{"fleet": "fleet", "preset": "preset", "claude": "claudeMode", "parallel": "maxParallel", "workers": "claudeParallel", "swarm": "swarmSize", "fast": "models.fast", "strong": "models.strong", "default": "models.default"}[f[0]]
	if key == "" || len(f) < 2 {
		return a.showToast("info", "Fleet", "/fleet toggles the panel · on|off: the agent delegates its work to workflows · preset turbo|free-cc|free|cc|auto · claude readonly|auto|bypass · parallel 1-64 · workers 1-16 · swarm 2-64 (agents per swarm) · fast|strong|default <model>[, <model>…]", 8*time.Second)
	}
	// A pool is several models separated by commas: "a/x, b/y".
	value := strings.Join(f[1:], " ")
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(a.ctx, 5*time.Second)
		defer cancel()
		if err := a.client.WorkflowSet(ctx, key, value); err != nil {
			return errMsg{op: "/fleet " + f[0], err: err}
		}
		return toastMsg{variant: "success", title: "Fleet", text: f[0] + " → " + value, d: 4 * time.Second}
	}
}

func (a *App) pollFleet() tea.Cmd {
	id := a.fleetRoot()
	if a.fleet.polling || id == "" {
		return nil
	}
	a.fleet.polling = true
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(a.ctx, 5*time.Second)
		defer cancel()
		wfs, err := a.client.Workflows(ctx, id)
		return fleetMsg{wfs, err}
	}
}

func (a *App) fleetResult(m fleetMsg) tea.Cmd {
	a.fleet.polling = false
	if m.err == nil {
		if a.fleet.changed == nil {
			a.fleet.changed, a.fleet.status = map[string]time.Time{}, map[string]string{}
		}
		if a.fleet.cells == nil {
			a.fleet.cells, a.fleet.flash = map[string]string{}, map[string]map[int]time.Time{}
		}
		for _, wf := range m.wfs {
			for _, st := range wf.Steps {
				k := wf.ID + "/" + st.ID
				if st.Group {
					prev, fl := a.fleet.cells[k], a.fleet.flash[k]
					if fl == nil {
						fl = map[int]time.Time{}
						a.fleet.flash[k] = fl
					}
					for i := 0; i < len(st.Cells) && i < len(prev); i++ {
						if prev[i] != st.Cells[i] && (st.Cells[i] == 'c' || st.Cells[i] == 'f') {
							fl[i] = time.Now()
						}
					}
					for i, at := range fl {
						if time.Since(at) > time.Second {
							delete(fl, i)
						}
					}
					a.fleet.cells[k] = st.Cells
				}
				if prev, ok := a.fleet.status[k]; ok && prev != st.Status {
					a.fleet.changed[k] = time.Now()
				}
				a.fleet.status[k] = st.Status
			}
		}
		a.fleet.wfs = m.wfs
	}
	if !a.fleet.open && !a.fleetRunning() {
		return nil
	}
	// Four answers a second while agents run, so a finished step shows at once; once a second otherwise.
	every := time.Second
	if a.fleetRunning() {
		every = 250 * time.Millisecond
	}
	return tea.Batch(a.tick(), tea.Tick(every, func(time.Time) tea.Msg { return fleetPollMsg{} }))
}

func (a *App) fleetRunning() bool {
	for _, wf := range a.fleet.wfs {
		if wf.Status == "running" {
			return true
		}
	}
	return false
}

// fleetClick opens the session of the OpenCode step under the pointer; it reports whether the
// click landed in the panel.
func (a *App) fleetClick(x, y int) (tea.Cmd, bool) {
	if !a.fleet.open {
		return nil, false
	}
	for _, h := range a.fleet.hits {
		if x >= h.x0 && x < h.x1 && y >= h.y0 && y < h.y1 && h.sessionID != "" {
			a.fleet.open = false
			return a.enterChild(h.sessionID), true
		}
	}
	return nil, y >= 2 && x < a.mainWidth()
}

func fmtElapsed(ms int64) string {
	s := max(0, ms/1000)
	if s >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", s/3600, s/60%60, s%60)
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}

func shortModel(m string) string {
	if strings.HasPrefix(m, "claude-code/") {
		return "cc/" + strings.TrimPrefix(m, "claude-code/")
	}
	if i := strings.Index(m, "/"); i >= 0 {
		return m[i+1:]
	}
	if m == "" {
		return "default"
	}
	return m
}

// fit pads or truncates s to exactly w cells.
func fit(s string, w int) string {
	if n := ansi.StringWidth(s); n < w {
		return s + strings.Repeat(" ", w-n)
	}
	return ansi.Truncate(s, w, "…")
}

// renderFleet draws the panel into a w×h region whose top row is screen row y0.
func (a *App) renderFleet(w, h, y0 int) []string {
	s := theme.S
	p := theme.Current
	a.fleet.hits = nil
	out := make([]string, 0, h)
	now := time.Now().UnixMilli()
	phase := float64(a.frame) * 0.015
	if !a.opt.Animations {
		phase = 0
	}

	if len(a.fleet.wfs) == 0 {
		title := lipgloss.NewStyle().Bold(true).Render(theme.Gradient("◆ FLEET", p.Gradient, phase))
		out = append(out, "  "+title, "",
			"  "+s.Muted.Render("No workflows in this session in the last 15 minutes."),
			"  "+s.Subtle.Render("Ask for parallel work (\"research X and Y in parallel, then review\") and the steps appear here."),
			"  "+s.Subtle.Render("/fleet on: the agent hands its work to workflows instead of doing it itself"),
			"  "+s.Subtle.Render("Models per step: /fleet preset turbo · free-cc · free · cc · auto      esc or ctrl+f closes"))
		return out
	}

	cols := max(1, (w-2)/(fleetCardMin+1))
	cw := (w-2)/cols - 1
	for _, wf := range a.fleet.wfs {
		if len(out) >= h-1 {
			break
		}
		// Count agents, not entries: a fan-out group is one entry with a cell per item.
		done, total := 0, 0
		for _, st := range wf.Steps {
			if st.Group {
				done += strings.Count(st.Cells, "c")
				total += len(st.Cells)
			} else if total++; st.Status == "completed" {
				done++
			}
		}
		end := wf.EndedAt
		if end == 0 {
			end = now
		}
		head := "◆ " + strings.ToUpper(wf.Name)
		if wf.Status == "running" {
			head = lipgloss.NewStyle().Bold(true).Render(theme.Gradient(head, p.Gradient, phase))
		} else {
			head = s.Muted.Bold(true).Render(head)
		}
		meta := s.Subtle.Render(fmt.Sprintf("  %d/%d done · %s · %s", done, total, fmtElapsed(end-wf.CreatedAt), wf.Status))
		if len(out) > 0 {
			out = append(out, "")
		}
		out = append(out, "  "+head+meta)

		// Small cards fill rows; a fan-out group takes a full-width card of its own.
		var row [][]string
		var rowSteps []api.WorkflowStep
		full := false
		flush := func() {
			if len(row) == 0 {
				return
			}
			if len(out)+5 > h {
				full = true
				return
			}
			for k, st := range rowSteps {
				x0 := 2 + k*(cw+1)
				a.fleet.hits = append(a.fleet.hits, fleetHit{x0, x0 + cw, y0 + len(out), y0 + len(out) + 5, st.SessionID})
			}
			for line := 0; line < 5; line++ {
				parts := make([]string, len(row))
				for k, c := range row {
					parts[k] = c[line]
				}
				out = append(out, "  "+strings.Join(parts, " "))
			}
			row, rowSteps = nil, nil
		}
		for j, st := range wf.Steps {
			if full {
				break
			}
			if st.Group {
				flush()
				card := a.fleetGroup(wf, st, w-2, h-len(out), now)
				if len(card) == 0 {
					full = true
					break
				}
				for _, line := range card {
					out = append(out, "  "+line)
				}
				continue
			}
			row = append(row, a.fleetCard(wf, st, j, cw, now))
			rowSteps = append(rowSteps, st)
			if len(row) == cols {
				flush()
			}
		}
		flush()
		if full && len(out) < h {
			out = append(out, "  "+s.Subtle.Render("… more steps below; widen the terminal or see /workflows"))
		}
	}
	return out
}

// fleetCard is one step: a 5-row box whose border breathes while it runs and flashes when it ends.
func (a *App) fleetCard(wf api.Workflow, st api.WorkflowStep, i, w int, now int64) []string {
	s := theme.S
	p := theme.Current
	inner := w - 4
	t := float64(a.frame)*0.12 + float64(i)*0.9
	if !a.opt.Animations {
		t = 0
	}

	border := p.Border
	var glyph, label string
	switch st.Status {
	case "running":
		border = theme.Blend([]colorT{p.Primary, p.Accent}, 0.5+0.5*math.Sin(t))
		glyph = lipgloss.NewStyle().Foreground(p.Accent).Render(spinnerFrames[(a.frame+i*3)%len(spinnerFrames)])
		label = s.Text.Render("running")
	case "completed":
		border = p.Success
		glyph, label = s.Success.Render("✓"), s.Success.Render("done")
	case "failed":
		border = p.Error
		glyph, label = s.Error.Render("✗"), s.Error.Render("failed")
	case "pending":
		glyph, label = s.Subtle.Render("◌"), s.Subtle.Render("waiting")
		if len(st.Needs) > 0 {
			label = s.Subtle.Render("waiting on " + strings.Join(st.Needs, ", "))
		}
	default: // skipped, cancelled
		glyph, label = s.Subtle.Render("■"), s.Subtle.Render(st.Status)
	}
	if at, ok := a.fleet.changed[wf.ID+"/"+st.ID]; ok && a.opt.Animations {
		if d := time.Since(at); d < 700*time.Millisecond && st.Status != "running" {
			border = theme.Blend([]colorT{p.Text, border}, float64(d)/float64(700*time.Millisecond))
		}
	}
	bc := lipgloss.NewStyle().Foreground(border)

	// ╭─ title ───── model ─╮
	title := st.Title
	if title == "" {
		title = st.ID
	}
	model := ansi.Truncate(shortModel(st.Model), max(6, inner/2-1), "…")
	title = ansi.Truncate(title, max(4, w-8-ansi.StringWidth(model)), "…")
	fill := max(1, w-7-ansi.StringWidth(title)-ansi.StringWidth(model))
	top := bc.Render("╭─ ") + s.Text.Bold(true).Render(title) + bc.Render(" "+strings.Repeat("─", fill)+" ") +
		s.Muted.Render(model) + bc.Render(" ╮")
	top = fit(top, w)

	elapsed := ""
	if st.StartedAt > 0 {
		end := st.EndedAt
		if end == 0 {
			end = now
		}
		elapsed = s.Subtle.Render(fmtElapsed(end - st.StartedAt))
	}
	line1 := glyph + " " + label
	line1 = fit(line1, max(0, inner-ansi.StringWidth(elapsed))) + elapsed

	var line2 string
	switch {
	case st.Status == "failed" && st.Error != "":
		line2 = s.Error.Render(st.Error)
	case st.Activity != nil && st.Status == "running" && st.Activity.Tool != "":
		detail := tildify(strings.TrimPrefix(st.Activity.Detail, a.cwd+"/"))
		line2 = lipgloss.NewStyle().Foreground(p.Info).Render(st.Activity.Tool) + "  " + s.Muted.Render(detail)
	case st.Status == "completed" && st.Result != "":
		line2 = s.Muted.Render(st.Result)
	case st.Activity != nil && st.Activity.Text != "":
		line2 = s.Muted.Render(st.Activity.Text)
	case st.Status == "running":
		line2 = s.Subtle.Render("thinking…")
	}

	tools := ""
	if st.Activity != nil && st.Activity.Tools > 0 {
		tools = s.Subtle.Render(" " + plural(st.Activity.Tools, "tool", "tools"))
	}
	line3 := a.fleetBar(st.Status, inner-ansi.StringWidth(tools), i) + tools

	side := bc.Render("│")
	body := func(x string) string { return side + " " + fit(x, inner) + " " + side }
	bottom := bc.Render("╰" + strings.Repeat("─", max(0, w-2)) + "╯")
	return []string{top, body(line1), body(line2), body(line3), bottom}
}

// fleetBar is a progress strip: a comet sweeping across while running, full when done.
func (a *App) fleetBar(status string, w, i int) string {
	p := theme.Current
	if w <= 0 {
		return ""
	}
	var b strings.Builder
	switch status {
	case "running":
		span := w + 8
		pos := (a.frame*2 + i*7) % span
		if !a.opt.Animations {
			pos = w / 2
		}
		for x := 0; x < w; x++ {
			d := pos - 4 - x
			if d >= 0 && d < 6 {
				c := theme.Blend([]colorT{p.Accent, p.Primary, p.Border}, float64(d)/6)
				b.WriteString(lipgloss.NewStyle().Foreground(c).Render("▰"))
			} else {
				b.WriteString(lipgloss.NewStyle().Foreground(p.Border).Render("▱"))
			}
		}
	case "completed":
		b.WriteString(lipgloss.NewStyle().Foreground(p.Success).Render(strings.Repeat("▰", w)))
	case "failed":
		b.WriteString(lipgloss.NewStyle().Foreground(p.Error).Render(strings.Repeat("▰", w)))
	default:
		b.WriteString(lipgloss.NewStyle().Foreground(p.Border).Render(strings.Repeat("▱", w)))
	}
	return b.String()
}

// fleetGroup is a fan-out group: a summary line with throughput and ETA, a grid with one cell per
// item (a spinner while it runs, a dot when done, a cross when it failed; cells flash as they finish),
// and the running members' current tools. A grid too big for the space buckets several items per cell.
func (a *App) fleetGroup(wf api.Workflow, st api.WorkflowStep, w, room int, now int64) []string {
	s := theme.S
	p := theme.Current
	inner := w - 4
	n := len(st.Cells)
	if room < 5 || inner < 10 || n == 0 {
		return nil
	}
	tally := map[byte]int{}
	for i := 0; i < n; i++ {
		tally[st.Cells[i]]++
	}
	done := tally['c']
	finished := done + tally['f'] + tally['s'] + tally['x']

	border := p.Border
	switch st.Status {
	case "running":
		border = theme.Blend([]colorT{p.Primary, p.Accent}, 0.5+0.5*math.Sin(float64(a.frame)*0.12))
	case "completed":
		border = p.Success
	case "failed":
		border = p.Error
	}
	bc := lipgloss.NewStyle().Foreground(border)

	models := strings.Split(st.Model, ", ")
	for i, m := range models {
		models[i] = shortModel(m)
	}
	model := ansi.Truncate(strings.Join(models, ", "), max(6, inner/2), "…")
	title := ansi.Truncate(fmt.Sprintf("%s ×%d", nonEmpty(st.Title, st.ID), n), max(4, w-8-ansi.StringWidth(model)), "…")
	fill := max(1, w-7-ansi.StringWidth(title)-ansi.StringWidth(model))
	top := fit(bc.Render("╭─ ")+s.Text.Bold(true).Render(title)+bc.Render(" "+strings.Repeat("─", fill)+" ")+s.Muted.Render(model)+bc.Render(" ╮"), w)

	// Summary: progress, running, failures, rate and time left.
	parts := []string{s.Text.Render(fmt.Sprintf("%d/%d done", done, n))}
	if r := tally['r']; r > 0 {
		parts = append(parts, lipgloss.NewStyle().Foreground(p.Accent).Render(fmt.Sprintf("%d running", r)))
	}
	if f := tally['f']; f > 0 {
		parts = append(parts, s.Error.Render(fmt.Sprintf("%d failed", f)))
	}
	elapsed := ""
	if st.StartedAt > 0 {
		end := st.EndedAt
		if end == 0 {
			end = now
		}
		secs := float64(end-st.StartedAt) / 1000
		elapsed = s.Subtle.Render(fmtElapsed(end - st.StartedAt))
		if finished > 0 && secs > 0 {
			rate := float64(finished) / secs
			parts = append(parts, s.Subtle.Render(fmt.Sprintf("%.1f/s", rate)))
			if left := n - finished; left > 0 && st.EndedAt == 0 {
				parts = append(parts, s.Subtle.Render("~"+fmtElapsed(int64(float64(left)/rate*1000))+" left"))
			}
		}
	}
	glyph := s.Success.Render("✓")
	switch st.Status {
	case "running":
		glyph = lipgloss.NewStyle().Foreground(p.Accent).Render(spinnerFrames[a.frame%len(spinnerFrames)])
	case "pending":
		glyph = s.Subtle.Render("◌")
		if len(st.Needs) > 0 {
			parts = append(parts, s.Subtle.Render(fmt.Sprintf("waiting on %d steps", len(st.Needs))))
		}
	case "failed":
		glyph = s.Error.Render("✗")
	case "cancelled":
		glyph = s.Subtle.Render("■")
	}
	summary := glyph + " " + strings.Join(parts, s.Subtle.Render(" · "))
	summary = fit(summary, max(0, inner-ansi.StringWidth(elapsed))) + elapsed

	// Grid rows: what fits after the frame, the summary and up to 3 running members.
	members := min(3, len(st.Members))
	maxRows := max(1, min(8, room-3-members))
	per := 1
	for (n+per-1)/per > maxRows*inner {
		per++
	}
	cellsN := (n + per - 1) / per
	flash := a.fleet.flash[wf.ID+"/"+st.ID]
	var grid []string
	var line strings.Builder
	col := 0
	for c := 0; c < cellsN; c++ {
		// A bucket shows its most telling item: running, failed, pending, then done.
		lo, hi := c*per, min(n, (c+1)*per)
		best, rank := byte('c'), 9
		for i := lo; i < hi; i++ {
			if r := strings.IndexByte("rfpsxc", st.Cells[i]); r >= 0 && r < rank {
				best, rank = st.Cells[i], r
			}
		}
		var cell string
		switch best {
		case 'r':
			cell = lipgloss.NewStyle().Foreground(p.Accent).Render(spinnerFrames[(a.frame+c)%len(spinnerFrames)])
		case 'c':
			shade := p.Success
			if at, ok := flash[lo]; ok && per == 1 && a.opt.Animations {
				shade = theme.Blend([]colorT{p.Text, p.Success}, min(1, float64(time.Since(at))/float64(time.Second)))
			}
			cell = lipgloss.NewStyle().Foreground(shade).Render("●")
		case 'f':
			cell = s.Error.Render("✗")
		case 'p':
			cell = lipgloss.NewStyle().Foreground(p.Border).Render("·")
		default:
			cell = s.Subtle.Render("○")
		}
		line.WriteString(cell)
		col++
		if col == inner {
			grid = append(grid, line.String())
			line.Reset()
			col = 0
		}
	}
	if col > 0 {
		grid = append(grid, line.String())
	}

	side := bc.Render("│")
	body := func(x string) string { return side + " " + fit(x, inner) + " " + side }
	out := []string{top, body(summary)}
	for _, g := range grid {
		out = append(out, body(g))
	}
	for i := 0; i < members; i++ {
		m := st.Members[i]
		what := s.Subtle.Render("thinking…")
		if m.Activity != nil && m.Activity.Tool != "" {
			what = lipgloss.NewStyle().Foreground(p.Info).Render(m.Activity.Tool) + "  " + s.Muted.Render(tildify(strings.TrimPrefix(m.Activity.Detail, a.cwd+"/")))
		}
		item := ansi.Truncate(m.Item, max(8, inner/3), "…")
		out = append(out, body(lipgloss.NewStyle().Foreground(p.Accent).Render(spinnerFrames[(a.frame+i*3)%len(spinnerFrames)])+" "+s.Text.Render(item)+"  "+what))
	}
	out = append(out, bc.Render("╰"+strings.Repeat("─", max(0, w-2))+"╯"))
	return out
}
