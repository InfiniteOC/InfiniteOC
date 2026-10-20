// Package api is a client for the OpenCode v2 HTTP API (packages/protocol, packages/client in upstream).
// Wire shapes follow packages/client/src/promise/generated/types.ts of OpenCode v2.0.32.
package api

import (
	"encoding/json"
	"strings"
)

// Location scopes catalog requests to a directory.
type Location struct {
	Directory string `json:"directory"`
}

// ModelRef names a model; the field is `id`, not `modelID`.
type ModelRef struct {
	ID         string `json:"id"`
	ProviderID string `json:"providerID"`
	Variant    string `json:"variant,omitempty"`
}

// Key is "provider/model".
func (m ModelRef) Key() string { return m.ProviderID + "/" + m.ID }

// Empty reports whether no model is set.
func (m ModelRef) Empty() bool { return m.ID == "" || m.ProviderID == "" }

// TokenUsage counts tokens for a step or a session.
type TokenUsage struct {
	Input     float64 `json:"input"`
	Output    float64 `json:"output"`
	Reasoning float64 `json:"reasoning"`
	Cache     struct {
		Read  float64 `json:"read"`
		Write float64 `json:"write"`
	} `json:"cache"`
}

// Total is everything that occupied the context window.
func (t TokenUsage) Total() float64 {
	return t.Input + t.Output + t.Reasoning + t.Cache.Read + t.Cache.Write
}

// FileDiff is one changed file.
type FileDiff struct {
	File      string `json:"file"`
	Patch     string `json:"patch"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Status    string `json:"status"`
}

// Revert is a staged undo.
type Revert struct {
	MessageID string     `json:"messageID"`
	PartID    string     `json:"partID,omitempty"`
	Snapshot  string     `json:"snapshot,omitempty"`
	Files     []FileDiff `json:"files,omitempty"`
}

// Session is SessionInfo.
type Session struct {
	ID        string          `json:"id"`
	ParentID  string          `json:"parentID,omitempty"`
	ProjectID string          `json:"projectID"`
	Agent     string          `json:"agent,omitempty"`
	Model     *ModelRef       `json:"model,omitempty"`
	Cost      float64         `json:"cost"`
	Tokens    TokenUsage      `json:"tokens"`
	Outcome   string          `json:"outcome,omitempty"`
	Title     string          `json:"title,omitempty"`
	Subpath   string          `json:"subpath,omitempty"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	Revert    *Revert         `json:"revert,omitempty"`
	Location  Location        `json:"location"`
	Time      struct {
		Created  int64 `json:"created"`
		Updated  int64 `json:"updated"`
		Idle     int64 `json:"idle,omitempty"`
		Viewed   int64 `json:"viewed,omitempty"`
		Archived int64 `json:"archived,omitempty"`
	} `json:"time"`
}

// DisplayTitle mirrors util/src/session-title-fallback.ts.
func (s Session) DisplayTitle() string {
	t := strings.TrimSpace(s.Title)
	if t == "" || strings.HasPrefix(t, "New session - ") {
		if s.ParentID != "" {
			return "Child session"
		}
		return "New session"
	}
	if strings.HasPrefix(t, "Child session - ") {
		return "Child session"
	}
	return t
}

// StructuredError is the error shape on steps, tools and executions.
type StructuredError struct {
	Type     string `json:"type"`
	Message  string `json:"message"`
	Status   int    `json:"status,omitempty"`
	Response *struct {
		Body string `json:"body"`
	} `json:"response,omitempty"`
}

// ToolContent is one block of a tool result.
type ToolContent struct {
	Type string `json:"type"` // text | file
	Text string `json:"text,omitempty"`
	URI  string `json:"uri,omitempty"`
	Mime string `json:"mime,omitempty"`
	Name string `json:"name,omitempty"`
}

// ToolState is the union streaming | running | completed | error.
type ToolState struct {
	Status   string           `json:"status"`
	Input    json.RawMessage  `json:"input,omitempty"` // string while streaming, object afterwards
	Metadata json.RawMessage  `json:"metadata,omitempty"`
	Content  []ToolContent    `json:"content,omitempty"`
	Error    *StructuredError `json:"error,omitempty"`
}

