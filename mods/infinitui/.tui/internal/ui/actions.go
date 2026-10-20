package ui

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"

	"infiniteoc/infinitui/internal/api"
)

// --- result messages ---

type errMsg struct {
	op  string
	err error
}

type bootMsg struct {
	dir    string
	active map[string]struct{ Type string }
	cont   string // session to continue
}

type catalogMsg struct {
	core       bool // models, agents, providers, config; otherwise the slower extras
	agents     []api.Agent
	models     []api.Model
	providers  []api.Provider
	commands   []api.Command
	skills     []api.Skill
	references []api.Reference
	mcp        []api.MCPServer
	vcs        api.VCS
	config     []api.ConfigEntry
	features   []api.RPCFeature
}

type sessionMsg struct{ info api.Session }

type historyMsg struct {
	preview   bool // a picker preview, not the open session
	sessionID string
	msgs      []*api.Message
	older     string
	prepend   bool
	perms     []api.PermissionRequest
	forms     []api.Form
	inbox     []api.InboxItem
}

type messageMsg struct {
	sessionID string
	msg       *api.Message
}

type sentMsg struct{ err error }

type toastMsg struct {
	variant, title, text string
	d                    time.Duration
}

type sessionsMsg struct{ list []api.Session }

type editorMsg struct {
	text string
	err  error
}

func (a *App) bg() context.Context { return a.ctx }

func timeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, d)
}

// bootstrap runs once after the first connect.
func (a *App) bootstrap() tea.Cmd {
	c := a.client
	opt := a.opt
	return func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 15*time.Second)
		defer cancel()
		res := bootMsg{dir: c.Directory}
		if dir, err := c.CanonicalDirectory(ctx, c.Directory); err == nil && dir != "" {
			res.dir = dir
		}
		res.active, _ = c.Active(ctx)
		if opt.Continue && opt.SessionID == "" {
			list, err := c.SessionList(ctx, 1, "", true, res.dir)
			if err == nil && len(list) > 0 {
				res.cont = list[0].ID
			}
		}
		return res
	}
}

// resync refreshes after a reconnect: events sent while away are lost.
func (a *App) resync() tea.Cmd {
	cmds := []tea.Cmd{func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 10*time.Second)
		defer cancel()
		active, err := a.client.Active(ctx)
		if err != nil {
			return errMsg{"active", err}
		}
		return bootMsg{dir: a.cwd, active: active, cont: "\x00resync"}
	}}
	if a.sessionID != "" {
		cmds = append(cmds, a.fetchSession(a.sessionID), a.loadHistory(a.sessionID, false))
	}
	return tea.Batch(cmds...)
}

// loadCatalogs fetches everything location-scoped in parallel. The core (models, agents, providers,
// config) arrives on its own so the composer is labelled right away; MCP status can take a while.
func (a *App) loadCatalogs() tea.Cmd {
	c := a.client
	core := func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 20*time.Second)
		defer cancel()
		r := catalogMsg{core: true}
		var err error
		var wg sync.WaitGroup
		wg.Add(4)
		go func() { defer wg.Done(); r.models, err = c.Models(ctx) }()
		go func() { defer wg.Done(); r.agents, _ = c.Agents(ctx) }()
		go func() { defer wg.Done(); r.providers, _ = c.Providers(ctx) }()
		go func() { defer wg.Done(); r.config, _ = c.Config(ctx) }()
		wg.Wait()
		if err != nil {
			return errMsg{"load models", err}
		}
		return r
	}
	extra := func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 30*time.Second)
		defer cancel()
		var r catalogMsg
		var wg sync.WaitGroup
		wg.Add(6)
		go func() { defer wg.Done(); r.commands, _ = c.Commands(ctx) }()
		go func() { defer wg.Done(); r.skills, _ = c.Skills(ctx) }()
		go func() { defer wg.Done(); r.references, _ = c.References(ctx) }()
		go func() { defer wg.Done(); r.mcp, _ = c.MCP(ctx) }()
		go func() { defer wg.Done(); r.vcs, _ = c.VCS(ctx) }()
		go func() { defer wg.Done(); r.features, _ = c.Features(ctx) }()
		wg.Wait()
		return r
	}
	return tea.Batch(core, extra)
}

