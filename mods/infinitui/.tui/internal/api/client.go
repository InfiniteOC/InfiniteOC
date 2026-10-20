package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Client talks to one OpenCode v2 server.
type Client struct {
	BaseURL   string
	Directory string // default location for catalog requests
	auth      string
	http      *http.Client
}

// New builds a client. password may be empty for an unauthenticated server.
func New(baseURL, password, directory string) *Client {
	c := &Client{
		BaseURL:   strings.TrimRight(baseURL, "/"),
		Directory: directory,
		http:      &http.Client{Timeout: 30 * time.Second},
	}
	if password != "" {
		c.auth = "Basic " + base64.StdEncoding.EncodeToString([]byte("opencode:"+password))
	}
	return c
}

// APIError is a non-2xx answer: {"_tag": "...", "message": "..."}.
type APIError struct {
	Status  int
	Tag     string `json:"_tag"`
	Message string `json:"message"`
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.Tag != "" {
		return e.Tag
	}
	return fmt.Sprintf("HTTP %d", e.Status)
}

// IsTag reports whether err is an APIError with the tag.
func IsTag(err error, tag string) bool {
	if e, ok := err.(*APIError); ok {
		return e.Tag == tag
	}
	return false
}

// Query builds deepObject-style query strings.
type Query = url.Values

func (c *Client) loc(q url.Values, dir string) url.Values {
	if q == nil {
		q = url.Values{}
	}
	if dir == "" {
		dir = c.Directory
	}
	if dir != "" {
		q.Set("location[directory]", dir)
	}
	return q
}

