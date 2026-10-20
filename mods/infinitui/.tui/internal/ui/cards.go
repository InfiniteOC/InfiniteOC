package ui

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"runtime"
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

// --- permissions ---

type permissionCard struct {
	req     api.PermissionRequest
	cursor  int
	typing  bool
	input   textinput.Model
	sending bool
}

// sessionAllow remembers "allow for this session" grants: root|action|resources.
var sessionAllow = map[string]bool{}

func allowKey(root string, p api.PermissionRequest) string {
	res := append([]string{}, p.Resources...)
	sort.Strings(res)
	return root + "|" + p.Action + "|" + strings.Join(res, "\x00")
}

// activePermission returns the card for the first pending request in this session tree.
func (a *App) activePermission() *permissionCard {
	if a.sessionID == "" {
		return nil
	}
	root := a.treeRoot()
	var pick *api.PermissionRequest
	ids := []string{a.sessionID}
	for id := range a.store.sessions {
		if id != a.sessionID {
			ids = append(ids, id)
		}
	}
	for _, id := range ids {
		d := a.store.sessions[id]
		if d == nil || len(d.perms) == 0 || (id != a.sessionID && !a.store.InTree(root, id)) {
			continue
		}
		for i := range d.perms {
			p := d.perms[i]
			if a.yolo && !safeGate.MatchString(p.Message) {
				continue
			}
			if sessionAllow[allowKey(root, p)] {
				continue
			}
			pick = &d.perms[i]
			break
		}
		if pick != nil {
			break
		}
	}
	if pick == nil {
		a.perm = nil
		return nil
	}
	if a.perm == nil || a.perm.req.ID != pick.ID {
		in := textinput.New()
		in.Prompt = ""
		in.Placeholder = "Tell the agent what to do instead (enter sends, empty just rejects)"
		a.perm = &permissionCard{req: *pick, input: in}
	}
	return a.perm
}

// sessionGrants answers requests already covered by "allow for this session".
func (a *App) sessionGrants() tea.Cmd {
	root := a.treeRoot()
	var cmds []tea.Cmd
	for _, d := range a.store.sessions {
		for _, p := range d.perms {
			if sessionAllow[allowKey(root, p)] {
				p := p
				cmds = append(cmds, func() tea.Msg {
					_ = a.client.ReplyPermission(a.bg(), p.SessionID, p.ID, "once", "")
					return nil
				})
			}
		}
	}
	return tea.Batch(cmds...)
}

var permOptions = []struct{ label, key, decision string }{
	{"Allow once", "y", "once"},
	{"Allow for this session", "s", "session"},
	{"Always allow", "a", "always"},
	{"Reject, and tell the agent what to do", "n", "reject"},
}

func (c *permissionCard) update(a *App, k tea.KeyPressMsg) tea.Cmd {
	ks := k.String()
	if c.typing {
		switch ks {
		case "esc":
			c.typing = false
			c.input.Blur()
			return nil
		case "enter":
			return c.answer(a, "reject", strings.TrimSpace(c.input.Value()))
		}
		var cmd tea.Cmd
		c.input, cmd = c.input.Update(k)
		return cmd
	}
	switch ks {
	case "up", "k":
		c.cursor = (c.cursor + len(permOptions) - 1) % len(permOptions)
	case "down", "j", "tab":
		c.cursor = (c.cursor + 1) % len(permOptions)
	case "1", "2", "3", "4":
		c.cursor = int(ks[0] - '1')
		return c.choose(a)
	case "y", "s", "a", "n":
		for i, o := range permOptions {
			if o.key == ks {
				c.cursor = i
				return c.choose(a)
			}
		}
	case "enter":
		return c.choose(a)
	case "esc":
		c.cursor = 3
		return c.choose(a)
	case "ctrl+c":
		return c.answer(a, "reject", "")
	case "ctrl+p":
		return a.openPalette()
	}
	return nil
}