func (a *App) fetchSession(id string) tea.Cmd {
	if id == "" || id == "global" {
		return nil
	}
	return func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 10*time.Second)
		defer cancel()
		s, err := a.client.Session(ctx, id)
		if err != nil {
			return nil
		}
		return sessionMsg{s}
	}
}

func (a *App) fetchMessage(sid, mid string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 10*time.Second)
		defer cancel()
		m, err := a.client.Message(ctx, sid, mid)
		if err != nil || m == nil {
			return nil
		}
		return messageMsg{sid, m}
	}
}

func (a *App) loadHistory(id string, older bool) tea.Cmd {
	cursor := ""
	if older {
		d, ok := a.store.Get(id)
		if !ok || d.older == "" {
			return nil
		}
		cursor = d.older
	}
	c := a.client
	return func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 20*time.Second)
		defer cancel()
		msgs, next, err := c.Messages(ctx, id, 60, cursor)
		if err != nil {
			return errMsg{"load messages", err}
		}
		res := historyMsg{sessionID: id, msgs: msgs, older: next, prepend: older}
		if !older {
			res.perms, _ = c.Permissions(ctx, id)
			res.forms, _ = c.Forms(ctx, id)
			res.inbox, _ = c.Inbox(ctx, id)
		}
		return res
	}
}

func (a *App) maybeLoadOlder() tea.Cmd {
	if a.tr.AtTop() && a.sessionID != "" {
		return a.loadHistory(a.sessionID, true)
	}
	return nil
}

// handleResult applies async results.
func (a *App) handleResult(msg tea.Msg) tea.Cmd {
	switch m := msg.(type) {
	case nil:
		return nil
	case errMsg:
		if api.IsTag(m.err, "SessionBusyError") {
			return a.showToast("warning", "", "The session is busy; try again when it finishes", 4*time.Second)
		}
		return a.showToast("error", m.op+" failed", m.err.Error(), 6*time.Second)
	case toastMsg:
		return a.showToast(m.variant, m.title, m.text, m.d)
	case bootMsg:
		resync := m.cont == "\x00resync"
		for id, d := range a.store.sessions {
			_, run := m.active[id]
			d.running = run
		}
		for id := range m.active {
			a.store.session(id).running = true
		}
		if resync {
			a.dirty = true
			return a.tick()
		}
		if m.dir != "" {
			a.cwd = m.dir
			a.client.Directory = m.dir
			a.ropts.cwd = m.dir
		}
		cmds := []tea.Cmd{a.loadCatalogs(), a.tick(), a.listSessions()}
		target := a.opt.SessionID
		if target == "" {
			target = m.cont
		}
		if target != "" {
			cmds = append(cmds, a.openSession(target, false))
		}
		return tea.Batch(cmds...)
	case catalogMsg:
		s := a.store
		if !m.core {
			s.commands, s.skills, s.references, s.mcp, s.vcs, s.features = m.commands, m.skills, m.references, m.mcp, m.vcs, m.features
			a.dirty = true
			return nil
		}
		s.agents, s.models, s.providers, s.config = m.agents, m.models, m.providers, m.config
		s.gen++
		a.resolveAgent()
		a.resolveModel()
		a.applyVariantTheme()
		a.dirty = true
		if p := a.opt.Prompt; p != "" {
			a.opt.Prompt = ""
			return a.submit(p)
		}
	case sessionMsg:
		d := a.store.session(m.info.ID)
		d.info = m.info
		d.known = true
		if m.info.ID == a.sessionID {
			if !a.modelSet {
				a.resolveAgent()
				a.resolveModel()
			}
		}
	case historyMsg:
		d := a.store.session(m.sessionID)
		if m.preview {
			if !d.loaded {
				d.setHistory(m.msgs, m.older)
				d.loaded = false // a full load still happens when the session is opened
			}
			return nil
		}
		if m.prepend {
			before := len(a.tr.lines)
			d.prependHistory(m.msgs, m.older)
			// Keep the view anchored on what the user was reading.
			a.rebuild()
			a.tr.offset += len(a.tr.lines) - before
			a.tr.pos += float64(len(a.tr.lines) - before)
		} else {
			d.setHistory(m.msgs, m.older)
			d.perms = m.perms
			d.forms = m.forms
			for _, it := range m.inbox {
				if it.Type != "user" && it.Type != "synthetic" {
					continue
				}
				if _, ok := d.index[it.ID]; ok {
					continue
				}
				pm := &api.Message{ID: it.ID, Type: it.Type, Text: it.Payload.Text, Pending: true}
				pm.Time.Created = it.Time.Created
				d.upsert(pm)
			}
			cmds := []tea.Cmd{a.loadChildren(d)}
			if a.yolo && len(d.perms) > 0 {
				cmds = append(cmds, a.autoApprove())
			}
			a.dirty = true
			return tea.Batch(cmds...)
		}
		a.dirty = true
	case messageMsg:
		d := a.store.session(m.sessionID)
		d.upsert(m.msg)
		a.dirty = true
	case diffMsg:
		a.store.session(m.sessionID).diff = m.files
	case forkedMsg:
		return tea.Batch(a.openSession(m.s.ID, false), a.showToast("success", "", "Forked into a new session", 2*time.Second))
	case sentMsg:
		if m.err != nil {
			return a.showToast("error", "Send failed", m.err.Error(), 6*time.Second)
		}
	case sessionsMsg:
		a.sessions = m.list
		if sd, ok := a.dialog.(*sessionDialog); ok {
			sd.setSessions(a, m.list)
		}
	case editorMsg:
		if m.err != nil {
			return a.showToast("error", "Editor", m.err.Error(), 4*time.Second)
		}
		a.prompt.SetValue(strings.TrimRight(m.text, "\n"))
	case filesMsg:
		if a.comp != nil {
			a.comp.setFiles(a, m)
		}
	case rpcViewMsg:
		return a.showRPCView(m)
	case daemonMsg:
		return a.handleDaemon(m)
	}
	return nil
}