func (c *Client) do(ctx context.Context, method, path string, q url.Values, body, out any) error {
	u := c.BaseURL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if c.auth != "" {
		req.Header.Set("Authorization", c.auth)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		e := &APIError{Status: res.StatusCode}
		_ = json.Unmarshal(data, e)
		if e.Message == "" && e.Tag == "" {
			e.Message = strings.TrimSpace(string(data))
			if len(e.Message) > 200 {
				e.Message = e.Message[:200]
			}
		}
		return e
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

type envelope[T any] struct {
	Data T `json:"data"`
}

type page[T any] struct {
	Data   []T `json:"data"`
	Cursor struct {
		Previous *string `json:"previous"`
		Next     *string `json:"next"`
	} `json:"cursor"`
}

func get[T any](c *Client, ctx context.Context, path string, q url.Values) (T, error) {
	var env envelope[T]
	err := c.do(ctx, http.MethodGet, path, q, nil, &env)
	return env.Data, err
}

// --- server ---

// Info returns server identity; used as the health check.
func (c *Client) Info(ctx context.Context) (Info, error) {
	var info Info
	err := c.do(ctx, http.MethodGet, "/api/info", nil, nil, &info)
	return info, err
}

// CanonicalDirectory asks the server how it sees dir (symlinks resolved).
func (c *Client) CanonicalDirectory(ctx context.Context, dir string) (string, error) {
	var res struct {
		Location Location `json:"location"`
	}
	err := c.do(ctx, http.MethodGet, "/api/fs/list", c.loc(nil, dir), nil, &res)
	return res.Location.Directory, err
}

// --- catalogs (location scoped) ---

func (c *Client) Agents(ctx context.Context) ([]Agent, error) {
	return get[[]Agent](c, ctx, "/api/agent", c.loc(nil, ""))
}
func (c *Client) Models(ctx context.Context) ([]Model, error) {
	return get[[]Model](c, ctx, "/api/model", c.loc(nil, ""))
}
func (c *Client) Providers(ctx context.Context) ([]Provider, error) {
	return get[[]Provider](c, ctx, "/api/provider", c.loc(nil, ""))
}
func (c *Client) Commands(ctx context.Context) ([]Command, error) {
	return get[[]Command](c, ctx, "/api/command", c.loc(nil, ""))
}
func (c *Client) Skills(ctx context.Context) ([]Skill, error) {
	return get[[]Skill](c, ctx, "/api/skill", c.loc(nil, ""))
}
func (c *Client) References(ctx context.Context) ([]Reference, error) {
	return get[[]Reference](c, ctx, "/api/reference", c.loc(nil, ""))
}
func (c *Client) MCP(ctx context.Context) ([]MCPServer, error) {
	return get[[]MCPServer](c, ctx, "/api/mcp", c.loc(nil, ""))
}
func (c *Client) VCS(ctx context.Context) (VCS, error) {
	return get[VCS](c, ctx, "/api/vcs", c.loc(nil, ""))
}

// Config returns the bare config entry list.
func (c *Client) Config(ctx context.Context) ([]ConfigEntry, error) {
	var out []ConfigEntry
	err := c.do(ctx, http.MethodGet, "/api/config", c.loc(nil, ""), nil, &out)
	return out, err
}

// FindFiles searches the project for paths.
func (c *Client) FindFiles(ctx context.Context, query string, limit int) ([]FSEntry, error) {
	q := c.loc(url.Values{"query": {query}, "limit": {fmt.Sprint(limit)}}, "")
	return get[[]FSEntry](c, ctx, "/api/fs/find", q)
}

// --- sessions ---

// SessionList returns sessions, newest first. roots limits to sessions without a parent.
func (c *Client) SessionList(ctx context.Context, limit int, search string, roots bool, directory string) ([]Session, error) {
	q := url.Values{"limit": {fmt.Sprint(limit)}, "order": {"desc"}}
	if search != "" {
		q.Set("search", search)
	}
	if roots {
		q.Set("parentID", "null")
	}
	if directory != "" {
		q.Set("directory", directory)
	}
	var p page[Session]
	err := c.do(ctx, http.MethodGet, "/api/session", q, nil, &p)
	return p.Data, err
}

// Children lists a session's direct children.
func (c *Client) Children(ctx context.Context, id string) ([]Session, error) {
	q := url.Values{"parentID": {id}, "order": {"desc"}, "limit": {"200"}}
	var p page[Session]
	err := c.do(ctx, http.MethodGet, "/api/session", q, nil, &p)
	return p.Data, err
}

// Active returns the IDs of running sessions.
func (c *Client) Active(ctx context.Context) (map[string]struct{ Type string }, error) {
	return get[map[string]struct{ Type string }](c, ctx, "/api/session/active", nil)
}

func (c *Client) Session(ctx context.Context, id string) (Session, error) {
	return get[Session](c, ctx, "/api/session/"+url.PathEscape(id), nil)
}

// CreateSession creates a session with a client-chosen ID.
func (c *Client) CreateSession(ctx context.Context, id, agent string, model *ModelRef) (Session, error) {
	body := map[string]any{"id": id, "location": Location{Directory: c.Directory}}
	if agent != "" {
		body["agent"] = agent
	}
	if model != nil && !model.Empty() {
		body["model"] = model
	}
	var env envelope[Session]
	err := c.do(ctx, http.MethodPost, "/api/session", nil, body, &env)
	return env.Data, err
}

// Rename sets a title; an empty title asks the server to generate one.
func (c *Client) Rename(ctx context.Context, id, title string) error {
	return c.do(ctx, http.MethodPatch, "/api/session/"+url.PathEscape(id), nil, map[string]any{"title": title}, nil)
}

func (c *Client) DeleteSession(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/session/"+url.PathEscape(id), nil, nil, nil)
}

// Fork copies history before messageID (all of it when empty) into a new session.
func (c *Client) Fork(ctx context.Context, id, before string) (Session, error) {
	body := map[string]any{}
	if before != "" {
		body["before"] = before
	}
	var env envelope[Session]
	err := c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(id)+"/fork", nil, body, &env)
	return env.Data, err
}

func (c *Client) SetAgent(ctx context.Context, id, agent string) error {
	return c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(id)+"/agent", nil, map[string]any{"agent": agent}, nil)
}

func (c *Client) SetModel(ctx context.Context, id string, m ModelRef) error {
	return c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(id)+"/model", nil, map[string]any{"model": m}, nil)
}

func (c *Client) Prompt(ctx context.Context, id string, p Prompt) error {
	return c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(id)+"/prompt", nil, p, nil)
}

// RunCommand runs a server slash command with its arguments.
func (c *Client) RunCommand(ctx context.Context, id, name, args string) error {
	body := map[string]any{"name": name, "text": args}
	return c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(id)+"/command", nil, body, nil)
}

// Shell runs a `!command` in the session.
func (c *Client) Shell(ctx context.Context, id, command string) error {
	body := map[string]any{"id": NewMessageID(), "command": command}
	return c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(id)+"/shell", nil, body, nil)
}

