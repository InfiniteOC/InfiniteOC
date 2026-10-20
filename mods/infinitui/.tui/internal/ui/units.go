package ui

import (
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/api"
	"infiniteoc/infinitui/internal/render"
	"infiniteoc/infinitui/internal/theme"
)

// A unit is one visual row group in the transcript: a message, one assistant block, or a group of
// exploration tool calls folded together.
type unit struct {
	kind   string // msg | user | text | reasoning | tool | group | retry | aerr | idle
	key    string // owner key for clicks and expansion
	msg    *api.Message
	block  *api.Block
	blocks []*api.Block // group members (tools and absorbed thinking)
	msgs   []*api.Message
	turn   int
	idx    int   // message index (idle rows look back from here)
	start  int64 // turn start, for idle rows
	last   bool  // last block of a still-streaming message
}

// exploring tools only read; runs of them fold into one "Explored" group.
func exploring(b *api.Block) bool {
	if b.Type != "tool" {
		return false
	}
	switch b.Name {
	case "read", "glob", "grep", "list", "ls", "webfetch", "websearch", "skill", "list_mcp_resources", "read_mcp_resource":
		return b.State == nil || b.State.Status != "error"
	}
	return false
}

func (u unit) live() bool {
	switch u.kind {
	case "tool":
		b := u.block
		return b.State == nil || b.State.Status == "streaming" || b.State.Status == "running" || b.Name == "subagent" || b.Name == "task"
	case "text", "reasoning":
		return u.msg.Time.Completed == 0
	case "group":
		for _, b := range u.blocks {
			if b.Type == "tool" && (b.State == nil || b.State.Status == "streaming" || b.State.Status == "running") {
				return true
			}
			if b.Type == "reasoning" && b.Time.Completed == 0 {
				return true
			}
		}
		return false
	case "user", "msg", "shell":
		return live(u.msg)
	case "idle":
		// The summary glows for a moment when a turn finishes.
		return u.msg.Outcome == "succeeded" && time.Now().UnixMilli()-u.msg.Time.Created < donePulse
	}
	return false
}

// units flattens the session into render units, folding exploration runs.
func buildUnits(sd *sessionData) []unit {
	var us []unit
	turn := 0
	var turnStart int64
	for i, m := range sd.msgs {
		if sd.info.Revert != nil && m.ID >= sd.info.Revert.MessageID {
			break
		}
		switch m.Type {
		case "user":
			if !m.Pending {
				turn++
				turnStart = m.Time.Created
			}
			us = append(us, unit{kind: "user", key: blockKey(m.ID, "user"), msg: m, turn: turn})
		case "assistant":
			for j, b := range m.Content {
				if b.Type == "text" && strings.TrimSpace(b.Text) == "" {
					continue
				}
				id := b.ID
				if id == "" {
					id = fmt.Sprint(j)
				}
				us = append(us, unit{kind: b.Type, key: blockKey(m.ID, id), msg: m, block: b, last: j == len(m.Content)-1})
			}
			if m.Retry != nil {
				us = append(us, unit{kind: "retry", key: blockKey(m.ID, "retry"), msg: m})
			}
			if m.Error != nil {
				us = append(us, unit{kind: "aerr", key: blockKey(m.ID, "err"), msg: m})
			}
		case "shell":
			us = append(us, unit{kind: "shell", key: blockKey(m.ID, "shell"), msg: m})
		case "idle":
			us = append(us, unit{kind: "idle", key: blockKey(m.ID, "idle"), msg: m, idx: i, start: turnStart})
		default:
			us = append(us, unit{kind: "msg", key: blockKey(m.ID, "msg"), msg: m})
		}
	}
	return foldExploration(us)
}

func foldExploration(us []unit) []unit {
	var out []unit
	for i := 0; i < len(us); i++ {
		u := us[i]
		if u.kind != "tool" || !exploring(u.block) {
			out = append(out, u)
			continue
		}
		last, tools := i, 1
		for k := i + 1; k < len(us); k++ {
			x := us[k]
			if x.kind == "tool" && exploring(x.block) {
				last = k
				tools++
				continue
			}
			if x.kind == "reasoning" {
				continue
			}
			break
		}
		if tools < 2 {
			out = append(out, u)
			continue
		}
		g := unit{kind: "group", key: u.key + "|group"}
		seen := map[*api.Message]bool{}
		for _, x := range us[i : last+1] {
			g.blocks = append(g.blocks, x.block)
			if !seen[x.msg] {
				seen[x.msg] = true
				g.msgs = append(g.msgs, x.msg)
			}
		}
		g.msg = u.msg
		out = append(out, g)
		i = last
	}
	return out
}

