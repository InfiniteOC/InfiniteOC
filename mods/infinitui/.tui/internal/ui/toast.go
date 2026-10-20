package ui

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/theme"
)

type toast struct {
	variant, title, text string
	born, until          time.Time
}

func (a *App) showToast(variant, title, text string, d time.Duration) tea.Cmd {
	now := time.Now()
	a.toast = &toast{variant: variant, title: title, text: text, born: now, until: now.Add(d)}
	return a.tick()
}

// slide is how far right of its resting place the toast is drawn (it eases in from the edge).
func (t *toast) slide(width int) int {
	age := time.Since(t.born)
	const in = 220 * time.Millisecond
	if age >= in {
		return 0
	}
	f := 1 - coast(float64(age)/float64(in))
	return int(f * float64(width))
}

func (t *toast) render(w int) string {
	p := theme.Current
	c := p.Info
	icon := "•"
	switch t.variant {
	case "success":
		c, icon = p.Success, "✓"
	case "warning":
		c, icon = p.Warning, "!"
	case "error":
		c, icon = p.Error, "✗"
	}
	text := lipgloss.NewStyle().Foreground(p.Text)
	wrapped := wrapText(t.text, w-6)
	if len(wrapped) > 5 {
		wrapped = append(wrapped[:4], "…")
	}
	width := 0
	for _, l := range wrapped {
		width = max(width, ansi.StringWidth(l))
	}
	head := lipgloss.NewStyle().Foreground(c).Bold(true).Render(icon)
	if t.title != "" {
		head += " " + lipgloss.NewStyle().Foreground(p.Text).Bold(true).Render(t.title)
		width = max(width, ansi.StringWidth(t.title)+2)
	}
	box := min(w, width+4)
	if t.title == "" && len(wrapped) == 1 {
		// One-liners carry the icon inline.
		body := []string{head + " " + text.Render(wrapped[0])}
		return t.withCountdown(frame(box+2, c, "", "", body, "", ""), box+2, c)
	}
	var body []string
	for _, l := range wrapped {
		body = append(body, text.Foreground(p.Muted).Render(l))
	}
	return t.withCountdown(frame(box, c, head, "", body, "", ""), box, c)
}

// withCountdown turns the bottom border into a bar that drains until the toast leaves.
func (t *toast) withCountdown(box string, w int, c colorT) string {
	lines := strings.Split(box, "\n")
	total := t.until.Sub(t.born)
	left := time.Until(t.until)
	frac := 0.0
	if total > 0 {
		frac = math.Max(0, math.Min(1, float64(left)/float64(total)))
	}
	n := w - 2
	on := int(math.Round(frac * float64(n)))
	edge := lipgloss.NewStyle().Foreground(c)
	dim := lipgloss.NewStyle().Foreground(theme.Blend([]colorT{c, theme.Current.Bg}, 0.6))
	lines[len(lines)-1] = edge.Render("╰") + edge.Render(strings.Repeat("━", on)) + dim.Render(strings.Repeat("─", n-on)) + edge.Render("╯")
	return strings.Join(lines, "\n")
}

// notify raises a desktop notification (tstat-status behaviour) and an OSC 777/9 for terminals.
func notify(title, body string) tea.Cmd {
	return func() tea.Msg {
		switch runtime.GOOS {
		case "linux":
			if _, err := exec.LookPath("notify-send"); err == nil {
				_ = exec.Command("notify-send", "--app-name=InfiniteOC", title, body).Run()
				return nil
			}
		case "darwin":
			script := fmt.Sprintf("display notification %q with title %q", body, title)
			_ = exec.Command("osascript", "-e", script).Run()
			return nil
		}
		return nil
	}
}

// --- opendaemon (src/opendaemon.mjs): notices and close-all-tabs for connected UIs ---

type daemonMsg struct {
	revision int
	messages []struct {
		ID     string `json:"id"`
		Action string `json:"action"`
		Text   string `json:"text"`
	}
	err bool
}

func daemonClient(sock string) *http.Client {
	return &http.Client{
		Timeout: 3 * time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		}},
	}
}

func (a *App) pollDaemon(revision int) tea.Cmd {
	sock, id := a.opt.DaemonSock, a.opt.DaemonID
	delay := 750 * time.Millisecond
	if revision < 0 {
		delay = 5 * time.Second
		revision = 0
	}
	return tea.Tick(delay, func(time.Time) tea.Msg {
		body, _ := json.Marshal(map[string]any{"client": id, "revision": revision, "scripting": false})
		res, err := daemonClient(sock).Post("http://daemon/poll", "application/json", bytes.NewReader(body))
		if err != nil {
			return daemonMsg{revision: revision, err: true}
		}
		defer res.Body.Close()
		var out struct {
			Revision int `json:"revision"`
			Messages []struct {
				ID     string `json:"id"`
				Action string `json:"action"`
				Text   string `json:"text"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(res.Body).Decode(&out)
		return daemonMsg{revision: out.Revision, messages: out.Messages}
	})
}

func (a *App) handleDaemon(m daemonMsg) tea.Cmd {
	var cmds []tea.Cmd
	for _, msg := range m.messages {
		msg := msg
		switch msg.Action {
		case "notify":
			cmds = append(cmds, a.showToast("info", "opendaemon", msg.Text, 5*time.Second))
		case "close-all-tabs":
			cmds = append(cmds, a.newSession())
		}
		sock, id := a.opt.DaemonSock, a.opt.DaemonID
		cmds = append(cmds, func() tea.Msg {
			body, _ := json.Marshal(map[string]any{"client": id, "id": msg.ID, "status": "applied"})
			if res, err := daemonClient(sock).Post("http://daemon/ack", "application/json", bytes.NewReader(body)); err == nil {
				res.Body.Close()
			}
			return nil
		})
	}
	next := m.revision
	if m.err {
		next = -1 // back off while the daemon is away
	}
	cmds = append(cmds, a.pollDaemon(next))
	return tea.Batch(cmds...)
}
