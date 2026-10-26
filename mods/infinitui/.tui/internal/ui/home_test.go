package ui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/api"
)

func homeApp(t *testing.T) *App {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	a := New(Options{Client: api.New("http://127.0.0.1:9", "", "/repo")})
	a.width, a.height = 100, 40
	for _, id := range []string{"ses_a", "ses_b", "ses_c", "ses_d"} {
		s := api.Session{ID: id, Title: "title " + id}
		s.Location.Directory = "/repo"
		a.sessions = append(a.sessions, s)
	}
	return a
}

func TestRecentKey(t *testing.T) {
	for _, c := range []struct {
		k    tea.KeyPressMsg
		want int
	}{
		{tea.KeyPressMsg{Code: '1', Mod: tea.ModAlt}, 0},
		{tea.KeyPressMsg{Code: '3', Mod: tea.ModAlt | tea.ModCapsLock}, 2},
		// Right Alt is AltGr on Polish and German layouts: Windows reports it as ctrl+alt.
		{tea.KeyPressMsg{Code: '2', Mod: tea.ModCtrl | tea.ModAlt}, 1},
		// A layout without digits on the top row (AZERTY: alt+&) reports the digit as the base key.
		{tea.KeyPressMsg{Code: '&', BaseCode: '1', Mod: tea.ModAlt}, 0},
		{tea.KeyPressMsg{Code: '1', Text: "1"}, -1},
		{tea.KeyPressMsg{Code: '4', Mod: tea.ModAlt}, -1},
		{tea.KeyPressMsg{Code: '1', Mod: tea.ModAlt | tea.ModShift}, -1},
	} {
		if got := recentKey(c.k); got != c.want {
			t.Errorf("%v (mod %v): got %d, want %d", c.k, c.k.Mod, got, c.want)
		}
	}
}

func TestHomeOpensRecentSessions(t *testing.T) {
	// alt+2, also as ctrl+alt+2 (AltGr).
	for _, mod := range []tea.KeyMod{tea.ModAlt, tea.ModCtrl | tea.ModAlt} {
		a := homeApp(t)
		a.handleKey(tea.KeyPressMsg{Code: '2', Mod: mod})
		if a.sessionID != "ses_b" {
			t.Fatalf("mod %v opened %q", mod, a.sessionID)
		}
	}

	// ↓ ↓ ↑ enter: the first session, picked in the list; any other key returns to the prompt.
	a := homeApp(t)
	a.renderHome(30)
	press := func(code rune) { a.handleKey(tea.KeyPressMsg{Code: code}) }
	press(tea.KeyDown)
	press(tea.KeyDown)
	picked := func() string {
		for _, l := range strings.Split(ansi.Strip(a.renderHome(30)), "\n") {
			if strings.Contains(l, "▸") {
				return l
			}
		}
		return ""
	}
	if a.homePick != 2 || !strings.Contains(picked(), "title ses_b") {
		t.Fatalf("pick %d:\n%s", a.homePick, ansi.Strip(a.renderHome(30)))
	}
	press(tea.KeyDown)
	press(tea.KeyDown)
	if a.homePick != 3 {
		t.Fatalf("↓ past the list: pick %d", a.homePick)
	}
	press(tea.KeyUp)
	press(tea.KeyUp)
	press(tea.KeyEnter)
	if a.sessionID != "ses_a" {
		t.Fatalf("enter opened %q", a.sessionID)
	}
	a = homeApp(t)
	a.renderHome(30)
	press = func(code rune) { a.handleKey(tea.KeyPressMsg{Code: code}) }
	press(tea.KeyDown)
	a.handleKey(tea.KeyPressMsg{Code: 'x', Text: "x"})
	if a.homePick != 0 || a.prompt.Value() != "x" || a.sessionID != "" {
		t.Fatalf("typing after ↓: pick %d, prompt %q, session %q", a.homePick, a.prompt.Value(), a.sessionID)
	}

	// A click on a listed session opens it.
	a = homeApp(t)
	a.renderHome(a.layout().transcriptH)
	row := -1
	for r, id := range a.homeRows {
		if id == "ses_c" {
			row = r
		}
	}
	if row < 0 {
		t.Fatalf("ses_c not listed: %v", a.homeRows)
	}
	a.mouseDown(tea.Mouse{X: 50, Y: a.layout().transcriptTop + row, Button: tea.MouseLeft})
	if a.sessionID != "ses_c" || len(a.pendingCmds) != 1 {
		t.Fatalf("click opened %q", a.sessionID)
	}
}
