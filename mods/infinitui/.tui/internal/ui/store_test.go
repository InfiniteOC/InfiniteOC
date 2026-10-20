package ui

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/api"
)

func ev(t string, created int64, data any) api.Event {
	b, _ := json.Marshal(data)
	return api.Event{ID: "evt_" + t, Type: t, Created: created, Data: b}
}

func TestStreamingTurn(t *testing.T) {
	s := NewStore()
	sid, mid := "ses_1", "msg_a1"
	base := map[string]any{"sessionID": sid, "assistantMessageID": mid}
	with := func(extra map[string]any) map[string]any {
		m := map[string]any{}
		for k, v := range base {
			m[k] = v
		}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	s.Apply(ev("session.execution.started", 1, map[string]any{"sessionID": sid}))
	s.Apply(ev("session.step.started", 2, with(map[string]any{"agent": "build", "model": map[string]any{"id": "m", "providerID": "p"}, "started": 2})))
	s.Apply(ev("session.reasoning.started", 3, with(nil)))
	s.Apply(ev("session.reasoning.delta", 4, with(map[string]any{"delta": "hmm"})))
	s.Apply(ev("session.reasoning.ended", 5, with(map[string]any{"text": "hmm, ok"})))
	s.Apply(ev("session.text.started", 6, with(nil)))
	s.Apply(ev("session.text.delta", 7, with(map[string]any{"delta": "Hel"})))
	s.Apply(ev("session.text.delta", 8, with(map[string]any{"delta": "lo"})))
	s.Apply(ev("session.tool.input.started", 9, with(map[string]any{"id": "t1", "name": "read"})))
	s.Apply(ev("session.tool.input.delta", 10, with(map[string]any{"id": "t1", "delta": `{"path": "a.go"`})))
	s.Apply(ev("session.tool.called", 11, with(map[string]any{"id": "t1", "input": map[string]any{"path": "a.go"}})))
	effects := s.Apply(ev("session.tool.success", 12, with(map[string]any{"id": "t1", "content": []any{map[string]any{"type": "text", "text": "ok"}}})))
	if len(effects) != 1 || effects[0].Kind != effToolCompleted || effects[0].Text != "read" {
		t.Fatalf("tool completion effect: %+v", effects)
	}
	s.Apply(ev("session.step.ended", 13, with(map[string]any{"finish": "stop", "tokens": map[string]any{"input": 10, "output": 5}})))
	done := s.Apply(ev("session.execution.succeeded", 14, map[string]any{"sessionID": sid}))
	if len(done) == 0 || done[0].Kind != effDone {
		t.Fatalf("done effect: %+v", done)
	}

	d, _ := s.Get(sid)
	if d.running {
		t.Fatal("still running")
	}
	m := d.index[mid]
	if m == nil || len(m.Content) != 3 {
		t.Fatalf("content: %+v", m)
	}
	if m.Content[0].Text != "hmm, ok" || m.Content[0].Time.Completed == 0 {
		t.Errorf("reasoning: %+v", m.Content[0])
	}
	if m.Content[1].Text != "Hello" {
		t.Errorf("text: %q", m.Content[1].Text)
	}
	tool := m.Content[2]
	if tool.State.Status != "completed" || string(tool.State.Input) != `{"path":"a.go"}` || tool.State.Content[0].Text != "ok" {
		t.Errorf("tool: %+v", tool.State)
	}
	if m.Tokens == nil || m.Tokens.Output != 5 {
		t.Errorf("tokens: %+v", m.Tokens)
	}
	last := d.msgs[len(d.msgs)-1]
	if last.Type != "idle" || last.Outcome != "succeeded" {
		t.Errorf("idle row: %+v", last)
	}
}

func TestInterruptClosesRunningTools(t *testing.T) {
	s := NewStore()
	sid := "ses_1"
	s.Apply(ev("session.step.started", 1, map[string]any{"sessionID": sid, "assistantMessageID": "msg_a", "agent": "build", "started": 1}))
	s.Apply(ev("session.tool.called", 2, map[string]any{"sessionID": sid, "assistantMessageID": "msg_a", "id": "t", "name": "shell", "input": map[string]any{"command": "sleep 9"}}))
	s.Apply(ev("session.execution.interrupted", 3, map[string]any{"sessionID": sid, "reason": "user"}))
	d, _ := s.Get(sid)
	b := d.index["msg_a"].Content[0]
	if b.State.Status != "error" {
		t.Fatalf("tool should stop spinning, got %s", b.State.Status)
	}
	if d.msgs[len(d.msgs)-1].Outcome != "interrupted" {
		t.Fatal("missing interrupted idle row")
	}
}

func TestInboxLifecycle(t *testing.T) {
	s := NewStore()
	sid := "ses_1"
	item := map[string]any{"type": "user", "payload": map[string]any{"text": "hi"}, "delivery": "steer"}
	s.Apply(ev("session.inbox.enqueued", 5, map[string]any{"sessionID": sid, "inboxID": "msg_u1", "item": item}))
	d, _ := s.Get(sid)
	if !d.index["msg_u1"].Pending {
		t.Fatal("enqueued prompt should be pending")
	}
	// An assistant row that started earlier must stay before the delivered prompt.
	s.Apply(ev("session.step.started", 6, map[string]any{"sessionID": sid, "assistantMessageID": "msg_z", "started": 6}))
	s.Apply(ev("session.inbox.delivered", 7, map[string]any{"sessionID": sid, "inboxID": "msg_u1"}))
	if d.msgs[len(d.msgs)-1].ID != "msg_u1" || d.index["msg_u1"].Pending {
		t.Fatalf("delivered prompt should move to the end: %v", ids(d.msgs))
	}
	s.Apply(ev("session.inbox.enqueued", 8, map[string]any{"sessionID": sid, "inboxID": "msg_u2", "item": item}))
	s.Apply(ev("session.inbox.cancelled", 9, map[string]any{"sessionID": sid, "inboxID": "msg_u2"}))
	if d.index["msg_u2"] != nil {
		t.Fatal("cancelled prompt should disappear")
	}
}

func TestRevertCommitDropsLaterRows(t *testing.T) {
	s := NewStore()
	d := s.session("ses_1")
	for _, id := range []string{"msg_1", "msg_2", "msg_3"} {
		d.upsert(&api.Message{ID: id, Type: "user"})
	}
	s.Apply(ev("session.revert.committed", 1, map[string]any{"sessionID": "ses_1", "to": "msg_2"}))
	if got := ids(d.msgs); len(got) != 1 || got[0] != "msg_1" {
		t.Fatalf("rows after commit: %v", got)
	}
}

func TestPermissionsAndForms(t *testing.T) {
	s := NewStore()
	p := map[string]any{"id": "per_1", "sessionID": "ses_1", "action": "edit", "resources": []string{"a.go"}}
	if e := s.Apply(ev("permission.asked", 1, p)); len(e) != 1 || e[0].Kind != effPermission {
		t.Fatalf("effects: %+v", e)
	}
	s.Apply(ev("permission.asked", 2, p)) // duplicate
	d, _ := s.Get("ses_1")
	if len(d.perms) != 1 {
		t.Fatalf("perms: %d", len(d.perms))
	}
	s.Apply(ev("permission.replied", 3, map[string]any{"sessionID": "ses_1", "requestID": "per_1", "reply": "once"}))
	if len(d.perms) != 0 {
		t.Fatal("reply should clear the request")
	}
	form := map[string]any{"form": map[string]any{"id": "frm_1", "sessionID": "global", "title": "Login", "fields": []any{}}}
	e := api.Event{Type: "form.created", Location: &api.Location{Directory: "/p"}}
	e.Data, _ = json.Marshal(form)
	s.Apply(e)
	if len(s.globalForms) != 1 || s.globalForms[0].Directory != "/p" {
		t.Fatalf("global form: %+v", s.globalForms)
	}
}

func TestSessionTree(t *testing.T) {
	s := NewStore()
	s.session("child").info.ParentID = "root"
	s.session("grandchild").info.ParentID = "child"
	s.session("root")
	if s.Root("grandchild") != "root" || !s.InTree("root", "grandchild") || s.InTree("other", "grandchild") {
		t.Fatal("tree lookups")
	}
}

func ids(ms []*api.Message) []string {
	var out []string
	for _, m := range ms {
		out = append(out, m.ID)
	}
	return out
}

func TestDetectTrigger(t *testing.T) {
	cases := []struct {
		in    string
		kind  rune
		start int
		query string
		ok    bool
	}{
		{"/mod", '/', 0, "mod", true},
		{"/goal fix it", 0, 0, "", false},
		{"look at @src/ma", '@', 8, "src/ma", true},
		{"look at #", '#', 8, "", true},
		{"path#12", 0, 0, "", false},
		{"email a@b", 0, 0, "", false},
		{"two\n@x", '@', 4, "x", true},
	}
	for _, c := range cases {
		kind, start, query, ok := detectTrigger(c.in)
		if ok != c.ok || (ok && (kind != c.kind || start != c.start || query != c.query)) {
			t.Errorf("%q: got %c %d %q %v", c.in, kind, start, query, ok)
		}
	}
}

func TestBuildMentions(t *testing.T) {
	p := &Prompt{}
	p.mentions = []mention{
		{text: "@main.go", kind: "file", value: "/p/main.go", name: "main.go"},
		{text: "@explore", kind: "agent", value: "explore"},
	}
	body := p.Build("ask @explore about @main.go please")
	if len(body.Files) != 1 || body.Files[0].URI != "file:///p/main.go" || body.Files[0].Mention.Start != 19 || body.Files[0].Mention.End != 27 {
		t.Fatalf("files: %+v", body.Files[0])
	}
	if len(body.Agents) != 1 || body.Agents[0].Name != "explore" || body.Agents[0].Mention.Start != 4 {
		t.Fatalf("agents: %+v", body.Agents)
	}
	// A mention the user deleted from the text is not attached.
	if b := p.Build("never mind"); len(b.Files)+len(b.Agents) != 0 {
		t.Fatal("stale mentions attached")
	}
}

func TestGoalState(t *testing.T) {
	d := &sessionData{index: map[string]*api.Message{}, versions: map[string]int{}}
	d.upsert(&api.Message{ID: "msg_1", Type: "user", Text: "[InfiniteOC goal]\nGoal: ship the parser\nmore"})
	if text, step := goalState(d); text != "ship the parser" || step != "on" {
		t.Fatalf("start: %q %q", text, step)
	}
	d.upsert(&api.Message{ID: "msg_2", Type: "synthetic", Text: "[InfiniteOC goal: continue]\nContinuation 2 of 10"})
	if text, step := goalState(d); text != "ship the parser" || step != "2/10" {
		t.Fatalf("continuation: %q %q", text, step)
	}
	d.upsert(&api.Message{ID: "msg_3", Type: "synthetic", Text: "[InfiniteOC goal: finished]"})
	if _, step := goalState(d); step != "" {
		t.Fatal("finished goal still shown")
	}
}

func TestPartialInput(t *testing.T) {
	m := partialInput(`{"path": "src/ma`)
	if m["path"] != "src/ma" {
		t.Fatalf("got %v", m)
	}
}

func TestGoalTextAndThinkingTitle(t *testing.T) {
	if goalText("[InfiniteOC goal]\nGoal: x") != "/goal x" {
		t.Fatal("goal text")
	}
	title, body := splitThinkingTitle("**Planning**\n\nfirst read")
	if title != "Planning" || body != "first read" {
		t.Fatalf("%q %q", title, body)
	}
}

func TestThreadTurn(t *testing.T) {
	rows := []threadRow{{line: "◆ answer"}, {line: "  more"}, {line: ""}, {line: "2s · model"}}
	threadTurn(rows, true)
	got := []string{ansi.Strip(rows[0].line), ansi.Strip(rows[1].line), ansi.Strip(rows[2].line), ansi.Strip(rows[3].line)}
	want := []string{"◆ answer", "│ more", "│", "╰─ 2s · model"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("row %d: %q, want %q", i, got[i], want[i])
		}
	}
}