func (t *Transcript) unitKey(u unit, sd *sessionData, o renderOpts) string {
	ver := 0
	if u.kind == "group" {
		for _, m := range u.msgs {
			ver += sd.versions[m.ID]*31 + t.expandGen[m.ID]
		}
	} else if u.msg != nil {
		ver = sd.versions[u.msg.ID]*31 + t.expandGen[u.msg.ID]
	}
	return fmt.Sprintf("%s|%d|%d|%v|%s|%v|%d|%d", u.key, ver, o.width, o.expandAll, theme.Current.Name, o.showThought, o.store.gen, u.turn)
}

// Build re-renders the session into lines. Each turn is a prompt band followed by a thread: the
// assistant's blocks hang off one gradient line that ends in the turn's summary.
func (t *Transcript) Build(sd *sessionData, o renderOpts) {
	t.lines = t.lines[:0]
	t.owners = t.owners[:0]
	t.msgAt = t.msgAt[:0]
	if sd == nil {
		return
	}
	pad := "  "
	var turn []threadRow // assistant part of the current turn, threaded on flush
	closed := false      // the turn ended with a summary row
	clear(t.unitStart)
	emit := func(r threadRow) {
		if _, ok := t.unitStart[r.owner]; !ok && r.owner != "" {
			t.unitStart[r.owner] = len(t.lines)
		}
		t.lines = append(t.lines, pad+r.line)
		t.owners = append(t.owners, r.owner)
		t.msgAt = append(t.msgAt, r.msg)
	}
	var turnKey strings.Builder // identity of the turn's content; empty once something in it is live
	turnLive := false
	flush := func() {
		if len(turn) == 0 {
			return
		}
		// A finished turn decorates the same way every frame: reuse it.
		k := turnKey.String()
		first := turn[0].owner
		for _, r := range turn {
			if r.owner != "" {
				first = r.owner
				break
			}
		}
		if c, ok := t.turnCache[first]; ok && !turnLive && c.key == k {
			for _, r := range c.rows {
				emit(r)
			}
		} else {
			threadTurn(turn, closed)
			if !turnLive {
				t.turnCache[first] = cachedTurn{key: k, rows: append([]threadRow(nil), turn...)}
			}
			for _, r := range turn {
				emit(r)
			}
		}
		turn = turn[:0]
		closed = false
		turnKey.Reset()
		turnLive = false
	}
	started := false
	lastUser := false
	for _, u := range buildUnits(sd) {
		var lines, owners []string
		key := t.unitKey(u, sd, o)
		if u.kind != "user" && u.kind != "shell" {
			turnKey.WriteString(key)
			turnKey.WriteByte(0)
			turnLive = turnLive || u.live()
		}
		if c, ok := t.cache[u.key]; ok && c.key == key && !u.live() {
			lines, owners = c.lines, c.owners
		} else {
			lines = renderUnit(u, sd, o)
			owners = make([]string, len(lines))
			for i := range owners {
				owners[i] = u.key
			}
			if !u.live() {
				t.cache[u.key] = cachedLines{key: key, lines: lines, owners: owners}
			}
		}
		if len(lines) == 0 {
			continue
		}
		msgID := ""
		if u.msg != nil {
			msgID = u.msg.ID
		}
		if u.kind == "shell" {
			// A command you ran opens its own band; its output hangs off a thread like a turn.
			flush()
			if started {
				emit(threadRow{msg: msgID})
			}
			emit(threadRow{lines[0], owners[0], msgID})
			for j, l := range lines[1:] {
				turn = append(turn, threadRow{l, owners[j+1], msgID})
			}
			started = true
			continue
		}
		lastUser = u.kind == "user" && !u.msg.Pending
		if u.kind == "user" {
			flush()
			if started {
				emit(threadRow{msg: msgID})
			}
			for j, l := range lines {
				emit(threadRow{l, owners[j], msgID})
			}
			started = true
			continue
		}
		if started || len(turn) > 0 {
			// One spacer row between blocks; it carries the thread.
			turn = append(turn, threadRow{msg: msgID})
		}
		started = true
		for j, l := range lines {
			turn = append(turn, threadRow{l, owners[j], msgID})
		}
		if u.kind == "idle" && len(lines) == 1 {
			closed = true
			turnKey.WriteString("closed")
		}
	}
	if lastUser && o.waiting != "" {
		// Sent, nothing back yet: a pending node keeps the thread alive.
		p := theme.Current
		dot := lipgloss.NewStyle().Foreground(theme.Blend([]colorT{p.Primary, p.Accent}, 0.5+0.5*math.Sin(float64(o.frame)/3))).Render("◌")
		turn = append(turn, threadRow{}, threadRow{line: dot + " " + shimmer(o.waiting, o.frame)})
		turnLive = true
	}
	flush()
	if sd.info.Revert != nil {
		n := 0
		for _, m := range sd.msgs {
			if m.ID >= sd.info.Revert.MessageID && m.Type == "user" {
				n++
			}
		}
		t.lines = append(t.lines, "", pad+theme.S.Warning.Render(fmt.Sprintf("↶ %s undone", plural(n, "message", "messages")))+theme.S.Subtle.Render(" · /redo restores · sending a new message makes it permanent"))
		t.owners = append(t.owners, "", "")
		t.msgAt = append(t.msgAt, "", "")
	}
}