// --- model and agent selection (tui/src/context/local.tsx) ---

func (a *App) resolveAgent() {
	if _, ok := a.store.Agent(a.agent); ok && a.agent != "" {
		return
	}
	if d, ok := a.store.Get(a.sessionID); ok && d.info.Agent != "" {
		if ag, ok := a.store.Agent(d.info.Agent); ok && ag.Primary() {
			a.agent = ag.ID
			return
		}
	}
	for i := len(a.store.config) - 1; i >= 0; i-- {
		if id := a.store.config[i].Info.DefaultAgent; id != "" {
			if ag, ok := a.store.Agent(id); ok && ag.Primary() {
				a.agent = ag.ID
				return
			}
		}
	}
	if list := a.store.PrimaryAgents(); len(list) > 0 {
		a.agent = list[0].ID
	}
}

func (a *App) validModel(ref api.ModelRef) bool {
	_, ok := a.store.Model(ref)
	return ok && !ref.Empty()
}

func (a *App) resolveModel() {
	pick := func(ref api.ModelRef) bool {
		if !a.validModel(ref) {
			return false
		}
		variant := ref.Variant
		if variant == "" || variant == "default" {
			variant = a.mprefs.variantFor(ref)
		}
		mm, _ := a.store.Model(ref)
		if !mm.HasVariant(variant) {
			variant = ""
		}
		a.model = api.ModelRef{ID: ref.ID, ProviderID: ref.ProviderID, Variant: variant}
		return true
	}
	if a.modelSet && pick(a.model) {
		return
	}
	if d, ok := a.store.Get(a.sessionID); ok && d.info.Model != nil && (d.info.Agent == "" || d.info.Agent == a.agent) {
		if pick(*d.info.Model) {
			return
		}
	}
	if ag, ok := a.store.Agent(a.agent); ok && ag.Model != nil && pick(*ag.Model) {
		return
	}
	for i := len(a.store.config) - 1; i >= 0; i-- {
		if ref, ok := parseConfigModel(a.store.config[i].Info.Model); ok && pick(ref) {
			return
		}
	}
	for _, r := range a.mprefs.Recent {
		if pick(api.ModelRef{ID: r.ModelID, ProviderID: r.ProviderID}) {
			return
		}
	}
	for _, m := range a.store.models {
		if m.Enabled && pick(m.Ref()) {
			return
		}
	}
	if len(a.store.models) > 0 {
		pick(a.store.models[0].Ref())
	}
}