func TestPasteChips(t *testing.T) {
	p := NewPrompt()
	p.SetWidth(80)
	big := strings.Repeat("row\n", 30)
	p.Paste(big)
	v := p.Value()
	if !strings.HasPrefix(v, "[pasted #1 · 31 lines]") {
		t.Fatalf("chip not inserted: %q", v)
	}
	if got := p.Expand("see " + v); got != "see "+big {
		t.Fatalf("expand: %q", got)
	}
	p.Reset()
	p.Paste("short")
	if p.Value() != "short" {
		t.Fatalf("small paste should be inline: %q", p.Value())
	}
}

func TestComposerColoring(t *testing.T) {
	p := NewPrompt()
	p.SetValue("/goal ask @general about #main.go")
	out := p.colorize("/goal ask @general about #main.go", true)
	if ansi.Strip(out) != "/goal ask @general about #main.go" {
		t.Fatalf("text changed: %q", ansi.Strip(out))
	}
	if out == "/goal ask @general about #main.go" {
		t.Fatal("no colour applied")
	}
}

func TestErrorCardAndPulse(t *testing.T) {
	lines := errorBox("rate limited by provider", 60)
	if !strings.HasPrefix(ansi.Strip(lines[0]), "✗ ╭") || !strings.Contains(ansi.Strip(strings.Join(lines, "\n")), "rate limited") {
		t.Fatalf("card: %q", ansi.Strip(strings.Join(lines, "\n")))
	}
	for _, l := range lines[1:] {
		if !strings.HasPrefix(l, "  ") {
			t.Fatalf("card rows must leave the thread gutter free: %q", l)
		}
	}
}

func TestEffortSlider(t *testing.T) {
	a := &App{opt: Options{}}
	d := &effortDialog{a: a, model: "M", stops: []string{"", "low", "medium", "high", "max", "auto", "infinicode"}}
	d.move(3)
	d.pos = 3
	out := ansi.Strip(d.View(84, 20))
	for _, want := range []string{"Effort · M", "high", "thinks longer", "faster", "smarter", "default", "infinicode", "◉"} {
		if !strings.Contains(out, want) {
			t.Fatalf("slider missing %q:\n%s", want, out)
		}
	}
	d.move(99)
	if d.sel != 6 {
		t.Fatalf("clamped to the last stop, got %d", d.sel)
	}
}