// Block is one entry of an assistant message's content: text, reasoning or tool.
type Block struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`

	// tool
	ID       string     `json:"id,omitempty"`
	Name     string     `json:"name,omitempty"`
	Executed *bool      `json:"executed,omitempty"`
	State    *ToolState `json:"state,omitempty"`

	Time struct {
		Created   int64 `json:"created,omitempty"`
		Ran       int64 `json:"ran,omitempty"`
		Completed int64 `json:"completed,omitempty"`
	} `json:"time"`

	// streaming partial JSON for tool input, kept client-side
	PartialInput string `json:"-"`
}

// Attachment is a file on a user message.
type Attachment struct {
	Mime    string `json:"mime,omitempty"`
	Name    string `json:"name,omitempty"`
	URI     string `json:"uri,omitempty"`
	Mention *struct {
		Start int    `json:"start"`
		End   int    `json:"end"`
		Text  string `json:"text"`
	} `json:"mention,omitempty"`
	Source *struct {
		Type string `json:"type"`
		URI  string `json:"uri,omitempty"`
	} `json:"source,omitempty"`
}

// Message is the SessionMessageInfo union, flattened. Type decides which fields are meaningful.
type Message struct {
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	Metadata json.RawMessage `json:"metadata,omitempty"`
	Time     struct {
		Created   int64 `json:"created"`
		Streamed  int64 `json:"streamed,omitempty"`
		Completed int64 `json:"completed,omitempty"`
	} `json:"time"`

	// user, synthetic, system, skill
	Text        string       `json:"text,omitempty"`
	Description string       `json:"description,omitempty"`
	Files       []Attachment `json:"files,omitempty"`
	Agents      []struct {
		Name string `json:"name"`
	} `json:"agents,omitempty"`

	// assistant
	Agent   string           `json:"agent,omitempty"`
	Model   *ModelRef        `json:"model,omitempty"`
	Content []*Block         `json:"content,omitempty"`
	Finish  string           `json:"finish,omitempty"`
	Cost    float64          `json:"cost,omitempty"`
	Tokens  *TokenUsage      `json:"tokens,omitempty"`
	Error   *StructuredError `json:"error,omitempty"`
	Retry   *struct {
		Attempt int              `json:"attempt"`
		At      int64            `json:"at"`
		Error   *StructuredError `json:"error,omitempty"`
	} `json:"retry,omitempty"`

	// skill
	Skill string `json:"skill,omitempty"`
	Name  string `json:"name,omitempty"`

	// shell
	ShellID string `json:"shellID,omitempty"`
	Command string `json:"command,omitempty"`
	Status  string `json:"status,omitempty"` // shell: running|exited|timeout|killed; compaction: running|completed|failed
	Exit    *int   `json:"exit,omitempty"`
	Output  *struct {
		Output    string `json:"output"`
		Truncated bool   `json:"truncated"`
	} `json:"output,omitempty"`

	// agent-switched / model-switched (previous is a string or a ModelRef)
	Previous json.RawMessage `json:"previous,omitempty"`

	// location-switched
	Location *Location `json:"location,omitempty"`

	// compaction
	Reason  string `json:"reason,omitempty"`
	Summary string `json:"summary,omitempty"`

	// idle
	Outcome string `json:"outcome,omitempty"`

	// client-side: still waiting in the inbox (queued prompt)
	Pending bool `json:"-"`
}

// Agent is AgentInfo.
type Agent struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Model       *ModelRef `json:"model,omitempty"`
	Description string    `json:"description,omitempty"`
	Mode        string    `json:"mode"` // subagent | primary | all
	Hidden      bool      `json:"hidden"`
	Color       string    `json:"color,omitempty"`
}

// Primary reports whether the agent can drive a session.
func (a Agent) Primary() bool { return a.Mode != "subagent" && !a.Hidden }

// Label is the display name.
func (a Agent) Label() string {
	if a.Name != "" {
		return a.Name
	}
	return a.ID
}

// Model is ModelInfo.
type Model struct {
	ID           string `json:"id"`
	ModelID      string `json:"modelID"`
	ProviderID   string `json:"providerID"`
	Name         string `json:"name"`
	Family       string `json:"family,omitempty"`
	Status       string `json:"status,omitempty"`
	Enabled      bool   `json:"enabled"`
	Capabilities struct {
		Tools bool     `json:"tools"`
		Input []string `json:"input"`
	} `json:"capabilities"`
	Variants []struct {
		ID string `json:"id"`
	} `json:"variants"`
	Time struct {
		Released json.RawMessage `json:"released"`
	} `json:"time"`
	Cost []struct {
		Input  float64 `json:"input"`
		Output float64 `json:"output"`
	} `json:"cost"`
	Limit struct {
		Context float64 `json:"context"`
		Output  float64 `json:"output"`
	} `json:"limit"`
}

// Ref returns the model's reference.
func (m Model) Ref() ModelRef { return ModelRef{ID: m.ID, ProviderID: m.ProviderID} }

// HasVariant reports whether id is one of the model's variants.
func (m Model) HasVariant(id string) bool {
	for _, v := range m.Variants {
		if v.ID == id {
			return true
		}
	}
	return false
}

// Provider is ProviderInfo.
type Provider struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Activation string `json:"activation"`
}

// Command is a server slash command.
type Command struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// Skill is a skill entry.
type Skill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// Reference is an @alias.
type Reference struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Description string `json:"description,omitempty"`
	Hidden      bool   `json:"hidden,omitempty"`
}

// MCPServer is one MCP status row.
type MCPServer struct {
	Name   string `json:"name"`
	Status struct {
		Status string `json:"status"`
		Error  string `json:"error,omitempty"`
	} `json:"status"`
}

// VCS is the repository state.
type VCS struct {
	Provider string `json:"provider,omitempty"`
	Branch   struct {
		Current string `json:"current,omitempty"`
		Default string `json:"default,omitempty"`
	} `json:"branch"`
}

// ConfigEntry is one config document.
type ConfigEntry struct {
	Type string `json:"type"`
	Path string `json:"path,omitempty"`
	Info struct {
		Model        json.RawMessage `json:"model,omitempty"`
		DefaultAgent string          `json:"default_agent,omitempty"`
	} `json:"info"`
}

// PermissionRequest is a pending approval.
type PermissionRequest struct {
	ID        string          `json:"id"`
	SessionID string          `json:"sessionID"`
	Action    string          `json:"action"`
	Resources []string        `json:"resources"`
	Save      []string        `json:"save,omitempty"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	Source    *struct {
		Type      string `json:"type"`
		MessageID string `json:"messageID"`
		ID        string `json:"id"`
	} `json:"source,omitempty"`
	Message string `json:"message,omitempty"`
}