func parseConfigModel(raw json.RawMessage) (api.ModelRef, bool) {
	if len(raw) == 0 {
		return api.ModelRef{}, false
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		i := strings.IndexByte(s, '/')
		if i <= 0 {
			return api.ModelRef{}, false
		}
		return api.ModelRef{ProviderID: s[:i], ID: s[i+1:]}, true
	}
	var o struct {
		ProviderID string `json:"providerID"`
		Model      string `json:"model"`
		Variant    string `json:"variant"`
	}
	if json.Unmarshal(raw, &o) == nil && o.ProviderID != "" {
		return api.ModelRef{ProviderID: o.ProviderID, ID: o.Model, Variant: o.Variant}, true
	}
	return api.ModelRef{}, false
}

// setModel switches the model for the next prompt and remembers it.
func (a *App) setModel(ref api.ModelRef) tea.Cmd {
	if ref.Variant == "" {
		ref.Variant = a.mprefs.variantFor(ref)
	}
	a.model = ref
	a.modelSet = true
	a.mprefs.touch(ref)
	a.mprefs.save()
	a.applyVariantTheme()
	name := ref.ID
	if mm, ok := a.store.Model(ref); ok {
		name = mm.Name
	}
	return a.showToast("info", "", "Model: "+name, 2*time.Second)
}

func (a *App) cycleVariant() tea.Cmd {
	mm, ok := a.store.Model(a.model)
	if !ok || len(mm.Variants) == 0 {
		return a.showToast("info", "", "This model has no effort levels", 2*time.Second)
	}
	var ids []string
	for _, v := range mm.Variants {
		if v.ID != "default" {
			ids = append(ids, v.ID)
		}
	}
	next := ""
	if a.model.Variant == "" {
		next = ids[0]
	} else {
		for i, id := range ids {
			if id == a.model.Variant && i+1 < len(ids) {
				next = ids[i+1]
			}
		}
	}
	return a.setVariant(next)
}

func (a *App) setVariant(v string) tea.Cmd {
	a.model.Variant = v
	a.mprefs.setVariant(a.model, v)
	a.mprefs.save()
	a.applyVariantTheme()
	label := v
	if v == "" {
		label = "default"
	}
	if v == "infinicode" {
		label = "InfiniCode · strongest effort"
	}
	return a.showToast("info", "", "Effort: "+label, 1500*time.Millisecond)
}

func (a *App) cycleAgent(dir int) tea.Cmd {
	list := a.store.PrimaryAgents()
	if len(list) == 0 {
		return nil
	}
	i := 0
	for j, ag := range list {
		if ag.ID == a.agent {
			i = j
		}
	}
	ag := list[(i+dir+len(list))%len(list)]
	a.agent = ag.ID
	if !a.modelSet && ag.Model != nil && a.validModel(*ag.Model) {
		a.model = *ag.Model
	}
	return nil
}

// --- sessions ---

func (a *App) openSession(id string, keepTrail bool) tea.Cmd {
	if !keepTrail {
		a.trail = nil
	}
	a.sessionID = id
	a.tr = NewTranscript()
	a.comp = nil
	a.modelSet = false
	a.agent = ""
	d := a.store.session(id)
	a.resolveAgent()
	a.resolveModel()
	a.dirty = true
	cmds := []tea.Cmd{a.fetchSession(id), a.loadHistory(id, false), a.sendEnvironment(id), a.fetchDiff(id)}
	if d.info.Time.Idle > 0 {
		idle := d.info.Time.Idle
		cmds = append(cmds, func() tea.Msg {
			_ = a.client.View(a.bg(), id, idle)
			return nil
		})
	}
	return tea.Batch(cmds...)
}

