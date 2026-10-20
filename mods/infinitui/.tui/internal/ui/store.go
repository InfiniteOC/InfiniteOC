package ui

import (
	"encoding/json"
	"sort"
	"strings"

	"infiniteoc/infinitui/internal/api"
)

// sessionData is everything known about one session.
type sessionData struct {
	info     api.Session
	known    bool // info fetched
	msgs     []*api.Message
	index    map[string]*api.Message
	loaded   bool   // transcript fetched
	older    string // cursor for older history; "" when complete
	running  bool
	started  int64 // ms, when the current execution began
	version  int   // bumps on every transcript change
	diff     []api.FileDiff
	perms    []api.PermissionRequest
	forms    []api.Form
	versions map[string]int // per-message render versions
}

// Store is the client-side mirror of the server. It is only touched from Update.
type Store struct {
	sessions map[string]*sessionData

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
	// global (MCP elicitation) forms
	globalForms []api.Form
	// gen bumps when catalogs change (names in cached rows)
	gen int
}

// NewStore returns an empty store.
func NewStore() *Store { return &Store{sessions: map[string]*sessionData{}} }

func (s *Store) session(id string) *sessionData {
	d, ok := s.sessions[id]
	if !ok {
		d = &sessionData{index: map[string]*api.Message{}, versions: map[string]int{}}
		d.info.ID = id
		s.sessions[id] = d
	}
	return d
}

// Get returns a session if it is known.
func (s *Store) Get(id string) (*sessionData, bool) {
	d, ok := s.sessions[id]
	return d, ok
}

func (d *sessionData) touch(id string) {
	d.version++
	d.versions[id]++
}

func (d *sessionData) msg(id string) *api.Message { return d.index[id] }

// upsert inserts m in ID order (IDs are ascending per session) or replaces the existing one.
func (d *sessionData) upsert(m *api.Message) {
	if old, ok := d.index[m.ID]; ok {
		*old = *m
		d.touch(m.ID)
		return
	}
	d.index[m.ID] = m
	i := sort.Search(len(d.msgs), func(i int) bool { return d.msgs[i].ID > m.ID })
	d.msgs = append(d.msgs, nil)
	copy(d.msgs[i+1:], d.msgs[i:])
	d.msgs[i] = m
	d.touch(m.ID)
}

// moveToEnd re-orders a delivered inbox row after everything already shown.
func (d *sessionData) moveToEnd(id string, created int64) {
	m, ok := d.index[id]
	if !ok {
		return
	}
	for i, x := range d.msgs {
		if x == m {
			d.msgs = append(d.msgs[:i], d.msgs[i+1:]...)
			break
		}
	}
	m.Pending = false
	if created > 0 {
		m.Time.Created = created
	}
	d.msgs = append(d.msgs, m)
	d.touch(id)
}

func (d *sessionData) remove(id string) {
	m, ok := d.index[id]
	if !ok {
		return
	}
	delete(d.index, id)
	for i, x := range d.msgs {
		if x == m {
			d.msgs = append(d.msgs[:i], d.msgs[i+1:]...)
			break
		}
	}
	d.version++
}

// setHistory replaces the transcript with a fetched page, keeping newer live rows.
func (d *sessionData) setHistory(msgs []*api.Message, older string) {
	pending := []*api.Message{}
	for _, m := range d.msgs {
		if m.Pending {
			pending = append(pending, m)
		}
	}
	d.msgs = nil
	d.index = map[string]*api.Message{}
	for _, m := range msgs {
		d.index[m.ID] = m
		d.msgs = append(d.msgs, m)
		d.versions[m.ID]++
	}
	for _, m := range pending {
		if _, ok := d.index[m.ID]; !ok {
			d.index[m.ID] = m
			d.msgs = append(d.msgs, m)
		}
	}
	d.loaded = true
	d.older = older
	d.version++
}