type threadRow struct{ line, owner, msg string }

type cachedTurn struct {
	key  string
	rows []threadRow
}

// threadTurn draws the turn's thread in the 2-column gutter: blank gutters become a gradient line,
// block glyphs stay as nodes on it, and a closing summary row gets the ╰─ terminator.
func threadTurn(rows []threadRow, closed bool) {
	p := theme.Current
	bg := p.Bg
	if bg == nil {
		bg = p.Panel
	}
	n := len(rows)
	for i := range rows {
		r := &rows[i]
		c := theme.Blend([]colorT{p.Primary, p.Accent}, float64(i)/float64(max(1, n-1)))
		st := lipgloss.NewStyle().Foreground(theme.Blend([]colorT{c, bg}, 0.45))
		switch {
		case closed && i == n-1:
			r.line = lipgloss.NewStyle().Foreground(c).Render("╰─") + " " + r.line
		case r.line == "":
			r.line = st.Render("│")
		case strings.HasPrefix(ansi.Strip(r.line), "  "):
			r.line = st.Render("│") + " " + ansi.TruncateLeft(r.line, 2, "")
		}
	}
}

func renderUnit(u unit, sd *sessionData, o renderOpts) []string {
	s := theme.S
	expanded := o.expandAll || o.expanded[u.key]
	switch u.kind {
	case "user":
		return renderTurn(u, o, expanded)
	case "shell":
		return renderShellBand(u.msg, o, expanded)
	case "text":
		return renderText(u, o)
	case "reasoning":
		return renderThinking(u.block, u.msg.Time.Completed == 0, o, expanded)
	case "tool":
		return renderToolUnit(u.block, o, expanded)
	case "group":
		return renderGroup(u, o, expanded)
	case "retry":
		m := u.msg
		msg := ""
		if m.Retry.Error != nil {
			msg = " · " + m.Retry.Error.Message
		}
		wait := ""
		if m.Retry.At > o.now {
			wait = fmt.Sprintf(" in %s", humanDuration(time.Duration(m.Retry.At-o.now)*time.Millisecond))
		}
		return []string{s.Warning.Render(fmt.Sprintf("↻ retrying (attempt %d)%s", m.Retry.Attempt, wait)) + s.Subtle.Render(ansi.Truncate(msg, o.width-30, "…"))}
	case "aerr":
		return errorBox(u.msg.Error.Message, o.width)
	case "idle":
		return renderIdle(u.msg, sd, u.idx, u.start, o)
	}
	lines, _ := renderMessage(u.msg, sd, 0, 0, o)
	return lines
}

// donePulse is how long (ms) a finished turn's summary glows.
const donePulse = 1600

