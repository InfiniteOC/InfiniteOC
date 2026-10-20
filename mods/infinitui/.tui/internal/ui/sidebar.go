package ui

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/api"
	"infiniteoc/infinitui/internal/theme"
)

const sidebarWidth = 38

type diffMsg struct {
	sessionID string
	files     []api.FileDiff
}

// sidebarOn reports whether the sidebar is shown at this width.
func (a *App) sidebarOn() bool {
	if a.width < 110 {
		return false
	}
	return boolOr(a.uprefs.Sidebar, a.width >= 150)
}

func (a *App) mainWidth() int {
	if a.sidebarOn() {
		return a.width - sidebarWidth
	}
	return a.width
}

func (a *App) toggleSidebar() tea.Cmd {
	on := !a.sidebarOn()
	a.uprefs.Sidebar = &on
	a.uprefs.save()
	a.tr.cache = map[string]cachedLines{}
	if on && a.width < 110 {
		return a.showToast("info", "", "The sidebar needs a terminal at least 110 columns wide", 2500*time.Millisecond)
	}
	return nil
}

func (a *App) fetchDiff(sid string) tea.Cmd {
	if sid == "" {
		return nil
	}
	return func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 10*time.Second)
		defer cancel()
		files, err := a.client.Diff(ctx, sid)
		if err != nil {
			return nil
		}
		return diffMsg{sid, files}
	}
}

// goalState reads the InfiniteOC /goal status from the transcript (mods/infiniteoc tui/goal-status.tsx).
var goalLine = regexp.MustCompile(`(?m)^Goal: (.*)$`)
var goalCont = regexp.MustCompile(`Continuation (\d+) of (\d+)`)

func goalState(d *sessionData) (text, step string) {
	if d == nil {
		return "", ""
	}
	for i := len(d.msgs) - 1; i >= 0; i-- {
		m := d.msgs[i]
		if m.Type != "user" && m.Type != "synthetic" {
			continue
		}
		t := strings.TrimSpace(m.Text)
		if !strings.HasPrefix(t, "[InfiniteOC goal") {
			continue
		}
		head := firstLine(t)
		if strings.Contains(head, "stopped") || strings.Contains(head, "finished") {
			return "", ""
		}
		g := goalLine.FindStringSubmatch(t)
		switch {
		case strings.Contains(head, "paused"):
			step = "paused"
		case strings.Contains(strings.ToLower(t), "verify"):
			step = "verify"
		default:
			if c := goalCont.FindStringSubmatch(t); c != nil {
				step = c[1] + "/" + c[2]
			} else {
				step = "on"
			}
		}
		if g != nil {
			text = g[1]
		}
		// Keep looking back for the goal text when this message only carried the status.
		if text == "" {
			for j := i - 1; j >= 0 && text == ""; j-- {
				if g := goalLine.FindStringSubmatch(d.msgs[j].Text); g != nil {
					text = g[1]
				}
			}
		}
		return text, step
	}
	return "", ""
}