func (c *permissionCard) choose(a *App) tea.Cmd {
	o := permOptions[c.cursor]
	switch o.decision {
	case "reject":
		c.typing = true
		return c.input.Focus()
	case "session":
		sessionAllow[allowKey(a.treeRoot(), c.req)] = true
		return tea.Batch(c.answer(a, "once", ""), a.sessionGrants())
	}
	return c.answer(a, o.decision, "")
}

func (c *permissionCard) answer(a *App, decision, message string) tea.Cmd {
	req := c.req
	// Drop it locally right away; permission.replied confirms.
	if d, ok := a.store.Get(req.SessionID); ok {
		for i, p := range d.perms {
			if p.ID == req.ID {
				d.perms = append(d.perms[:i], d.perms[i+1:]...)
				break
			}
		}
	}
	a.perm = nil
	return func() tea.Msg {
		if err := a.client.ReplyPermission(a.bg(), req.SessionID, req.ID, decision, message); err != nil {
			return errMsg{"permission reply", err}
		}
		return nil
	}
}

// permissionTool finds the tool call a request is about.
func (a *App) permissionTool(req api.PermissionRequest) *api.Block {
	if req.Source == nil {
		return nil
	}
	d, ok := a.store.Get(req.SessionID)
	if !ok {
		return nil
	}
	m := d.index[req.Source.MessageID]
	if m == nil {
		return nil
	}
	return toolBlock(m, req.Source.ID)
}

func (c *permissionCard) render(a *App, w int) string {
	s := theme.S
	p := theme.Current
	inner := w - 4
	var lines []string
	title := s.Warning.Bold(true).Render("▲ Permission") + s.Muted.Render(" · "+c.req.Action)
	if c.req.SessionID != a.sessionID {
		title += s.Subtle.Render(" · from a subagent")
	}
	if c.req.Message != "" {
		for _, l := range wrapText(c.req.Message, inner) {
			lines = append(lines, s.Text.Render(l))
		}
	}
	if b := a.permissionTool(c.req); b != nil {
		lines = append(lines, permissionPreview(a, b, inner)...)
	} else if len(c.req.Resources) > 0 {
		for _, r := range firstN(c.req.Resources, 6) {
			lines = append(lines, s.Text.Render("  "+ansi.Truncate(r, inner-2, "…")))
		}
	}
	lines = append(lines, "")
	for i, o := range permOptions {
		label := fmt.Sprintf("%d. %s", i+1, o.label)
		if o.decision == "always" && len(c.req.Save) > 0 {
			label += s.Subtle.Render("  (" + ansi.Truncate(strings.Join(c.req.Save, ", "), max(10, inner-40), "…") + ")")
		}
		hint := s.Subtle.Render(o.key)
		if i == c.cursor {
			lines = append(lines, lipgloss.NewStyle().Foreground(p.Primary).Bold(true).Render("❯ ")+s.Bold.Render(label)+"  "+hint)
		} else {
			lines = append(lines, "  "+s.Muted.Render(label)+"  "+hint)
		}
	}
	if c.typing {
		c.input.SetWidth(inner - 4)
		lines = append(lines, "", lipgloss.NewStyle().Foreground(p.Accent).Render("› ")+c.input.View())
	}
	k := func(key, desc string) string { return s.Key.Render(key) + " " + s.KeyDesc.Render(desc) }
	hints := k("↑↓", "choose") + "  " + k("enter", "confirm") + "  " + k("esc", "reject")
	if c.typing {
		hints = k("enter", "send rejection") + "  " + k("esc", "back")
	}
	return frame(w, p.Warning, title, "", padCard(lines), hints, "")
}