func (a *App) newSession() tea.Cmd {
	a.sessionID = ""
	a.trail = nil
	a.tr = NewTranscript()
	a.prompt.Reset()
	a.comp = nil
	a.modelSet = false
	a.agent = ""
	a.resolveAgent()
	a.resolveModel()
	a.started = time.Now()
	a.dirty = true
	return a.tick()
}

func (a *App) enterChild(id string) tea.Cmd {
	if a.sessionID != "" {
		a.trail = append(a.trail, a.sessionID)
	}
	return a.openSession(id, true)
}

func (a *App) leaveChild() tea.Cmd {
	if len(a.trail) == 0 {
		return nil
	}
	prev := a.trail[len(a.trail)-1]
	a.trail = a.trail[:len(a.trail)-1]
	return a.openSession(prev, true)
}

// openLatestChild opens the newest subagent session of this view.
func (a *App) openLatestChild() tea.Cmd {
	d, ok := a.store.Get(a.sessionID)
	if !ok {
		return nil
	}
	for i := len(d.msgs) - 1; i >= 0; i-- {
		m := d.msgs[i]
		for j := len(m.Content) - 1; j >= 0; j-- {
			b := m.Content[j]
			if (b.Name == "subagent" || b.Name == "task") && b.State != nil {
				if id := str(parseObj(b.State.Metadata), "sessionID"); id != "" {
					return a.enterChild(id)
				}
			}
		}
	}
	return a.showToast("info", "", "No subagents in this session", 2*time.Second)
}

func envVars() map[string]string {
	vars := map[string]string{}
	for _, kv := range os.Environ() {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || k == "OPENCODE_PASSWORD" || k == "OPENCODE_SERVER_PASSWORD" || strings.HasPrefix(k, "INFINITUI_SERVER") {
			continue
		}
		vars[k] = v
	}
	return vars
}

func (a *App) sendEnvironment(id string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 10*time.Second)
		defer cancel()
		_ = a.client.Environment(ctx, id, envVars())
		return nil
	}
}

// withSession runs fn against the current session, creating it first when this is a new chat.
func (a *App) withSession(fn func(ctx context.Context, sid string) error) tea.Cmd {
	sid := a.sessionID
	create := sid == ""
	if create {
		sid = a.opt.NewID
		a.opt.NewID = ""
		if sid == "" {
			sid = api.NewSessionID()
		}
		a.sessionID = sid
		d := a.store.session(sid)
		d.loaded = true
		d.info.Agent = a.agent
		a.tr = NewTranscript()
	}
	agent, model := a.agent, a.model
	d := a.store.session(sid)
	revert := d.info.Revert != nil
	sessAgent := d.info.Agent
	c := a.client
	return func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 60*time.Second)
		defer cancel()
		if create {
			if _, err := c.CreateSession(ctx, sid, agent, &model); err != nil {
				return errMsg{"create session", err}
			}
			_ = c.Environment(ctx, sid, envVars())
		} else if agent != "" && agent != sessAgent {
			if err := c.SetAgent(ctx, sid, agent); err != nil {
				return errMsg{"switch agent", err}
			}
		}
		if revert {
			_ = c.RevertCommit(ctx, sid)
		}
		if !model.Empty() {
			if err := c.SetModel(ctx, sid, model); err != nil {
				return errMsg{"switch model", err}
			}
		}
		return sentMsg{fn(ctx, sid)}
	}
}