// prependHistory adds an older page.
func (d *sessionData) prependHistory(msgs []*api.Message, older string) {
	var add []*api.Message
	for _, m := range msgs {
		if _, ok := d.index[m.ID]; !ok {
			d.index[m.ID] = m
			add = append(add, m)
		}
	}
	d.msgs = append(add, d.msgs...)
	d.older = older
	d.version++
}

func (d *sessionData) lastAssistant(id string) *api.Message {
	if m := d.index[id]; m != nil {
		return m
	}
	return nil
}

func lastBlock(m *api.Message, typ string, open bool) *api.Block {
	for i := len(m.Content) - 1; i >= 0; i-- {
		b := m.Content[i]
		if b.Type != typ {
			continue
		}
		if open && b.Time.Completed != 0 {
			continue
		}
		return b
	}
	return nil
}

func toolBlock(m *api.Message, id string) *api.Block {
	for _, b := range m.Content {
		if b.Type == "tool" && b.ID == id {
			return b
		}
	}
	return nil
}

// evData is the union of fields carried by session events.
type evData struct {
	SessionID          string               `json:"sessionID"`
	AssistantMessageID string               `json:"assistantMessageID"`
	ID                 string               `json:"id"`
	Name               string               `json:"name"`
	Delta              string               `json:"delta"`
	Text               string               `json:"text"`
	Title              string               `json:"title"`
	Agent              string               `json:"agent"`
	Model              *api.ModelRef        `json:"model"`
	Started            int64                `json:"started"`
	Input              json.RawMessage      `json:"input"`
	Metadata           json.RawMessage      `json:"metadata"`
	Content            []api.ToolContent    `json:"content"`
	Error              *api.StructuredError `json:"error"`
	Finish             string               `json:"finish"`
	Cost               float64              `json:"cost"`
	Tokens             *api.TokenUsage      `json:"tokens"`
	InboxID            string               `json:"inboxID"`
	Item               *struct {
		Type     string `json:"type"`
		Delivery string `json:"delivery"`
		Payload  struct {
			Text        string `json:"text"`
			Description string `json:"description"`
		} `json:"payload"`
	} `json:"item"`
	Reason      string      `json:"reason"`
	InputID     string      `json:"inputID"`
	To          string      `json:"to"`
	Revert      *api.Revert `json:"revert"`
	Description string      `json:"description"`
	RequestID   string      `json:"requestID"`
	Form        *api.Form   `json:"form"`
	Attempt     int         `json:"attempt"`
	At          int64       `json:"at"`
	Shell       *shellInfo  `json:"shell"`
	Output      *struct {
		Output    string `json:"output"`
		Truncated bool   `json:"truncated"`
	} `json:"output"`
	Previous json.RawMessage `json:"previous"`
	Branch   *string         `json:"branch"`
	// toast
	Message  string `json:"message"`
	Variant  string `json:"variant"`
	Duration int    `json:"duration"`
	Command  string `json:"command"`
}

type shellInfo struct {
	ID      string `json:"id"`
	Command string `json:"command"`
	Status  string `json:"status"`
	Exit    *int   `json:"exit"`
}

// Effect tells the app what an event means beyond the store update.
type Effect struct {
	Kind      string // see effect* constants
	SessionID string
	Text      string
	Title     string
	Variant   string
	Duration  int
	Location  string
}

const (
	effNone          = ""
	effFetchSession  = "fetch-session"  // session info changed/unknown
	effFetchMessage  = "fetch-message"  // Text = message ID
	effRefetch       = "refetch"        // reload transcript
	effCatalog       = "catalog"        // Text = which catalog
	effToast         = "toast"          // server toast
	effSelect        = "select"         // tui.session.select
	effPromptAppend  = "prompt-append"  // tui.prompt.append
	effCommand       = "command"        // tui.command.execute
	effDone          = "done"           // execution finished (Text = outcome)
	effPermission    = "permission"     // permission asked
	effForm          = "form"           // form created
	effDeleted       = "deleted"        // session deleted
	effConnected     = "connected"      // stream (re)connected
	effDisconnected  = "disconnected"   // stream lost
	effStarted       = "started"        // execution started
	effToolCompleted = "tool-completed" // a tool finished (Text = tool name)
)