// permissionPreview shows what the tool is about to do.
func permissionPreview(a *App, b *api.Block, w int) []string {
	s := theme.S
	in := map[string]any{}
	if b.State != nil {
		if b.State.Status == "streaming" {
			in = partialInput(b.PartialInput)
		} else {
			in = parseObj(b.State.Input)
		}
	}
	c := toolCtx{b: b, in: in, meta: map[string]any{}, width: w, cwd: a.cwd, store: a.store}
	v := renderTool(c)
	var lines []string
	if b.Name != "shell" && b.Name != "bash" {
		lines = append(lines, s.ToolName.Render(v.title)+" "+s.Text.Render(ansi.Truncate(v.arg, w-ansi.StringWidth(v.title)-2, "…")))
	}
	maxRows := max(4, a.height/3)
	switch b.Name {
	case "edit", "multiedit":
		rows, _ := render.DiffStrings(str(in, "oldString", "old_string"), str(in, "newString", "new_string"), 2)
		diff, hidden := render.RenderDiff(rows, render.DiffOptions{Filename: str(in, "path", "filePath"), Width: w, MaxRows: maxRows})
		lines = append(lines, diff...)
		if hidden > 0 {
			lines = append(lines, s.Subtle.Render(fmt.Sprintf("… +%d lines", hidden)))
		}
	case "write":
		content := strings.TrimRight(str(in, "content"), "\n")
		src := strings.Split(content, "\n")
		shown, hidden := collapse(src, maxRows, false)
		lines = append(lines, render.CodeBlock(str(in, "path", "filePath"), strings.Join(shown, "\n"), min(w, max(40, longest(shown)+10)), false)...)
		if hidden > 0 {
			lines = append(lines, s.Subtle.Render(fmt.Sprintf("… +%d more lines", hidden)))
		}
	case "shell", "bash":
		cmd := str(in, "command")
		for _, l := range firstN(strings.Split(cmd, "\n"), maxRows) {
			lines = append(lines, s.Accent.Render("$ ")+s.Text.Render(ansi.Truncate(l, w-2, "…")))
		}
		if d := str(in, "description"); d != "" {
			lines = append(lines, s.Subtle.Render(d))
		}
	default:
		if len(in) > 0 {
			b, _ := json.MarshalIndent(in, "", "  ")
			for _, l := range firstN(strings.Split(string(b), "\n"), maxRows) {
				lines = append(lines, s.Muted.Render(ansi.Truncate(l, w, "…")))
			}
		}
	}
	return lines
}

// --- forms (question tool, MCP elicitation) ---

type formCard struct {
	form    api.Form
	field   int
	cursor  int
	picked  map[int]bool
	input   textinput.Model
	answers map[string]any
	custom  bool
}

func (a *App) activeForm() *formCard {
	var pick *api.Form
	if d, ok := a.store.Get(a.sessionID); ok && len(d.forms) > 0 {
		pick = &d.forms[0]
	}
	if pick == nil {
		root := a.treeRoot()
		for id, d := range a.store.sessions {
			if len(d.forms) > 0 && a.store.InTree(root, id) {
				pick = &d.forms[0]
				break
			}
		}
	}
	if pick == nil {
		for i := range a.store.globalForms {
			if a.relevant(a.store.globalForms[i].Directory) {
				pick = &a.store.globalForms[i]
				break
			}
		}
	}
	if pick == nil {
		a.form = nil
		return nil
	}
	if a.form == nil || a.form.form.ID != pick.ID {
		in := textinput.New()
		in.Prompt = ""
		a.form = &formCard{form: *pick, input: in, answers: map[string]any{}, picked: map[int]bool{}}
		a.form.enterField()
	}
	return a.form
}

func (f *formCard) visible() []api.FormField {
	var out []api.FormField
	for _, fl := range f.form.Fields {
		if fl.Hidden || !f.whenOK(fl) {
			continue
		}
		out = append(out, fl)
	}
	return out
}

func (f *formCard) whenOK(fl api.FormField) bool {
	for _, w := range fl.When {
		got, _ := json.Marshal(f.answers[w.Key])
		eq := string(got) == strings.TrimSpace(string(w.Value))
		if (w.Op == "eq" && !eq) || (w.Op == "neq" && eq) {
			return false
		}
	}
	return true
}

func (f *formCard) current() (api.FormField, bool) {
	v := f.visible()
	if f.field < 0 || f.field >= len(v) {
		return api.FormField{}, false
	}
	return v[f.field], true
}