// submit sends the composer contents.
func (a *App) submit(v string) tea.Cmd {
	text := strings.TrimSpace(v)
	if text == "" {
		return nil
	}
	a.comp = nil
	a.tr.Bottom()
	if strings.HasPrefix(text, "/") && !strings.HasPrefix(text, "//") {
		name, args, _ := strings.Cut(strings.TrimPrefix(text, "/"), " ")
		args = strings.TrimSpace(args)
		if cmd := findLocal(name); cmd != nil {
			a.prompt.Remember(text)
			a.prompt.Reset()
			return cmd.run(a, args)
		}
		if f := a.findFeature(name); f != nil {
			a.prompt.Remember(text)
			a.prompt.Reset()
			return a.runFeature(f.ID, "", args)
		}
		if a.hasServerCommand(name) {
			a.prompt.Remember(text)
			a.prompt.Reset()
			return a.withSession(func(ctx context.Context, sid string) error {
				return a.client.RunCommand(ctx, sid, name, args)
			})
		}
		return a.showToast("warning", "", "Unknown command /"+name+" · ctrl+p lists everything", 3*time.Second)
	}
	if strings.HasPrefix(text, "!") {
		cmd := strings.TrimSpace(strings.TrimPrefix(text, "!"))
		a.prompt.Remember(text)
		a.prompt.Reset()
		if cmd == "" {
			return nil
		}
		return a.withSession(func(ctx context.Context, sid string) error {
			return a.client.Shell(ctx, sid, cmd)
		})
	}
	text = a.prompt.Expand(text)
	body := a.prompt.Build(text)
	body.ID = api.NewMessageID()
	a.prompt.Remember(text)
	a.prompt.Reset()
	cmd := a.withSession(func(ctx context.Context, sid string) error {
		return a.client.Prompt(ctx, sid, body)
	})
	a.optimisticUser(body.ID, text)
	return cmd
}

// optimisticUser shows the prompt right away; inbox events confirm it under the same ID.
func (a *App) optimisticUser(id, text string) {
	d := a.store.session(a.sessionID)
	d.loaded = true
	m := &api.Message{ID: id, Type: "user", Text: text, Pending: true}
	m.Time.Created = time.Now().UnixMilli()
	d.upsert(m)
}

func (a *App) hasServerCommand(name string) bool {
	for _, c := range a.store.commands {
		if c.Name == name {
			return true
		}
	}
	return false
}

func (a *App) findFeature(slash string) *api.RPCFeature {
	for i, f := range a.store.features {
		if f.Slash == slash || f.ID == slash {
			return &a.store.features[i]
		}
	}
	return nil
}

// runNamedCommand handles tui.command.execute.
func (a *App) runNamedCommand(name string) tea.Cmd {
	switch name {
	case "session.list":
		return a.openSessions()
	case "session.new":
		return a.newSession()
	case "session.interrupt":
		return a.interrupt()
	case "session.background":
		return a.background()
	case "session.compact":
		return a.compact()
	case "session.page.up", "session.half.page.up":
		a.tr.Scroll(-a.tr.height / 2)
	case "session.page.down", "session.half.page.down":
		a.tr.Scroll(a.tr.height / 2)
	case "session.line.up":
		a.tr.Scroll(-1)
	case "session.line.down":
		a.tr.Scroll(1)
	case "session.first":
		a.tr.Top()
	case "session.last":
		a.tr.Bottom()
	case "prompt.clear":
		a.prompt.Reset()
	case "prompt.submit":
		return a.submit(a.prompt.Value())
	case "agent.cycle":
		return a.cycleAgent(1)
	}
	return nil
}

func (a *App) interrupt() tea.Cmd {
	sid := a.sessionID
	if sid == "" {
		return nil
	}
	return tea.Batch(a.showToast("warning", "", "Interrupting…", 1500*time.Millisecond), func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 10*time.Second)
		defer cancel()
		if err := a.client.Interrupt(ctx, sid); err != nil {
			return errMsg{"interrupt", err}
		}
		return nil
	})
}

func (a *App) background() tea.Cmd {
	sid := a.sessionID
	return func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 10*time.Second)
		defer cancel()
		if err := a.client.Background(ctx, sid); err != nil {
			return errMsg{"background", err}
		}
		return toastMsg{"info", "", "Moved the running tool to the background", 2 * time.Second}
	}
}

func (a *App) compact() tea.Cmd {
	if a.sessionID == "" {
		return a.showToast("info", "", "Nothing to compact yet", 2*time.Second)
	}
	return a.withSession(func(ctx context.Context, sid string) error {
		return a.client.Compact(ctx, sid)
	})
}

