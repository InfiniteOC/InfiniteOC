package ui

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/api"
	"infiniteoc/infinitui/internal/render"
	"infiniteoc/infinitui/internal/theme"
)

// toolView is the rendered shape of one tool call.
type toolView struct {
	title string   // e.g. "Read"
	arg   string   // e.g. "src/main.go"
	note  string   // dim suffix on the header, e.g. "(42 lines)"
	body  []string // already styled lines (without the └ gutter)
	// hidden counts body lines cut by collapsing
	hidden int
}

type toolCtx struct {
	b        *api.Block
	in       map[string]any
	meta     map[string]any
	out      string // concatenated text content
	width    int
	expanded bool
	cwd      string
	store    *Store
	now      int64
}

func parseObj(raw json.RawMessage) map[string]any {
	m := map[string]any{}
	if len(raw) == 0 {
		return m
	}
	_ = json.Unmarshal(raw, &m)
	return m
}

func str(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			switch x := v.(type) {
			case string:
				return x
			case float64:
				return fmt.Sprint(x)
			case bool:
				return fmt.Sprint(x)
			}
		}
	}
	return ""
}

func (c toolCtx) rel(p string) string {
	if p == "" {
		return p
	}
	if c.cwd != "" && filepath.IsAbs(p) {
		if r, err := filepath.Rel(c.cwd, p); err == nil && !strings.HasPrefix(r, "..") {
			return r
		}
	}
	return p
}

// partialInput extracts string fields from tool input JSON that is still streaming.
func partialInput(s string) map[string]any {
	m := map[string]any{}
	if json.Unmarshal([]byte(s), &m) == nil {
		return m
	}
	// Close the JSON optimistically so headers can show the path/command while it streams.
	for _, tail := range []string{`"}`, `}`, `"]}`} {
		if json.Unmarshal([]byte(s+tail), &m) == nil {
			return m
		}
	}
	return m
}

func toolContext(b *api.Block, width int, expanded bool, cwd string, st *Store, now int64) toolCtx {
	c := toolCtx{b: b, width: width, expanded: expanded, cwd: cwd, store: st, now: now}
	if b.State != nil {
		if b.State.Status == "streaming" {
			c.in = partialInput(b.PartialInput)
		} else {
			c.in = parseObj(b.State.Input)
		}
		c.meta = parseObj(b.State.Metadata)
		var parts []string
		for _, ct := range b.State.Content {
			if ct.Type == "text" {
				parts = append(parts, ct.Text)
			}
		}
		c.out = strings.Join(parts, "\n")
	} else {
		c.in = map[string]any{}
		c.meta = map[string]any{}
	}
	return c
}

// renderTool dispatches to a per-tool renderer.
func renderTool(c toolCtx) toolView {
	name := c.b.Name
	switch name {
	case "read":
		return toolRead(c)
	case "edit", "write", "patch", "apply_patch", "multiedit":
		return toolEdit(c)
	case "shell", "bash":
		return toolShell(c)
	case "glob", "list", "ls":
		return toolGlob(c)
	case "grep":
		return toolGrep(c)
	case "webfetch":
		return toolFetch(c)
	case "websearch":
		return toolSearch(c)
	case "subagent", "task":
		return toolSubagent(c)
	case "question":
		return toolQuestion(c)
	case "skill":
		return toolSkill(c)
	}
	return toolGeneric(c)
}

func (c toolCtx) done() bool   { return c.b.State != nil && c.b.State.Status == "completed" }
func (c toolCtx) failed() bool { return c.b.State != nil && c.b.State.Status == "error" }

// collapse keeps the first n lines unless expanded.
func collapse(lines []string, n int, expanded bool) ([]string, int) {
	if expanded || len(lines) <= n {
		return lines, 0
	}
	return lines[:n], len(lines) - n
}

// tail keeps the last n lines unless expanded.
func tail(lines []string, n int, expanded bool) ([]string, int) {
	if expanded || len(lines) <= n {
		return lines, 0
	}
	return lines[len(lines)-n:], len(lines) - n
}