// mdWidth caps prose at a readable measure on wide terminals.
func mdWidth(w int) int { return min(w-2, 104) }

// renderTurn draws the prompt as a full-width band: turn badge, text, time.
func renderTurn(u unit, o renderOpts, expanded bool) []string {
	s := theme.S
	p := theme.Current
	m := u.msg
	w := o.width
	band := lipgloss.NewStyle().Background(p.Panel)
	text := lipgloss.NewStyle().Background(p.Panel).Foreground(p.Text).Bold(true)
	badgeSt := lipgloss.NewStyle().Background(p.Accent).Foreground(p.Bg).Bold(true)
	badge := fmt.Sprintf(" %d ", u.turn)
	right := time.UnixMilli(m.Time.Created).Format("15:04")
	if m.Pending {
		badgeSt = lipgloss.NewStyle().Background(p.PanelAlt).Foreground(p.Muted)
		text = text.Foreground(p.Muted).Bold(false)
		badge = " … "
		right = "queued"
	}
	indent := ansi.StringWidth(badge) + 2
	wrapped := wrapText(goalText(strings.TrimRight(m.Text, "\n")), w-indent-ansi.StringWidth(right)-3)
	shown, hidden := collapse(wrapped, 10, expanded)
	if hidden > 0 {
		shown = append(shown, fmt.Sprintf("… +%d lines (click to expand)", hidden))
	}
	var extras []string
	for _, f := range m.Files {
		if f.Mention == nil {
			extras = append(extras, "⊕ "+nonEmpty(f.Name, f.Mime))
		}
	}
	var out []string
	for i, l := range shown {
		lead := band.Render(strings.Repeat(" ", indent))
		if i == 0 {
			lead = badgeSt.Render(badge) + band.Render("  ")
		}
		st := text
		if hidden > 0 && i == len(shown)-1 {
			st = band.Foreground(p.Subtle)
		}
		line := lead + st.Render(l)
		tail := ""
		if i == 0 {
			tail = band.Foreground(p.Muted).Render(right + " ")
		}
		gap := w - ansi.StringWidth(line) - ansi.StringWidth(tail)
		out = append(out, line+band.Render(strings.Repeat(" ", max(1, gap)))+tail)
	}
	if len(extras) > 0 {
		out = append(out, strings.Repeat(" ", indent)+s.Subtle.Render(strings.Join(extras, "  ")))
	}
	return out
}

func renderText(u unit, o renderOpts) []string {
	text := strings.TrimSpace(u.block.Text)
	streaming := u.msg.Time.Completed == 0 && u.last
	if streaming {
		if n, ok := o.reveal[u.block]; ok && n < len(text) {
			text = cutRunes(text, n)
		}
	}
	md := render.Rich(text, mdWidth(o.width), streaming)
	mark := lipgloss.NewStyle().Foreground(theme.Current.Primary).Render("◆") + " "
	return indentLines(md, mark, "  ")
}