func (f *formCard) enterField() {
	f.cursor = 0
	f.picked = map[int]bool{}
	f.custom = false
	f.input.SetValue("")
	f.input.Blur()
	fl, ok := f.current()
	if !ok {
		return
	}
	if len(fl.Options) == 0 && fl.Type != "boolean" && fl.Type != "external" {
		f.custom = true
		f.input.Placeholder = nonEmpty(fl.Placeholder, "Type your answer")
		f.input.Focus()
	}
}

func optionValue(o api.FormOption) any {
	var v any
	if json.Unmarshal(o.Value, &v) != nil || v == nil {
		return o.Label
	}
	return v
}

func (f *formCard) choices(fl api.FormField) []string {
	if fl.Type == "boolean" {
		return []string{"Yes", "No"}
	}
	var out []string
	for _, o := range fl.Options {
		out = append(out, o.Label)
	}
	if fl.Custom {
		out = append(out, "Something else…")
	}
	return out
}

func (f *formCard) update(a *App, k tea.KeyPressMsg) tea.Cmd {
	fl, ok := f.current()
	if !ok {
		return f.submit(a)
	}
	ks := k.String()
	if ks == "esc" {
		if f.custom && len(fl.Options) > 0 {
			f.custom = false
			f.input.Blur()
			return nil
		}
		form := f.form
		a.form = nil
		dropForm(a, form)
		return func() tea.Msg {
			_ = a.client.CancelForm(a.bg(), form)
			return nil
		}
	}
	if f.custom {
		if ks == "enter" {
			val := strings.TrimSpace(f.input.Value())
			if val == "" && fl.Required {
				return nil
			}
			switch fl.Type {
			case "multiselect":
				var vals []any
				for i, o := range fl.Options {
					if f.picked[i] {
						vals = append(vals, optionValue(o))
					}
				}
				if val != "" {
					vals = append(vals, val)
				}
				f.answers[fl.Key] = vals
			case "number", "integer":
				var n float64
				if _, err := fmt.Sscan(val, &n); err != nil {
					return a.showToast("warning", "", "Enter a number", 2*time.Second)
				}
				f.answers[fl.Key] = n
			default:
				f.answers[fl.Key] = val
			}
			return f.next(a)
		}
		var cmd tea.Cmd
		f.input, cmd = f.input.Update(k)
		return cmd
	}
	ch := f.choices(fl)
	switch ks {
	case "up", "k":
		f.cursor = (f.cursor + len(ch) - 1) % max(1, len(ch))
	case "down", "j", "tab":
		f.cursor = (f.cursor + 1) % max(1, len(ch))
	case "space", "x":
		if fl.Type == "multiselect" && f.cursor < len(fl.Options) {
			f.picked[f.cursor] = !f.picked[f.cursor]
		}
	case "enter":
		if fl.Type == "external" {
			return f.next(a)
		}
		if fl.Type == "boolean" {
			f.answers[fl.Key] = f.cursor == 0
			return f.next(a)
		}
		if fl.Custom && f.cursor == len(ch)-1 {
			f.custom = true
			f.input.Placeholder = "Type your answer"
			return f.input.Focus()
		}
		if fl.Type == "multiselect" {
			var vals []any
			for i, o := range fl.Options {
				if f.picked[i] {
					vals = append(vals, optionValue(o))
				}
			}
			if len(vals) == 0 && f.cursor < len(fl.Options) {
				vals = []any{optionValue(fl.Options[f.cursor])}
			}
			f.answers[fl.Key] = vals
			return f.next(a)
		}
		if f.cursor < len(fl.Options) {
			f.answers[fl.Key] = optionValue(fl.Options[f.cursor])
		}
		return f.next(a)
	default:
		if len(ks) == 1 && ks[0] >= '1' && ks[0] <= '9' {
			i := int(ks[0] - '1')
			if i < len(ch) {
				f.cursor = i
				if fl.Type != "multiselect" {
					return f.update(a, tea.KeyPressMsg{Code: tea.KeyEnter})
				}
				f.picked[i] = !f.picked[i]
			}
		}
	}
	return nil
}