// FormOption is one choice of a form field.
type FormOption struct {
	Value       json.RawMessage `json:"value"`
	Label       string          `json:"label"`
	Description string          `json:"description,omitempty"`
}

// FormField is one input of a form.
type FormField struct {
	Key         string          `json:"key"`
	Type        string          `json:"type"` // string | number | integer | boolean | multiselect | external
	Title       string          `json:"title,omitempty"`
	Description string          `json:"description,omitempty"`
	Required    bool            `json:"required,omitempty"`
	Hidden      bool            `json:"hidden,omitempty"`
	Options     []FormOption    `json:"options,omitempty"`
	Custom      bool            `json:"custom,omitempty"`
	Placeholder string          `json:"placeholder,omitempty"`
	Default     json.RawMessage `json:"default,omitempty"`
	URL         string          `json:"url,omitempty"`
	When        []struct {
		Key   string          `json:"key"`
		Op    string          `json:"op"`
		Value json.RawMessage `json:"value"`
	} `json:"when,omitempty"`
}

// Form is a question or an elicitation.
type Form struct {
	ID        string          `json:"id"`
	SessionID string          `json:"sessionID"`
	Title     string          `json:"title"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	Fields    []FormField     `json:"fields"`
	// Directory for global (MCP) forms, from the event location.
	Directory string `json:"-"`
}

// InboxItem is a queued input.
type InboxItem struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Delivery string `json:"delivery"`
	Payload  struct {
		Text string `json:"text,omitempty"`
	} `json:"payload"`
	Time struct {
		Created int64 `json:"created"`
	} `json:"time"`
}

// Info is GET /api/info.
type Info struct {
	Version string   `json:"version"`
	PID     int      `json:"pid"`
	URLs    []string `json:"urls"`
}

// PromptFile is a file attached to a prompt.
type PromptFile struct {
	URI         string   `json:"uri"`
	Name        string   `json:"name,omitempty"`
	Description string   `json:"description,omitempty"`
	Mention     *Mention `json:"mention,omitempty"`
}

// Mention ties an attachment to a span of the prompt text (display-width offsets).
type Mention struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Text  string `json:"text"`
}

// PromptAgent is an @agent mention.
type PromptAgent struct {
	Name    string   `json:"name"`
	Mention *Mention `json:"mention,omitempty"`
}

// PromptSkill is an @skill mention.
type PromptSkill struct {
	ID      string   `json:"id"`
	Mention *Mention `json:"mention,omitempty"`
}

// Prompt is the body of POST /session/{id}/prompt.
type Prompt struct {
	ID       string        `json:"id,omitempty"`
	Text     string        `json:"text"`
	Files    []PromptFile  `json:"files,omitempty"`
	Agents   []PromptAgent `json:"agents,omitempty"`
	Skills   []PromptSkill `json:"skills,omitempty"`
	Delivery string        `json:"delivery,omitempty"`
}

// FSEntry is a file search hit.
type FSEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

// RPCFeature is one InfiniteOC webui feature (mods/webui views.ts).
type RPCFeature struct {
	ID          string `json:"id"`
	Slash       string `json:"slash"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Session     bool   `json:"session,omitempty"`
}

// RPCItem is a selectable row or action of an RPCView.
type RPCItem struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

// RPCView is a server-built view. Selecting an item or action sends its ID as the next action;
// submitting the input sends Input.Action with the typed value.
type RPCView struct {
	Title   string    `json:"title"`
	Text    string    `json:"text,omitempty"`
	Items   []RPCItem `json:"items,omitempty"`
	Actions []RPCItem `json:"actions,omitempty"`
	Input   *struct {
		Placeholder string `json:"placeholder"`
		Action      string `json:"action"`
		Value       string `json:"value,omitempty"`
	} `json:"input,omitempty"`
	Toast *struct {
		Message string `json:"message"`
		Variant string `json:"variant"`
	} `json:"toast,omitempty"`
}