// cutRunes shortens s to at most n bytes without splitting a character.
func cutRunes(s string, n int) string {
	if n >= len(s) {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func renderThinking(b *api.Block, streaming bool, o renderOpts, expanded bool) []string {
	s := theme.S
	p := theme.Current
	text := strings.TrimSpace(b.Text)
	open := b.Time.Completed == 0 && streaming
	if text == "" && !open {
		return nil
	}
	// Trivial completed thoughts are noise; ctrl+o or /thinking-view shows them.
	if !open && !expanded && !o.showThought && b.Time.Completed > 0 && b.Time.Completed-b.Time.Created < 3000 {
		return nil
	}
	title, body := splitThinkingTitle(text)
	mark := lipgloss.NewStyle().Foreground(p.Accent).Render("∴")
	var head string
	if open {
		head = mark + " " + shimmer(nonEmpty(title, "Thinking")+"…", o.frame)
	} else {
		label := "Thought"
		if b.Time.Created > 0 && b.Time.Completed > b.Time.Created {
			label += " for " + humanDuration(time.Duration(b.Time.Completed-b.Time.Created)*time.Millisecond)
		}
		if title != "" {
			label += " · " + title
		}
		head = mark + " " + s.Muted.Italic(true).Render(label)
	}
	lines := []string{head}
	st := lipgloss.NewStyle().Foreground(p.Muted).Italic(true)
	if expanded || o.showThought {
		for _, l := range wrapText(body, mdWidth(o.width)-2) {
			lines = append(lines, "  "+st.Render(l))
		}
	} else if open {
		for _, l := range lastLines(wrapText(body, mdWidth(o.width)-2), 2) {
			lines = append(lines, "  "+s.Subtle.Italic(true).Render(l))
		}
	}
	return lines
}

func renderToolUnit(b *api.Block, o renderOpts, expanded bool) []string {
	s := theme.S
	w := o.width
	c := toolContext(b, w-5, expanded, o.cwd, o.store, o.now)
	v := renderTool(c)
	head := statusGlyph(b.State, o.frame) + " " + toolHeader(v, w-2)
	if b.State != nil && b.State.Status == "running" && b.Time.Ran > 0 {
		if el := o.now - b.Time.Ran; el > 2000 {
			head += s.Subtle.Render(" " + humanDuration(time.Duration(el)*time.Millisecond))
		}
	}
	lines := []string{head}
	body := v.body
	if b.State != nil && b.State.Status == "error" && b.State.Error != nil {
		msg := nonEmpty(b.State.Error.Message, b.State.Error.Type)
		for _, l := range wrapText(msg, w-6) {
			body = append(body, s.Error.Render(l))
		}
	}
	if v.hidden > 0 {
		body = append(body, s.Subtle.Render(fmt.Sprintf("… +%d lines (click or ctrl+o to expand)", v.hidden)))
	}
	return append(lines, gutterLines(body)...)
}

func gutterLines(body []string) []string {
	out := make([]string, 0, len(body))
	gutter := theme.S.Subtle.Render("  ╰  ")
	for j, l := range body {
		if j == 0 {
			out = append(out, gutter+l)
		} else {
			out = append(out, "     "+l)
		}
	}
	return out
}

// renderGroup folds a run of read-only tool calls into one line, or lists them when expanded.
func renderGroup(u unit, o renderOpts, expanded bool) []string {
	s := theme.S
	p := theme.Current
	counts := map[string]int{}
	var args []string
	running := false
	var tools []*api.Block
	for _, b := range u.blocks {
		if b.Type != "tool" {
			continue
		}
		tools = append(tools, b)
		if b.State == nil || b.State.Status == "running" || b.State.Status == "streaming" {
			running = true
		}
		v := renderTool(toolContext(b, o.width, false, o.cwd, o.store, o.now))
		counts[groupNoun(b.Name)]++
		if v.arg != "" {
			args = append(args, v.arg)
		}
	}
	var parts []string
	for _, n := range []string{"file", "search", "listing", "page", "web search", "skill", "resource"} {
		if c := counts[n]; c > 0 {
			parts = append(parts, plural(c, n, pluralNoun(n)))
		}
	}
	glyph := lipgloss.NewStyle().Foreground(p.Success).Render("●")
	verb := "Explored"
	if running {
		glyph = lipgloss.NewStyle().Foreground(p.Primary).Render(spinnerFrames[o.frame%len(spinnerFrames)])
		verb = "Exploring"
	}
	if len(counts) == 1 && counts["file"] > 0 {
		verb = map[bool]string{true: "Reading", false: "Read"}[running]
	}
	head := glyph + " " + s.ToolName.Render(verb) + " " + s.Text.Render(strings.Join(parts, ", "))
	if !expanded {
		head += s.Subtle.Render("  ·  click to list")
		list := strings.Join(args, s.Subtle.Render(" · "))
		return []string{head, theme.S.Subtle.Render("  ╰  ") + s.Muted.Render(ansi.Truncate(list, o.width-6, "…"))}
	}
	lines := []string{head}
	for _, b := range u.blocks {
		var sub []string
		if b.Type == "reasoning" {
			sub = renderThinking(b, false, o, o.expandAll)
		} else {
			sub = renderToolUnit(b, o, o.expandAll)
		}
		for i, l := range sub {
			if i == 0 {
				lines = append(lines, s.Subtle.Render("  │ ")+l)
			} else {
				lines = append(lines, s.Subtle.Render("  │ ")+l)
			}
		}
	}
	_ = tools
	return lines
}

func groupNoun(tool string) string {
	switch tool {
	case "read":
		return "file"
	case "glob", "grep":
		return "search"
	case "list", "ls":
		return "listing"
	case "webfetch":
		return "page"
	case "websearch":
		return "web search"
	case "skill":
		return "skill"
	}
	return "resource"
}

func pluralNoun(n string) string {
	switch n {
	case "search", "web search":
		return n + "es"
	}
	return n + "s"
}

// renderIdle closes a turn with a right-aligned summary.
func renderIdle(m *api.Message, sd *sessionData, idx int, turnStart int64, o renderOpts) []string {
	s := theme.S
	var out float64
	var model *api.ModelRef
	for i := idx - 1; i >= 0; i-- {
		x := sd.msgs[i]
		if x.Type == "user" && !x.Pending {
			break
		}
		if x.Type == "assistant" {
			if x.Tokens != nil {
				out += x.Tokens.Output + x.Tokens.Reasoning
			}
			if model == nil {
				model = x.Model
			}
		}
	}
	switch m.Outcome {
	case "interrupted":
		return []string{s.Warning.Render("interrupted") + s.Subtle.Render(" · tell it what to do instead")}
	case "failed":
		msg := "The run failed"
		if m.Error != nil && m.Error.Message != "" {
			msg = m.Error.Message
		}
		return errorBox(msg, o.width)
	}
	if turnStart == 0 || model == nil {
		return nil
	}
	var parts []string
	if d := m.Time.Created - turnStart; d > 0 {
		parts = append(parts, humanDuration(time.Duration(d)*time.Millisecond))
	}
	if out > 0 {
		parts = append(parts, "↓ "+humanTokens(out)+" tokens")
	}
	name := model.ID
	if mm, ok := o.store.Model(*model); ok {
		name = mm.Name
	}
	if model.Variant != "" && model.Variant != "default" {
		name += " " + model.Variant
	}
	parts = append(parts, name)
	label := strings.Join(parts, " · ")
	if age := o.now - m.Time.Created; age >= 0 && age < donePulse {
		t := float64(age) / donePulse
		c := theme.Blend([]colorT{theme.Current.Success, theme.Current.Subtle}, t*t)
		return []string{lipgloss.NewStyle().Foreground(c).Render("✓ " + label)}
	}
	return []string{s.Subtle.Render(label)}
}

// renderShellBand draws a `!command` as a band with a $ badge, then its output.
func renderShellBand(m *api.Message, o renderOpts, expanded bool) []string {
	s := theme.S
	p := theme.Current
	w := o.width
	band := lipgloss.NewStyle().Background(p.Panel)
	badge := lipgloss.NewStyle().Background(p.Info).Foreground(p.Bg).Bold(true).Render(" $ ")
	status := band.Foreground(p.Muted).Render(time.UnixMilli(m.Time.Created).Format("15:04") + " ")
	switch {
	case m.Status == "running":
		status = band.Foreground(p.Primary).Render(spinnerFrames[o.frame%len(spinnerFrames)] + " running ")
	case m.Exit != nil && *m.Exit != 0:
		status = band.Foreground(p.Error).Bold(true).Render(fmt.Sprintf("exit %d ", *m.Exit))
	case m.Status == "timeout" || m.Status == "killed":
		status = band.Foreground(p.Error).Render(m.Status + " ")
	}
	cmd := band.Foreground(p.Text).Bold(true).Render(ansi.Truncate(m.Command, w-ansi.StringWidth(status)-8, "…"))
	line := badge + band.Render("  ") + cmd
	out := []string{line + band.Render(strings.Repeat(" ", max(1, w-ansi.StringWidth(line)-ansi.StringWidth(status)))) + status}
	if m.Output != nil {
		lines := splitLines(ansi.Strip(m.Output.Output))
		shown, hidden := tail(lines, 12, expanded || o.expandAll)
		if hidden > 0 {
			out = append(out, "  "+s.Subtle.Render(fmt.Sprintf("… %d earlier lines (click to expand)", hidden)))
		}
		for _, l := range dimLines(shown, w-4) {
			out = append(out, "  "+l)
		}
	}
	return out
}