// Apply mirrors one event. It returns the side effects the app should run.
func (s *Store) Apply(ev api.Event) []Effect {
	var d evData
	if len(ev.Data) > 0 {
		_ = json.Unmarshal(ev.Data, &d)
	}
	loc := ""
	if ev.Location != nil {
		loc = ev.Location.Directory
	}
	t := ev.Type
	switch t {
	case api.EventConnected:
		return []Effect{{Kind: effConnected}}
	case api.EventDisconnected:
		return []Effect{{Kind: effDisconnected}}
	}

	if strings.HasPrefix(t, "tui.") {
		switch t {
		case "tui.toast.show":
			return []Effect{{Kind: effToast, Title: d.Title, Text: d.Message, Variant: d.Variant, Duration: d.Duration, Location: loc}}
		case "tui.session.select":
			return []Effect{{Kind: effSelect, SessionID: d.SessionID, Location: loc}}
		case "tui.prompt.append":
			return []Effect{{Kind: effPromptAppend, Text: d.Text, Location: loc}}
		case "tui.command.execute":
			return []Effect{{Kind: effCommand, Text: d.Command, Location: loc}}
		}
		return nil
	}

	switch t {
	case "provider.updated", "model.updated", "agent.updated", "command.updated", "skill.updated",
		"reference.updated", "config.updated", "integration.updated", "credential.switched", "credential.updated",
		"mcp.status.changed":
		return []Effect{{Kind: effCatalog, Text: t, Location: loc}}
	case "vcs.branch.updated":
		if d.Branch != nil {
			s.vcs.Branch.Current = *d.Branch
		}
		return nil
	case "form.created":
		if d.Form == nil {
			return nil
		}
		f := *d.Form
		if f.SessionID == "global" {
			f.Directory = loc
			s.globalForms = append(s.globalForms, f)
		} else {
			sd := s.session(f.SessionID)
			sd.forms = appendForm(sd.forms, f)
		}
		return []Effect{{Kind: effForm, SessionID: f.SessionID}}
	case "form.replied", "form.cancelled":
		id := d.ID
		s.globalForms = removeForm(s.globalForms, id)
		if sd, ok := s.sessions[d.SessionID]; ok {
			sd.forms = removeForm(sd.forms, id)
		}
		return nil
	case "permission.asked":
		var p api.PermissionRequest
		_ = json.Unmarshal(ev.Data, &p)
		sd := s.session(p.SessionID)
		for _, x := range sd.perms {
			if x.ID == p.ID {
				return nil
			}
		}
		sd.perms = append(sd.perms, p)
		return []Effect{{Kind: effPermission, SessionID: p.SessionID}}
	case "permission.replied":
		if sd, ok := s.sessions[d.SessionID]; ok {
			for i, x := range sd.perms {
				if x.ID == d.RequestID {
					sd.perms = append(sd.perms[:i], sd.perms[i+1:]...)
					break
				}
			}
		}
		return nil
	}

	if !strings.HasPrefix(t, "session.") || d.SessionID == "" {
		return nil
	}
	sd := s.session(d.SessionID)

	switch t {
	case "session.created", "session.viewed", "session.moved":
		return []Effect{{Kind: effFetchSession, SessionID: d.SessionID}}
	case "session.deleted":
		delete(s.sessions, d.SessionID)
		return []Effect{{Kind: effDeleted, SessionID: d.SessionID}}
	case "session.renamed":
		sd.info.Title = d.Title
		return nil
	case "session.agent.selected":
		sd.info.Agent = d.Agent
		return nil
	case "session.model.selected":
		sd.info.Model = d.Model
		return nil
	case "session.usage.updated":
		sd.info.Cost = d.Cost
		if d.Tokens != nil {
			sd.info.Tokens = *d.Tokens
		}
		return nil
	case "session.revert.staged":
		sd.info.Revert = d.Revert
		sd.version++
		return nil
	case "session.revert.cleared":
		sd.info.Revert = nil
		sd.version++
		return nil
	case "session.revert.committed":
		sd.info.Revert = nil
		for _, m := range append([]*api.Message{}, sd.msgs...) {
			if m.ID >= d.To {
				sd.remove(m.ID)
			}
		}
		return nil

	case "session.execution.started":
		sd.running = true
		sd.started = ev.Created
		sd.version++
		return []Effect{{Kind: effStarted, SessionID: d.SessionID}}
	case "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted":
		sd.running = false
		outcome := strings.TrimPrefix(t, "session.execution.")
		// Close anything still streaming so spinners stop.
		for _, m := range sd.msgs {
			if m.Type != "assistant" {
				continue
			}
			for _, b := range m.Content {
				if b.Type == "tool" && b.State != nil && (b.State.Status == "streaming" || b.State.Status == "running") {
					if outcome == "interrupted" {
						b.State.Status = "error"
						b.State.Error = &api.StructuredError{Message: "Interrupted"}
					}
					sd.touch(m.ID)
				}
			}
			if m.Time.Completed == 0 {
				m.Time.Completed = ev.Created
				sd.touch(m.ID)
			}
		}
		if d.Reason != "shutdown" {
			idle := &api.Message{ID: "msg_" + strings.TrimPrefix(ev.ID, "evt_"), Type: "idle", Outcome: outcome, Error: d.Error}
			idle.Time.Created = ev.Created
			sd.upsert(idle)
		}
		sd.info.Time.Idle = ev.Created
		text := outcome
		if d.Error != nil {
			text = outcome + ": " + d.Error.Message
		}
		return []Effect{{Kind: effDone, SessionID: d.SessionID, Text: text}, {Kind: effFetchSession, SessionID: d.SessionID}}

	case "session.inbox.enqueued":
		if d.Item == nil || (d.Item.Type != "user" && d.Item.Type != "synthetic") {
			return nil
		}
		m := &api.Message{ID: d.InboxID, Type: d.Item.Type, Text: d.Item.Payload.Text, Description: d.Item.Payload.Description, Pending: true}
		m.Time.Created = ev.Created
		if old := sd.index[d.InboxID]; old != nil {
			old.Text = m.Text
			old.Pending = true
			sd.touch(d.InboxID)
		} else {
			sd.upsert(m)
		}
		return nil
	case "session.inbox.delivered":
		sd.moveToEnd(d.InboxID, ev.Created)
		return nil
	case "session.inbox.cancelled":
		sd.remove(d.InboxID)
		return nil
	case "session.synthetic":
		m := &api.Message{ID: "msg_" + strings.TrimPrefix(ev.ID, "evt_"), Type: "synthetic", Text: d.Text, Description: d.Description}
		m.Time.Created = ev.Created
		sd.upsert(m)
		return nil
	case "session.instructions.updated":
		return nil

	case "session.step.started":
		m := sd.index[d.AssistantMessageID]
		if m == nil {
			m = &api.Message{ID: d.AssistantMessageID, Type: "assistant"}
			sd.upsert(m)
		}
		m.Agent = d.Agent
		m.Model = d.Model
		m.Content = nil
		m.Error = nil
		m.Time.Created = d.Started
		m.Time.Completed = 0
		sd.touch(m.ID)
		return nil
	}

	if d.AssistantMessageID != "" {
		m := sd.index[d.AssistantMessageID]
		if m == nil {
			// Joined mid-step: fetch the message, then live events continue it.
			return []Effect{{Kind: effFetchMessage, SessionID: d.SessionID, Text: d.AssistantMessageID}}
		}
		defer sd.touch(m.ID)
		switch t {
		case "session.step.streamed":
			m.Time.Streamed = ev.Created
		case "session.step.ended":
			m.Time.Completed = ev.Created
			m.Finish = d.Finish
			m.Cost = d.Cost
			m.Tokens = d.Tokens
		case "session.step.failed":
			m.Time.Completed = ev.Created
			m.Error = d.Error
			m.Finish = d.Finish
			if m.Finish == "" {
				m.Finish = "error"
			}
			if d.Tokens != nil {
				m.Tokens = d.Tokens
			}
		case "session.text.started":
			m.Content = append(m.Content, &api.Block{Type: "text"})
		case "session.text.delta":
			if b := lastBlock(m, "text", false); b != nil {
				b.Text += d.Delta
			} else {
				m.Content = append(m.Content, &api.Block{Type: "text", Text: d.Delta})
			}
		case "session.text.ended":
			if b := lastBlock(m, "text", false); b != nil {
				b.Text = d.Text
			}
		case "session.reasoning.started":
			b := &api.Block{Type: "reasoning"}
			b.Time.Created = ev.Created
			m.Content = append(m.Content, b)
		case "session.reasoning.delta":
			if b := lastBlock(m, "reasoning", true); b != nil {
				b.Text += d.Delta
			}
		case "session.reasoning.ended":
			if b := lastBlock(m, "reasoning", true); b != nil {
				b.Text = d.Text
				b.Time.Completed = ev.Created
			}
		case "session.tool.input.started":
			b := &api.Block{Type: "tool", ID: d.ID, Name: d.Name, State: &api.ToolState{Status: "streaming"}}
			b.Time.Created = ev.Created
			m.Content = append(m.Content, b)
		case "session.tool.input.delta":
			if b := toolBlock(m, d.ID); b != nil {
				b.PartialInput += d.Delta
			}
		case "session.tool.input.ended":
			if b := toolBlock(m, d.ID); b != nil {
				b.PartialInput = d.Text
			}
		case "session.tool.called":
			b := toolBlock(m, d.ID)
			if b == nil {
				b = &api.Block{Type: "tool", ID: d.ID, Name: d.Name}
				b.Time.Created = ev.Created
				m.Content = append(m.Content, b)
			}
			b.State = &api.ToolState{Status: "running", Input: d.Input, Metadata: json.RawMessage("{}")}
			b.Time.Ran = ev.Created
		case "session.tool.progress":
			if b := toolBlock(m, d.ID); b != nil && b.State != nil && b.State.Status == "running" {
				b.State.Metadata = d.Metadata
			}
		case "session.tool.success":
			if b := toolBlock(m, d.ID); b != nil {
				in := json.RawMessage(nil)
				if b.State != nil {
					in = b.State.Input
				}
				b.State = &api.ToolState{Status: "completed", Input: in, Content: d.Content, Metadata: d.Metadata}
				b.Time.Completed = ev.Created
				return []Effect{{Kind: effToolCompleted, SessionID: d.SessionID, Text: b.Name}}
			}
		case "session.tool.failed":
			if b := toolBlock(m, d.ID); b != nil {
				in := json.RawMessage("{}")
				if b.State != nil && b.State.Status != "streaming" {
					in = b.State.Input
				}
				b.State = &api.ToolState{Status: "error", Input: in, Error: d.Error, Content: d.Content, Metadata: d.Metadata}
				b.Time.Completed = ev.Created
			}
		case "session.retry.scheduled":
			m.Retry = &struct {
				Attempt int                  `json:"attempt"`
				At      int64                `json:"at"`
				Error   *api.StructuredError `json:"error,omitempty"`
			}{d.Attempt, d.At, d.Error}
		}
		return nil
	}

	switch t {
	case "session.shell.started":
		if d.Shell == nil {
			return nil
		}
		m := &api.Message{ID: "msg_" + strings.TrimPrefix(ev.ID, "evt_"), Type: "shell", ShellID: d.Shell.ID, Command: d.Shell.Command, Status: d.Shell.Status}
		m.Time.Created = ev.Created
		sd.upsert(m)
	case "session.shell.ended":
		if d.Shell == nil {
			return nil
		}
		for _, m := range sd.msgs {
			if m.Type == "shell" && m.ShellID == d.Shell.ID {
				m.Status = d.Shell.Status
				m.Exit = d.Shell.Exit
				if d.Output != nil {
					m.Output = &struct {
						Output    string `json:"output"`
						Truncated bool   `json:"truncated"`
					}{d.Output.Output, d.Output.Truncated}
				}
				m.Time.Completed = ev.Created
				sd.touch(m.ID)
			}
		}
	case "session.compaction.started":
		if d.InputID != "" {
			sd.remove(d.InputID)
		}
		id := d.InputID
		if id == "" {
			id = "msg_" + strings.TrimPrefix(ev.ID, "evt_")
		}
		m := &api.Message{ID: id, Type: "compaction", Status: "running", Reason: d.Reason}
		m.Time.Created = ev.Created
		sd.upsert(m)
	case "session.compaction.delta":
		for i := len(sd.msgs) - 1; i >= 0; i-- {
			if m := sd.msgs[i]; m.Type == "compaction" && m.Status == "running" {
				m.Summary += d.Text
				sd.touch(m.ID)
				break
			}
		}
	case "session.compaction.ended", "session.compaction.failed":
		for i := len(sd.msgs) - 1; i >= 0; i-- {
			if m := sd.msgs[i]; m.Type == "compaction" && m.Status == "running" {
				if t == "session.compaction.ended" {
					m.Status = "completed"
					m.Summary = d.Text
				} else {
					m.Status = "failed"
					m.Error = d.Error
				}
				sd.touch(m.ID)
				break
			}
		}
	}
	return nil
}