// undo reverts the last user message and puts its text back in the composer.
func (a *App) undo() tea.Cmd {
	d, ok := a.store.Get(a.sessionID)
	if !ok {
		return nil
	}
	var target *api.Message
	for i := len(d.msgs) - 1; i >= 0; i-- {
		m := d.msgs[i]
		if d.info.Revert != nil && m.ID >= d.info.Revert.MessageID {
			continue
		}
		if m.Type == "user" {
			target = m
			break
		}
	}
	if target == nil {
		return a.showToast("info", "", "Nothing to undo", 2*time.Second)
	}
	return a.revertTo(target)
}

func (a *App) revertTo(target *api.Message) tea.Cmd {
	sid := a.sessionID
	pending := target.Pending
	a.prompt.SetValue(goalText(target.Text))
	running := a.running()
	return func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 60*time.Second)
		defer cancel()
		if pending {
			if err := a.client.CancelInbox(ctx, sid, target.ID); err != nil {
				return errMsg{"undo", err}
			}
			return nil
		}
		if running {
			_ = a.client.Interrupt(ctx, sid)
			_ = a.client.Wait(ctx, sid)
		}
		if err := a.client.RevertStage(ctx, sid, target.ID); err != nil {
			return errMsg{"undo", err}
		}
		return toastMsg{"info", "", "Undone · files restored · /redo brings it back", 3 * time.Second}
	}
}

func (a *App) redo() tea.Cmd {
	sid := a.sessionID
	d, ok := a.store.Get(sid)
	if !ok || d.info.Revert == nil {
		return a.showToast("info", "", "Nothing to redo", 2*time.Second)
	}
	a.prompt.Reset()
	return func() tea.Msg {
		if err := a.client.RevertClear(a.bg(), sid); err != nil {
			return errMsg{"redo", err}
		}
		return toastMsg{"info", "", "Restored", 2 * time.Second}
	}
}

func (a *App) forkAt(messageID string) tea.Cmd {
	sid := a.sessionID
	return func() tea.Msg {
		s, err := a.client.Fork(a.bg(), sid, messageID)
		if err != nil {
			return errMsg{"fork", err}
		}
		return forkedMsg{s}
	}
}

type forkedMsg struct{ s api.Session }

// lastAssistantText collects the final answer of the latest turn.
func (a *App) lastAssistantText() string {
	d, ok := a.store.Get(a.sessionID)
	if !ok {
		return ""
	}
	var parts []string
	for i := len(d.msgs) - 1; i >= 0; i-- {
		m := d.msgs[i]
		if m.Type == "user" && !m.Pending {
			break
		}
		if m.Type != "assistant" {
			continue
		}
		var texts []string
		for _, b := range m.Content {
			if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
				texts = append(texts, strings.TrimSpace(b.Text))
			}
		}
		if len(texts) > 0 {
			parts = append([]string{strings.Join(texts, "\n\n")}, parts...)
			break
		}
	}
	return strings.Join(parts, "\n\n")
}

func (a *App) copyLast() tea.Cmd {
	text := a.lastAssistantText()
	if text == "" {
		return a.showToast("info", "", "No response to copy yet", 2*time.Second)
	}
	return tea.Batch(tea.SetClipboard(text), copyNative(text), a.showToast("success", "", "Copied the last response", 2*time.Second))
}

// copyNative also tries the system clipboard tools, for terminals without OSC 52.
func copyNative(text string) tea.Cmd {
	return func() tea.Msg {
		for _, c := range [][]string{{"wl-copy"}, {"xclip", "-selection", "clipboard"}, {"xsel", "-ib"}, {"pbcopy"}} {
			if _, err := exec.LookPath(c[0]); err != nil {
				continue
			}
			cmd := exec.Command(c[0], c[1:]...)
			cmd.Stdin = strings.NewReader(text)
			if cmd.Run() == nil {
				return nil
			}
		}
		return nil
	}
}