func (f *formCard) next(a *App) tea.Cmd {
	f.field++
	if _, ok := f.current(); ok {
		f.enterField()
		return nil
	}
	return f.submit(a)
}

func dropForm(a *App, form api.Form) {
	if d, ok := a.store.Get(form.SessionID); ok {
		d.forms = removeForm(d.forms, form.ID)
	}
	a.store.globalForms = removeForm(a.store.globalForms, form.ID)
}

func (f *formCard) submit(a *App) tea.Cmd {
	form := f.form
	answers := f.answers
	a.form = nil
	dropForm(a, form)
	return func() tea.Msg {
		if err := a.client.ReplyForm(a.bg(), form, answers); err != nil {
			return errMsg{"answer", err}
		}
		return nil
	}
}

func (f *formCard) render(a *App, w int) string {
	s := theme.S
	p := theme.Current
	inner := w - 4
	fields := f.visible()
	fl, ok := f.current()
	var lines []string
	head := s.Accent.Bold(true).Render("? " + nonEmpty(f.form.Title, "Question"))
	if len(fields) > 1 {
		head += s.Subtle.Render(fmt.Sprintf("  %d of %d", f.field+1, len(fields)))
	}
	if !ok {
		return frame(w, p.Accent, head, "", nil, "", "")
	}
	if fl.Title != "" {
		lines = append(lines, s.Bold.Render(fl.Title))
	}
	for _, l := range wrapText(fl.Description, inner) {
		lines = append(lines, s.Text.Render(l))
	}
	if fl.Type == "external" && fl.URL != "" {
		lines = append(lines, s.Info.Underline(true).Render(fl.URL), s.Subtle.Render("Open it in a browser, then press enter"))
		openURL(fl.URL)
	}
	lines = append(lines, "")
	if !f.custom || len(fl.Options) > 0 {
		for i, c := range f.choices(fl) {
			box := ""
			if fl.Type == "multiselect" && i < len(fl.Options) {
				box = "○ "
				if f.picked[i] {
					box = lipgloss.NewStyle().Foreground(p.Success).Render("● ")
				}
			}
			label := fmt.Sprintf("%d. %s%s", i+1, box, c)
			desc := ""
			if i < len(fl.Options) && fl.Options[i].Description != "" {
				desc = s.Subtle.Render("  " + ansi.Truncate(fl.Options[i].Description, max(10, inner-ansi.StringWidth(label)-4), "…"))
			}
			if i == f.cursor && !f.custom {
				lines = append(lines, lipgloss.NewStyle().Foreground(p.Primary).Bold(true).Render("❯ ")+s.Bold.Render(label)+desc)
			} else {
				lines = append(lines, "  "+s.Muted.Render(label)+desc)
			}
		}
	}
	if f.custom {
		f.input.SetWidth(inner - 4)
		lines = append(lines, "", lipgloss.NewStyle().Foreground(p.Accent).Render("› ")+f.input.View())
	}
	hint := "enter choose · esc dismiss"
	if fl.Type == "multiselect" {
		hint = "space toggle · enter confirm · esc dismiss"
	}
	return frame(w, p.Accent, head, "", padCard(lines), s.Subtle.Render(hint), "")
}

var openedURLs = map[string]bool{}

func openURL(u string) {
	if openedURLs[u] {
		return
	}
	openedURLs[u] = true
	switch runtime.GOOS {
	case "darwin":
		_ = exec.Command("open", u).Start()
	case "windows":
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", u).Start()
	default:
		_ = exec.Command("xdg-open", u).Start()
	}
}

// padCard keeps a blank line above the card content and trims trailing blanks.
func padCard(lines []string) []string {
	for len(lines) > 0 && strings.TrimSpace(ansi.Strip(lines[len(lines)-1])) == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}