func (c *Client) Compact(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(id)+"/compact", nil, map[string]any{"id": NewMessageID()}, nil)
}

func (c *Client) Interrupt(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(id)+"/interrupt", url.Values{"resume": {"true"}}, nil, nil)
}

// Background moves the running tool call to the background.
func (c *Client) Background(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(id)+"/background", nil, nil, nil)
}

// Wait blocks until the session is idle (experimental endpoint).
func (c *Client) Wait(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/api/experimental/session/"+url.PathEscape(id)+"/wait", nil, nil, nil)
}

// Messages returns the newest limit messages, oldest first, and a cursor for older ones.
func (c *Client) Messages(ctx context.Context, id string, limit int, cursor string) ([]*Message, string, error) {
	q := url.Values{"limit": {fmt.Sprint(limit)}}
	if cursor != "" {
		q.Set("cursor", cursor)
	} else {
		q.Set("order", "desc")
	}
	var p page[*Message]
	if err := c.do(ctx, http.MethodGet, "/api/session/"+url.PathEscape(id)+"/message", q, nil, &p); err != nil {
		return nil, "", err
	}
	msgs := p.Data
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	next := ""
	if p.Cursor.Next != nil {
		next = *p.Cursor.Next
	}
	return msgs, next, nil
}

// Message fetches one message.
func (c *Client) Message(ctx context.Context, sessionID, messageID string) (*Message, error) {
	return get[*Message](c, ctx, "/api/session/"+url.PathEscape(sessionID)+"/message/"+url.PathEscape(messageID), nil)
}

func (c *Client) Inbox(ctx context.Context, id string) ([]InboxItem, error) {
	return get[[]InboxItem](c, ctx, "/api/session/"+url.PathEscape(id)+"/inbox", nil)
}

func (c *Client) CancelInbox(ctx context.Context, id, inboxID string) error {
	return c.do(ctx, http.MethodDelete, "/api/session/"+url.PathEscape(id)+"/inbox/"+url.PathEscape(inboxID), nil, nil, nil)
}

// RevertStage undoes messageID and everything after it, restoring files.
func (c *Client) RevertStage(ctx context.Context, id, messageID string) error {
	return c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(id)+"/revert/stage", nil, map[string]any{"messageID": messageID, "files": true}, nil)
}

func (c *Client) RevertClear(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/session/"+url.PathEscape(id)+"/revert", nil, nil, nil)
}

func (c *Client) RevertCommit(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(id)+"/revert/commit", nil, nil, nil)
}

// View acknowledges an idle session (clears unread).
func (c *Client) View(ctx context.Context, id string, idle int64) error {
	return c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(id)+"/view", nil, map[string]any{"idle": idle}, nil)
}

// Environment hands the terminal environment to the session's tools.
func (c *Client) Environment(ctx context.Context, id string, vars map[string]string) error {
	return c.do(ctx, http.MethodPut, "/api/session/"+url.PathEscape(id)+"/environment", nil, map[string]any{"variables": vars}, nil)
}

// Diff returns the session's net file changes: from its first prompt through its last.
// Without both ends the server only diffs the latest turn.
func (c *Client) Diff(ctx context.Context, id string) ([]FileDiff, error) {
	edge := func(order string) string {
		q := url.Values{"limit": {"1"}, "order": {order}, "type": {"user"}}
		var p page[*Message]
		if c.do(ctx, http.MethodGet, "/api/session/"+url.PathEscape(id)+"/message", q, nil, &p) != nil || len(p.Data) == 0 {
			return ""
		}
		return p.Data[0].ID
	}
	q := url.Values{}
	if from, to := edge("asc"), edge("desc"); from != "" && to != "" {
		q.Set("from", from)
		q.Set("to", to)
	}
	return get[[]FileDiff](c, ctx, "/api/session/"+url.PathEscape(id)+"/diff", q)
}

// Export returns the whole session.
func (c *Client) Export(ctx context.Context, id string) (Session, []*Message, error) {
	res, err := get[struct {
		Info     Session    `json:"info"`
		Messages []*Message `json:"messages"`
	}](c, ctx, "/api/experimental/session/"+url.PathEscape(id)+"/export", nil)
	return res.Info, res.Messages, err
}

// --- permissions and forms ---