func (a *App) renderSidebar(h int) []string {
	s := theme.S
	p := theme.Current
	w := sidebarWidth - 3
	var out []string
	// HUD section: LABEL ·········· value
	sectionV := func(title, value string) {
		if len(out) > 0 {
			out = append(out, "")
		}
		label := lipgloss.NewStyle().Foreground(p.Accent).Bold(true).Render(strings.ToUpper(title))
		dots := w - ansi.StringWidth(label) - ansi.StringWidth(value) - 2
		if value == "" {
			dots++
		}
		line := label + " " + lipgloss.NewStyle().Foreground(p.Border).Render(strings.Repeat("·", max(1, dots)))
		if value != "" {
			line += " " + value
		}
		out = append(out, line)
	}
	section := func(title string) { sectionV(title, "") }
	row := func(k, v string) {
		gap := max(1, w-ansi.StringWidth(k)-ansi.StringWidth(v))
		out = append(out, s.Subtle.Render(k)+strings.Repeat(" ", gap)+v)
	}
	d, ok := a.store.Get(a.sessionID)

	section("Session")
	if ok && a.sessionID != "" {
		for _, l := range wrapText(d.info.DisplayTitle(), w) {
			out = append(out, s.Bold.Render(l))
		}
	} else {
		out = append(out, s.Muted.Render("New session"))
	}
	if text, step := goalState(d); step != "" {
		out = append(out, s.Accent.Render("◎ goal ")+s.Muted.Render(step))
		if text != "" {
			out = append(out, s.Subtle.Render(ansi.Truncate(text, w, "…")))
		}
	}

	used, limit := a.store.ContextUsage(a.sessionID)
	pct := 0.0
	if limit > 0 {
		pct = used / limit
	}
	if used > 0 {
		sectionV("Context", s.Text.Render(pctLabel(pct, used)))
		out = append(out, meter(pct, w))
	} else {
		section("Context")
		if a.running() {
			out = append(out, s.Subtle.Render("measuring after the first reply…"))
		} else {
			out = append(out, s.Subtle.Render("nothing sent yet"))
		}
	}
	if limit > 0 {
		row("window", s.Text.Render(humanTokens(used)+" / "+humanTokens(limit)))
	}
	if ok && d.info.Tokens.Total() > 0 {
		t := d.info.Tokens
		row("tokens", s.Text.Render(fmt.Sprintf("↑%s ↓%s", humanTokens(t.Input+t.Cache.Read+t.Cache.Write), humanTokens(t.Output+t.Reasoning))))
		if t.Cache.Read > 0 && t.Input+t.Cache.Read > 0 {
			row("cached", s.Text.Render(fmt.Sprintf("%d%%", int(100*t.Cache.Read/(t.Input+t.Cache.Read)))))
		}
		row("cost", s.Text.Render(fmt.Sprintf("$%.2f", d.info.Cost)))
	}

	// Running subagents of this view.
	var subs []string
	if ok {
		for id, cd := range a.store.sessions {
			if cd.info.ParentID == a.sessionID && cd.running {
				subs = append(subs, lipgloss.NewStyle().Foreground(p.Primary).Render(spinnerFrames[a.frame%len(spinnerFrames)])+" "+s.Text.Render(ansi.Truncate(cd.info.DisplayTitle(), w-2, "…")))
				_ = id
			}
		}
	}
	if len(subs) > 0 {
		section("Subagents")
		out = append(out, subs...)
	}

	if ok && len(d.diff) > 0 {
		sectionV("Changes", s.Text.Render(fmt.Sprint(len(d.diff))))
		for i, f := range d.diff {
			if i == 12 {
				out = append(out, s.Subtle.Render(fmt.Sprintf("… %d more", len(d.diff)-12)))
				break
			}
			stat := s.Success.Render(fmt.Sprintf("+%d", f.Additions)) + " " + s.Error.Render(fmt.Sprintf("-%d", f.Deletions))
			name := ansi.Truncate(f.File, w-ansi.StringWidth(stat)-1, "…")
			if strings.HasPrefix(name, "…") || ansi.StringWidth(f.File) > w-ansi.StringWidth(stat)-1 {
				// Keep the file name visible.
				r := []rune(f.File)
				keep := w - ansi.StringWidth(stat) - 2
				if keep > 0 && keep < len(r) {
					name = "…" + string(r[len(r)-keep:])
				}
			}
			gap := max(1, w-ansi.StringWidth(name)-ansi.StringWidth(stat))
			out = append(out, s.Text.Render(name)+strings.Repeat(" ", gap)+stat)
		}
	}

	// Outline: every prompt of the session; the one in view is lit, a click jumps there.
	a.outlineRows = map[int]string{}
	if ok && len(d.msgs) > 0 {
		var prompts []*api.Message
		for _, m := range d.msgs {
			if m.Type == "user" && !m.Pending {
				prompts = append(prompts, m)
			}
		}
		if len(prompts) > 1 {
			current := a.tr.CurrentTurn()
			sectionV("Outline", s.Text.Render(fmt.Sprint(len(prompts))))
			start := max(0, len(prompts)-10)
			if start > 0 {
				out = append(out, s.Subtle.Render(fmt.Sprintf("  … %d earlier", start)))
			}
			for i := start; i < len(prompts); i++ {
				m := prompts[i]
				num := fmt.Sprintf("%2d ", i+1)
				text := ansi.Truncate(strings.ReplaceAll(goalText(m.Text), "\n", " "), w-4, "…")
				line := s.Subtle.Render(num) + s.Muted.Render(text)
				if m.ID == current {
					line = lipgloss.NewStyle().Foreground(p.Accent).Bold(true).Render(num) + s.Text.Bold(true).Render(text)
				}
				a.outlineRows[len(out)] = m.ID
				out = append(out, line)
			}
		}
	}

	if len(a.store.mcp) > 0 {
		section("MCP")
		for _, m := range a.store.mcp {
			c := s.Subtle
			switch m.Status.Status {
			case "connected":
				c = s.Success
			case "failed", "needs_auth":
				c = s.Error
			case "pending":
				c = s.Warning
			}
			out = append(out, c.Render("● ")+s.Muted.Render(ansi.Truncate(m.Name, w-2, "…")))
		}
	}

	if len(out) > h {
		out = out[:h]
	}
	for len(out) < h {
		out = append(out, "")
	}
	bar := lipgloss.NewStyle().Foreground(p.Border).Render("│")
	for i, l := range out {
		out[i] = bar + "  " + l
	}
	return out
}