func appendForm(list []api.Form, f api.Form) []api.Form {
	for _, x := range list {
		if x.ID == f.ID {
			return list
		}
	}
	return append(list, f)
}

func removeForm(list []api.Form, id string) []api.Form {
	for i, x := range list {
		if x.ID == id {
			return append(list[:i], list[i+1:]...)
		}
	}
	return list
}

// Model finds a catalog model.
func (s *Store) Model(ref api.ModelRef) (api.Model, bool) {
	for _, m := range s.models {
		if m.ProviderID == ref.ProviderID && m.ID == ref.ID {
			return m, true
		}
	}
	return api.Model{}, false
}

// Agent finds an agent by ID.
func (s *Store) Agent(id string) (api.Agent, bool) {
	for _, a := range s.agents {
		if a.ID == id {
			return a, true
		}
	}
	return api.Agent{}, false
}

// PrimaryAgents lists agents that can drive a session.
func (s *Store) PrimaryAgents() []api.Agent {
	var out []api.Agent
	for _, a := range s.agents {
		if a.Primary() {
			out = append(out, a)
		}
	}
	return out
}

// ProviderName returns a display name.
func (s *Store) ProviderName(id string) string {
	for _, p := range s.providers {
		if p.ID == id && p.Name != "" {
			return p.Name
		}
	}
	return id
}

// Root returns the top ancestor of a session among known sessions.
func (s *Store) Root(id string) string {
	seen := map[string]bool{}
	for {
		d, ok := s.sessions[id]
		if !ok || d.info.ParentID == "" || seen[id] {
			return id
		}
		seen[id] = true
		id = d.info.ParentID
	}
}

// InTree reports whether id is root or a descendant of it.
func (s *Store) InTree(root, id string) bool {
	return s.Root(id) == root || id == root
}

// ContextUsage returns used tokens and the window for a session's latest completed step.
func (s *Store) ContextUsage(id string) (used, limit float64) {
	d, ok := s.sessions[id]
	if !ok {
		return 0, 0
	}
	for i := len(d.msgs) - 1; i >= 0; i-- {
		m := d.msgs[i]
		if m.Type == "compaction" && m.Status == "completed" {
			break
		}
		if m.Type == "assistant" && m.Tokens != nil && m.Model != nil {
			used = m.Tokens.Total()
			if mm, ok := s.Model(*m.Model); ok {
				limit = mm.Limit.Context
			}
			return used, limit
		}
	}
	return 0, 0
}