func (c *Client) Permissions(ctx context.Context, id string) ([]PermissionRequest, error) {
	return get[[]PermissionRequest](c, ctx, "/api/session/"+url.PathEscape(id)+"/permission", nil)
}

// ReplyPermission answers once | always | reject (message only with reject).
func (c *Client) ReplyPermission(ctx context.Context, sessionID, requestID, decision, message string) error {
	body := map[string]any{"decision": decision}
	if message != "" {
		body["message"] = message
	}
	err := c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(sessionID)+"/permission/"+url.PathEscape(requestID)+"/reply", nil, body, nil)
	if IsTag(err, "PermissionNotFoundError") {
		return nil
	}
	return err
}

func (c *Client) Forms(ctx context.Context, id string) ([]Form, error) {
	return get[[]Form](c, ctx, "/api/session/"+url.PathEscape(id)+"/form", nil)
}

// ReplyForm answers a form; answer maps field keys to values.
func (c *Client) ReplyForm(ctx context.Context, f Form, answer map[string]any) error {
	return c.do(ctx, http.MethodPost, "/api/session/"+url.PathEscape(f.SessionID)+"/form/"+url.PathEscape(f.ID)+"/reply", c.formLoc(f), map[string]any{"answer": answer}, nil)
}

// CancelForm dismisses a form.
func (c *Client) CancelForm(ctx context.Context, f Form) error {
	return c.do(ctx, http.MethodDelete, "/api/session/"+url.PathEscape(f.SessionID)+"/form/"+url.PathEscape(f.ID), c.formLoc(f), nil, nil)
}

func (c *Client) formLoc(f Form) url.Values {
	if f.SessionID == "global" {
		return c.loc(nil, f.Directory)
	}
	return nil
}

// --- InfiniteOC RPC (mods/webui) ---

func (c *Client) rpc(ctx context.Context, method string, input string, out any) error {
	var res struct {
		Output json.RawMessage `json:"output"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/rpc/infiniteoc/"+method, c.loc(nil, ""), map[string]any{"input": input}, &res); err != nil {
		return err
	}
	// The output is a JSON string holding JSON.
	var s string
	if err := json.Unmarshal(res.Output, &s); err != nil {
		return json.Unmarshal(res.Output, out)
	}
	return json.Unmarshal([]byte(s), out)
}

// Features lists server-built InfiniteOC views.
func (c *Client) Features(ctx context.Context) ([]RPCFeature, error) {
	var out []RPCFeature
	err := c.rpc(ctx, "features", "", &out)
	return out, err
}

// RunFeature renders a view, optionally applying an action with a value.
func (c *Client) RunFeature(ctx context.Context, feature, action, value, sessionID string) (RPCView, error) {
	in, _ := json.Marshal(map[string]any{"feature": feature, "action": action, "value": value, "sessionID": sessionID, "directory": c.Directory})
	var out RPCView
	err := c.rpc(ctx, "run", string(in), &out)
	return out, err
}

// Warm asks the server (mods/fastlane) to open connections to recently used providers.
func (c *Client) Warm(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/api/rpc/fastlane/warm", c.loc(nil, ""), map[string]any{"input": ""}, nil)
}

// Reconnect tells the server the network changed: stuck requests are resent on fresh connections.
func (c *Client) Reconnect(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/api/rpc/fastlane/reconnect", c.loc(nil, ""), map[string]any{"input": ""}, nil)
}

// --- IDs (schema/src/identifier.ts) ---

var (
	idMu      sync.Mutex
	idLastMs  int64
	idCounter int64
)

const idAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

func newID(prefix string, descending bool) string {
	idMu.Lock()
	now := time.Now().UnixMilli()
	if now != idLastMs {
		idLastMs = now
		idCounter = 0
	}
	idCounter++
	current := uint64(now)*0x1000 + uint64(idCounter)
	idMu.Unlock()
	if descending {
		current = ^current
	}
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], current)
	hex := fmt.Sprintf("%012x", buf[2:])
	rnd := make([]byte, 14)
	_, _ = rand.Read(rnd)
	for i := range rnd {
		rnd[i] = idAlphabet[int(rnd[i])%len(idAlphabet)]
	}
	return prefix + "_" + hex + string(rnd)
}

// NewSessionID returns a descending session ID (newer sorts first).
func NewSessionID() string { return newID("ses", true) }

// NewMessageID returns an ascending message ID.
func NewMessageID() string { return newID("msg", false) }