// openEditor edits the prompt in $VISUAL/$EDITOR.
func (a *App) openEditor() tea.Cmd {
	editor := os.Getenv("VISUAL")
	if editor == "" {
		editor = os.Getenv("EDITOR")
	}
	if editor == "" {
		editor = "vi"
	}
	f, err := os.CreateTemp("", "infinitui-*.md")
	if err != nil {
		return a.showToast("error", "Editor", err.Error(), 3*time.Second)
	}
	_, _ = f.WriteString(a.prompt.Value())
	_ = f.Close()
	parts := strings.Fields(editor)
	cmd := exec.Command(parts[0], append(parts[1:], f.Name())...)
	return tea.ExecProcess(cmd, func(err error) tea.Msg {
		defer os.Remove(f.Name())
		b, rerr := os.ReadFile(f.Name())
		if err == nil {
			err = rerr
		}
		return editorMsg{string(b), err}
	})
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

// exportTranscript writes the session as Markdown into the project directory.
func (a *App) exportTranscript() tea.Cmd {
	sid := a.sessionID
	if sid == "" {
		return a.showToast("info", "", "Nothing to export yet", 2*time.Second)
	}
	dir := a.cwd
	return func() tea.Msg {
		info, msgs, err := a.client.Export(a.bg(), sid)
		if err != nil {
			return errMsg{"export", err}
		}
		var b strings.Builder
		fmt.Fprintf(&b, "# %s\n\n", info.DisplayTitle())
		for _, m := range msgs {
			switch m.Type {
			case "user":
				fmt.Fprintf(&b, "## User\n\n%s\n\n", m.Text)
			case "assistant":
				for _, bl := range m.Content {
					switch bl.Type {
					case "text":
						if t := strings.TrimSpace(bl.Text); t != "" {
							fmt.Fprintf(&b, "%s\n\n", t)
						}
					case "tool":
						in := ""
						if bl.State != nil {
							in = string(bl.State.Input)
						}
						fmt.Fprintf(&b, "**Tool `%s`** `%s`\n\n", bl.Name, truncate(in, 200))
					}
				}
			}
		}
		slug := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(info.DisplayTitle()), "-"), "-")
		if slug == "" {
			slug = "session"
		}
		path := filepath.Join(dir, "session-"+slug+".md")
		if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
			return errMsg{"export", err}
		}
		return toastMsg{"success", "Exported", tildify(path), 4 * time.Second}
	}
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// safeGate matches safe-guard's always-ask permission prompts, which YOLO keeps in front of the user.
var safeGate = regexp.MustCompile(`^Always confirmed by InfiniteOC safety: |^.+ is a protected path \(InfiniteOC safety settings\)\. Confirm to edit it\.$`)

func (a *App) autoApprove() tea.Cmd {
	root := a.treeRoot()
	var cmds []tea.Cmd
	for id, d := range a.store.sessions {
		if !a.store.InTree(root, id) && id != a.sessionID {
			continue
		}
		for _, p := range d.perms {
			if safeGate.MatchString(p.Message) {
				continue
			}
			p := p
			cmds = append(cmds, func() tea.Msg {
				_ = a.client.ReplyPermission(a.bg(), p.SessionID, p.ID, "once", "")
				return nil
			})
		}
	}
	return tea.Batch(cmds...)
}

// sortSessions orders by last update.
func sortSessions(list []api.Session) {
	sort.SliceStable(list, func(i, j int) bool { return list[i].Time.Updated > list[j].Time.Updated })
}

// loadChildren fetches the transcripts of subagent sessions referenced by d, so their blocks show progress.
func (a *App) loadChildren(d *sessionData) tea.Cmd {
	var cmds []tea.Cmd
	for _, m := range d.msgs {
		for _, b := range m.Content {
			if (b.Name != "subagent" && b.Name != "task") || b.State == nil {
				continue
			}
			id := str(parseObj(b.State.Metadata), "sessionID")
			if id == "" {
				continue
			}
			if cd, ok := a.store.Get(id); ok && (cd.loaded || len(cd.msgs) > 0) {
				continue
			}
			a.store.session(id).loaded = true // claim it so we fetch once
			cmds = append(cmds, a.loadHistory(id, false), a.fetchSession(id))
		}
	}
	return tea.Batch(cmds...)
}