func dimLines(lines []string, width int) []string {
	st := theme.S.ToolResult
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		l = strings.ReplaceAll(l, "\t", "    ")
		if ansi.StringWidth(l) > width {
			l = ansi.Truncate(l, width-1, "…")
		}
		out = append(out, st.Render(l))
	}
	return out
}

func splitLines(s string) []string {
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

func toolRead(c toolCtx) toolView {
	path := c.rel(str(c.in, "path", "filePath", "file_path"))
	v := toolView{title: "Read", arg: path}
	if off := str(c.in, "offset"); off != "" {
		v.arg += ":" + off
	}
	if !c.done() {
		return v
	}
	lines := splitLines(c.out)
	var code []string
	header := ""
	if len(lines) > 0 && strings.HasPrefix(lines[0], "Read file ") {
		header = lines[0]
		lines = lines[1:]
	}
	for _, l := range lines {
		// "12: text" numbering from the read tool
		if i := strings.Index(l, ": "); i > 0 && i < 8 && isDigits(l[:i]) {
			code = append(code, l[i+2:])
		} else {
			code = append(code, l)
		}
	}
	n := len(code)
	if header != "" {
		if i := strings.LastIndex(header, "lines "); i >= 0 {
			v.note = header[i:]
		}
	}
	v.body = []string{theme.S.ToolResult.Render("Read " + plural(n, "line", "lines"))}
	if c.expanded && n > 0 {
		hl := render.HighlightLines(strings.Join(code, "\n"), render.LexerFor(path), nil)
		shown, hidden := collapse(hl, 400, false)
		for _, l := range shown {
			if ansi.StringWidth(l) > c.width {
				l = ansi.Truncate(l, c.width-1, "…")
			}
			v.body = append(v.body, l)
		}
		v.hidden = hidden
	}
	return v
}

func isDigits(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func toolEdit(c toolCtx) toolView {
	path := c.rel(str(c.in, "path", "filePath", "file_path"))
	title := map[string]string{"edit": "Update", "write": "Write", "patch": "Patch", "apply_patch": "Patch", "multiedit": "Update"}[c.b.Name]
	v := toolView{title: title, arg: path}
	files, _ := c.meta["files"].([]any)
	if !c.done() && !c.failed() {
		// While the input streams, preview the new content of a write.
		if c.b.Name == "write" {
			if content := str(c.in, "content"); content != "" {
				v.note = plural(strings.Count(content, "\n")+1, "line", "lines")
			}
		}
		return v
	}
	if c.failed() || len(files) == 0 {
		if c.failed() {
			return v
		}
		// write reports no diff: show what it wrote, framed like a code block.
		if content := str(c.in, "content"); c.b.Name == "write" && content != "" {
			lines := strings.Split(strings.TrimRight(content, "\n"), "\n")
			v.note = theme.S.Success.Render(fmt.Sprintf("+%d", len(lines)))
			shown, hidden := collapse(lines, 12, c.expanded)
			cw := min(c.width, max(40, longest(shown)+10))
			v.body = render.CodeBlock(path, strings.Join(shown, "\n"), cw, false)
			v.hidden = hidden
			return v
		}
		v.body = dimLines(splitLines(c.out), c.width)
		return v
	}
	maxRows := 14
	if c.expanded {
		maxRows = 0
	}
	if len(files) > 1 {
		v.arg = plural(len(files), "file", "files")
	}
	for i, f := range files {
		fd, _ := f.(map[string]any)
		file := c.rel(str(fd, "file"))
		rows, stat := render.ParseUnified(str(fd, "patch"))
		status := str(fd, "status")
		summary := fmt.Sprintf("%s %s", verbFor(status, c.b.Name), file)
		parts := []string{}
		if stat.Add > 0 {
			parts = append(parts, theme.S.Success.Render(fmt.Sprintf("+%d", stat.Add)))
		}
		if stat.Del > 0 {
			parts = append(parts, theme.S.Error.Render(fmt.Sprintf("-%d", stat.Del)))
		}
		line := theme.S.ToolResult.Render(summary)
		if len(parts) > 0 {
			line += " " + strings.Join(parts, " ")
		}
		if len(files) == 1 {
			// One file: the counts ride in the header and the diff follows directly.
			v.note = strings.Join(parts, " ")
			if status == "added" {
				v.note = theme.S.Info.Render("new") + " " + v.note
			}
		} else {
			if i > 0 {
				v.body = append(v.body, "")
			}
			v.body = append(v.body, line)
		}
		if len(rows) > 0 && (c.b.Name != "write" || c.expanded || status != "added" || len(rows) <= maxRows) {
			diff, hidden := render.RenderDiff(rows, render.DiffOptions{Filename: file, Width: c.width, MaxRows: maxRows})
			v.body = append(v.body, diff...)
			v.hidden += hidden
		} else if len(rows) > 0 {
			v.hidden += len(rows)
		}
	}
	return v
}

func verbFor(status, tool string) string {
	switch status {
	case "added":
		return "Created"
	case "deleted":
		return "Deleted"
	}
	if tool == "write" {
		return "Wrote"
	}
	return "Updated"
}

func toolShell(c toolCtx) toolView {
	cmd := str(c.in, "command", "cmd")
	first := strings.SplitN(cmd, "\n", 2)[0]
	if first != cmd {
		first += " …"
	}
	v := toolView{title: "Bash", arg: first}
	if d := str(c.in, "description"); d != "" && c.expanded {
		v.note = d
	}
	if !c.done() && !c.failed() {
		if c.b.State != nil && c.b.State.Status == "running" {
			if live := str(c.meta, "output"); live != "" {
				lines, _ := tail(splitLines(ansi.Strip(live)), 5, false)
				v.body = dimLines(lines, c.width)
			}
		}
		return v
	}
	if exit := str(c.meta, "exit"); exit != "" && exit != "0" {
		v.note = theme.S.Error.Render("exit " + exit)
	}
	if str(c.meta, "status") == "running" {
		v.note = theme.S.Info.Render("background")
	}
	out := ansi.Strip(c.out)
	lines := splitLines(out)
	if len(lines) == 0 {
		v.body = []string{theme.S.Subtle.Render("(no output)")}
		return v
	}
	if c.expanded {
		shown, hidden := collapse(lines, 500, false)
		v.body = shellLines(shown, c.width, looksLikeDiff(out))
		v.hidden = hidden
		return v
	}
	shown, earlier := tail(lines, 6, false)
	if earlier > 0 {
		v.body = append(v.body, theme.S.Subtle.Render(fmt.Sprintf("… %d earlier lines (click to expand)", earlier)))
	}
	v.body = append(v.body, shellLines(shown, c.width, looksLikeDiff(out))...)
	return v
}

func toolGlob(c toolCtx) toolView {
	pat := str(c.in, "pattern", "path")
	v := toolView{title: map[string]string{"glob": "Search", "list": "List", "ls": "List"}[c.b.Name], arg: c.rel(pat)}
	if p := str(c.in, "path"); p != "" && p != pat {
		v.note = "in " + c.rel(p)
	}
	if !c.done() {
		return v
	}
	lines := splitLines(c.out)
	v.body = []string{theme.S.ToolResult.Render("Found " + plural(len(lines), "match", "matches"))}
	if c.expanded {
		shown, hidden := collapse(lines, 200, false)
		v.body = append(v.body, dimLines(shown, c.width)...)
		v.hidden = hidden
	}
	return v
}

func toolGrep(c toolCtx) toolView {
	v := toolView{title: "Grep", arg: str(c.in, "pattern", "query")}
	if p := str(c.in, "path", "include"); p != "" {
		v.note = "in " + c.rel(p)
	}
	if !c.done() {
		return v
	}
	lines := splitLines(c.out)
	v.body = []string{theme.S.ToolResult.Render("Found " + plural(len(lines), "line", "lines"))}
	if c.expanded {
		shown, hidden := collapse(lines, 200, false)
		v.body = append(v.body, dimLines(shown, c.width)...)
		v.hidden = hidden
	}
	return v
}

func toolFetch(c toolCtx) toolView {
	u := str(c.in, "url")
	host := u
	if p, err := url.Parse(u); err == nil && p.Host != "" {
		host = p.Host + p.Path
	}
	v := toolView{title: "Fetch", arg: host}
	if !c.done() {
		return v
	}
	v.body = []string{theme.S.ToolResult.Render(fmt.Sprintf("Received %s", humanBytes(len(c.out))))}
	if c.expanded {
		shown, hidden := collapse(splitLines(c.out), 60, false)
		v.body = append(v.body, dimLines(shown, c.width)...)
		v.hidden = hidden
	}
	return v
}

func toolSearch(c toolCtx) toolView {
	v := toolView{title: "Web Search", arg: str(c.in, "query")}
	if !c.done() {
		return v
	}
	lines := splitLines(c.out)
	v.body = dimLines(firstN(lines, 1), c.width)
	if c.expanded {
		shown, hidden := collapse(lines, 80, false)
		v.body = dimLines(shown, c.width)
		v.hidden = hidden
	}
	return v
}

func firstN(lines []string, n int) []string {
	if len(lines) > n {
		return lines[:n]
	}
	return lines
}

func toolSkill(c toolCtx) toolView {
	return toolView{title: "Skill", arg: str(c.in, "name", "id", "skill")}
}

func toolQuestion(c toolCtx) toolView {
	v := toolView{title: "Question"}
	qs, _ := c.in["questions"].([]any)
	if len(qs) > 0 {
		v.arg = plural(len(qs), "question", "questions")
	}
	if c.done() {
		pairs := answerPair.FindAllStringSubmatch(c.out, -1)
		if len(pairs) == 0 {
			v.body = dimLines(splitLines(c.out), c.width)
			return v
		}
		for _, p := range pairs {
			q := ansi.Truncate(p[1], c.width/2, "…")
			v.body = append(v.body, theme.S.ToolResult.Render(q+" → ")+theme.S.Text.Bold(true).Render(p[2]))
		}
	}
	return v
}

// answerPair reads `"question"="answer"` from the question tool's result.
var answerPair = regexp.MustCompile(`"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"`)

// toolSubagent shows the child session's live progress.
func toolSubagent(c toolCtx) toolView {
	agent := str(c.in, "agent", "subagent_type")
	desc := str(c.in, "description")
	v := toolView{title: "Task", arg: desc}
	if agent != "" {
		v.title = "Task·" + agent
	}
	child := str(c.meta, "sessionID")
	if child == "" || c.store == nil {
		if c.done() {
			v.body = dimLines(firstN(splitLines(c.out), 3), c.width)
		}
		return v
	}
	d, ok := c.store.Get(child)
	if !ok {
		return v
	}
	tools := 0
	var lastTool *api.Block
	var tokens float64
	for _, m := range d.msgs {
		if m.Type != "assistant" {
			continue
		}
		if m.Tokens != nil {
			tokens += m.Tokens.Output
		}
		for _, b := range m.Content {
			if b.Type == "tool" {
				tools++
				lastTool = b
			}
		}
	}
	parts := []string{plural(tools, "tool use", "tool uses")}
	if tokens > 0 {
		parts = append(parts, humanTokens(tokens)+" tokens")
	}
	if !c.done() && lastTool != nil {
		lc := toolContext(lastTool, c.width, false, c.cwd, nil, c.now)
		lv := renderTool(lc)
		v.body = append(v.body, theme.S.Muted.Render("↳ "+lv.title+" "+ansi.Truncate(lv.arg, c.width-8, "…")))
	}
	if c.done() && c.expanded {
		v.body = append(v.body, dimLines(splitLines(c.out), c.width)...)
	}
	v.body = append(v.body, theme.S.Subtle.Render(strings.Join(parts, " · ")+" · click to open"))
	return v
}

func toolGeneric(c toolCtx) toolView {
	title := c.b.Name
	// MCP tools arrive as server_tool; show them as "server · tool".
	if i := strings.Index(title, "_"); i > 0 && c.store != nil {
		for _, s := range c.store.mcp {
			if strings.HasPrefix(title, s.Name+"_") {
				title = s.Name + " · " + strings.TrimPrefix(title, s.Name+"_")
				break
			}
		}
	}
	v := toolView{title: title, arg: summarizeArgs(c.in, c.width/2)}
	if !c.done() {
		return v
	}
	lines := splitLines(c.out)
	shown, hidden := collapse(lines, 4, c.expanded)
	if c.expanded {
		shown, hidden = collapse(lines, 300, false)
	}
	v.body = dimLines(shown, c.width)
	v.hidden = hidden
	return v
}

// summarizeArgs renders `key: value, …` from the input object.
func summarizeArgs(in map[string]any, width int) string {
	if len(in) == 0 {
		return ""
	}
	// Prefer a single obvious argument.
	for _, k := range []string{"path", "filePath", "file", "command", "query", "pattern", "url", "name", "id", "action", "description"} {
		if v := str(in, k); v != "" {
			return ansi.Truncate(strings.SplitN(v, "\n", 2)[0], width, "…")
		}
	}
	var parts []string
	for k, v := range in {
		b, _ := json.Marshal(v)
		parts = append(parts, k+": "+string(b))
	}
	return ansi.Truncate(strings.Join(parts, ", "), width, "…")
}

func humanBytes(n int) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d bytes", n)
}

func humanTokens(n float64) string {
	switch {
	case n >= 1e6:
		return fmt.Sprintf("%.1fM", n/1e6)
	case n >= 1e3:
		return fmt.Sprintf("%.1fk", n/1e3)
	}
	return fmt.Sprintf("%.0f", n)
}

// toolHeader styles "Title arg note".
func toolHeader(v toolView, width int) string {
	s := theme.S
	title := s.ToolName.Render(v.title)
	arg := ""
	if v.arg != "" {
		arg = " " + lipgloss.NewStyle().Foreground(theme.Current.Text).Render(v.arg)
	}
	note := ""
	if v.note != "" {
		note = " " + s.Subtle.Render(v.note)
	}
	h := title + arg + note
	if ansi.StringWidth(h) > width {
		h = ansi.Truncate(h, width-1, "…")
	}
	return h
}

func longest(lines []string) int {
	n := 0
	for _, l := range lines {
		n = max(n, ansi.StringWidth(strings.ReplaceAll(l, "\t", "    ")))
	}
	return n
}

func looksLikeDiff(out string) bool {
	return strings.Contains(out, "\n@@ ") || strings.HasPrefix(out, "diff --git") || strings.Contains(out, "\ndiff --git")
}

// shellLines dims command output; diff output keeps its + and - colours.
func shellLines(lines []string, width int, diff bool) []string {
	if !diff {
		return dimLines(lines, width)
	}
	p := theme.Current
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		l = strings.ReplaceAll(l, "\t", "    ")
		if ansi.StringWidth(l) > width {
			l = ansi.Truncate(l, width-1, "…")
		}
		st := theme.S.ToolResult
		switch {
		case strings.HasPrefix(l, "+++"), strings.HasPrefix(l, "---"), strings.HasPrefix(l, "diff "):
			st = lipgloss.NewStyle().Foreground(p.Text).Bold(true)
		case strings.HasPrefix(l, "@@"):
			st = lipgloss.NewStyle().Foreground(p.Info)
		case strings.HasPrefix(l, "+"):
			st = lipgloss.NewStyle().Foreground(p.DiffAdd)
		case strings.HasPrefix(l, "-"):
			st = lipgloss.NewStyle().Foreground(p.DiffDel)
		}
		out = append(out, st.Render(l))
	}
	return out
}
