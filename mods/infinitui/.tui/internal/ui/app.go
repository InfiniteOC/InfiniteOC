package ui

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"infiniteoc/infinitui/internal/api"
	"infiniteoc/infinitui/internal/theme"
)

// Options configure the app from the command line.
type Options struct {
	Client     *api.Client
	Version    string
	SessionID  string // open this session
	NewID      string // create the first session with this ID
	Continue   bool
	Prompt     string // submit on start
	Auto       bool   // yolo from --auto
	Notice     string // startup warning (INFINITEOC_NOTICE)
	Handoff    string // file for /classic to pass the session to the classic UI
	DaemonSock string
	DaemonID   string
	Animations bool
}

// ExitClassic is the exit code that asks the launcher to start the classic UI.
const ExitClassic = 75

// App is the root bubbletea model.
type App struct {
	opt    Options
	client *api.Client
	store  *Store
	ctx    context.Context
	cancel context.CancelFunc

	width, height int
	cwd           string
	connected     bool
	everConnected bool

	sessionID string
	trail     []string // parent sessions when browsing into subagents
	tr        *Transcript
	ropts     renderOpts
	dirty     bool
	// The last frame, reused while nothing on screen changed (plain mouse motion over the same block).
	frameView tea.View
	frameOK   bool

	prompt *Prompt
	comp   *completion

	agent        string
	model        api.ModelRef
	modelSet     bool // user picked a model explicitly in this UI
	mprefs       *modelPrefs
	uprefs       uiPrefs
	dialog       Dialog
	toast        *toast
	frame        int
	ticking      bool
	started      time.Time
	focused      bool
	yolo         bool
	leader       bool
	lastEsc      time.Time
	lastCtrlC    time.Time
	permIdx      int
	perm         *permissionCard
	form         *formCard
	exitCode     int
	quitting     bool
	tokensAt     map[string]float64 // output tokens at execution start
	notified     map[string]bool
	pendingCmd   string // server command to run once the session exists
	sessions     []api.Session
	lastToolAt   time.Time
	sel          selection
	hover        string // block key under the mouse
	fadeFrom     *theme.Palette
	fadeTo       *theme.Palette
	fadeStart    time.Time
	lightTerm    bool           // the terminal reported a light background
	outlineRows  map[int]string // sidebar row -> prompt message ID
	titleTarget  string         // session title being typed into the header
	titleShown   int
	titleSession string
	lastWarm     time.Time
	previewing   map[string]bool
	fleet        fleet
	// pendingCmds are commands queued while rendering (fetches a view discovered it needs)
	pendingCmds []tea.Cmd
}

// New builds the app.
func New(opt Options) *App {
	ctx, cancel := context.WithCancel(context.Background())
	a := &App{
		opt:        opt,
		client:     opt.Client,
		store:      NewStore(),
		ctx:        ctx,
		cancel:     cancel,
		cwd:        opt.Client.Directory,
		tr:         NewTranscript(),
		prompt:     NewPrompt(),
		mprefs:     loadModelPrefs(),
		uprefs:     loadUIPrefs(),
		started:    time.Now(),
		focused:    true,
		yolo:       opt.Auto,
		tokensAt:   map[string]float64{},
		previewing: map[string]bool{},
		notified:   map[string]bool{},
	}
	if p, ok := theme.ByName(a.uprefs.Theme); ok {
		theme.Apply(p)
	} else {
		theme.Apply(theme.InfiniteOC)
	}
	a.prompt.styles()
	a.ropts = renderOpts{expanded: map[string]bool{}, cwd: a.cwd, store: a.store, showThought: a.uprefs.ShowThought, reveal: map[*api.Block]int{}}
	a.sessionID = opt.SessionID
	if opt.NewID != "" {
		a.sessionID = ""
	}
	return a
}

// Context is cancelled when the app quits.
func (a *App) Context() context.Context { return a.ctx }

// SessionID is the session on screen.
func (a *App) SessionID() string { return a.sessionID }

// ExitCode is the process exit status the UI asks for.
func (a *App) ExitCode() int { return a.exitCode }

// EventsMsg carries a batch of server events.
type EventsMsg []api.Event

type tickMsg time.Time

func (a *App) tick() tea.Cmd {
	if a.ticking {
		return nil
	}
	a.ticking = true
	d := 80 * time.Millisecond
	if a.smoothing() {
		d = 33 * time.Millisecond // ~30 fps while text flows in or the view glides
	}
	return tea.Tick(d, func(t time.Time) tea.Msg { return tickMsg(t) })
}

// advanceReveal moves each streaming text block's visible length toward what has arrived.
// It returns whether any block is still catching up.
func (a *App) advanceReveal() bool {
	d, ok := a.store.Get(a.sessionID)
	if !ok {
		return false
	}
	behind := false
	seen := map[*api.Block]bool{}
	for _, m := range d.msgs {
		if m.Type != "assistant" || m.Time.Completed != 0 {
			continue
		}
		for _, b := range m.Content {
			if b.Type != "text" {
				continue
			}
			seen[b] = true
			target := len(strings.TrimSpace(b.Text))
			n, ok := a.ropts.reveal[b]
			if !ok && !a.opt.Animations {
				n = target
			}
			if n < target {
				n += max(3, (target-n)/5)
				n = min(n, target)
			}
			a.ropts.reveal[b] = n
			if n < target {
				behind = true
			}
		}
	}
	for b := range a.ropts.reveal {
		if !seen[b] {
			delete(a.ropts.reveal, b)
		}
	}
	return behind
}

// smoothing reports whether something is mid-animation and wants a high frame rate.
func (a *App) smoothing() bool {
	if ed, ok := a.dialog.(*effortDialog); ok && ed.moving() {
		return true
	}
	if a.tr.gliding() || a.fadeTo != nil || (a.toast != nil && time.Since(a.toast.born) < 300*time.Millisecond) {
		return true
	}
	d, ok := a.store.Get(a.sessionID)
	if !ok {
		return false
	}
	for b, n := range a.ropts.reveal {
		if n < len(strings.TrimSpace(b.Text)) {
			return true
		}
	}
	return d.running && len(a.ropts.reveal) > 0
}

// animating reports whether anything on screen moves.
func (a *App) animating() bool {
	if a.opt.Animations && time.Since(a.started) < homeLoop+100*time.Millisecond && a.home() {
		return true
	}
	if a.toast != nil || len(a.store.models) == 0 {
		return true
	}
	if a.fleet.open && a.fleetRunning() {
		return true
	}
	for id, d := range a.store.sessions {
		if d.running && (id == a.sessionID || a.store.InTree(a.sessionID, id)) {
			return true
		}
	}
	if a.titleShown < len([]rune(a.titleTarget)) {
		return true
	}
	if d, ok := a.store.Get(a.sessionID); ok && a.sessionID != "" && a.headerTitle(d) != a.titleTarget {
		return true // a rename is about to type itself in
	}
	if d, ok := a.store.Get(a.sessionID); ok && len(d.msgs) > 0 {
		if m := d.msgs[len(d.msgs)-1]; m.Type == "idle" && time.Now().UnixMilli()-m.Time.Created < donePulse+200 {
			return true
		}
	}
	return false
}

// home reports whether the empty-session screen shows.
func (a *App) home() bool {
	if a.sessionID == "" {
		return true
	}
	d, ok := a.store.Get(a.sessionID)
	return ok && d.loaded && len(d.msgs) == 0
}

// Init starts loading.
func (a *App) Init() tea.Cmd {
	cmds := []tea.Cmd{a.tick(), tea.RequestBackgroundColor}
	if a.opt.Notice != "" {
		cmds = append(cmds, a.showToast("warning", "", a.opt.Notice, 8*time.Second))
	}
	if a.opt.DaemonSock != "" {
		cmds = append(cmds, a.pollDaemon(0))
	}
	return tea.Batch(cmds...)
}

// Update routes messages.
func (a *App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd
	still := false
	switch m := msg.(type) {
	case tea.WindowSizeMsg:
		a.width, a.height = m.Width, m.Height
		a.dirty = true
	case tea.FocusMsg:
		a.focused = true
	case tea.BlurMsg:
		a.focused = false
	case tea.BackgroundColorMsg:
		// Respect light terminals unless the user chose a theme.
		if a.uprefs.Theme == "" && !m.IsDark() {
			a.lightTerm = true
			theme.Apply(theme.Light)
			a.prompt.styles()
			a.dirty = true
		}
	case tickMsg:
		a.ticking = false
		a.frame++
		a.ropts.frame = a.frame
		a.advanceReveal()
		a.tr.glide()
		if ed, ok := a.dialog.(*effortDialog); ok {
			ed.gliding()
		}
		a.stepFade()
		if a.toast != nil && time.Now().After(a.toast.until) {
			a.toast = nil
		}
		a.dirty = true
		if a.animating() || a.smoothing() {
			cmds = append(cmds, a.tick())
		}
	case EventsMsg:
		for _, ev := range m {
			cmds = append(cmds, a.applyEvent(ev))
		}
		a.dirty = true
		if a.animating() {
			cmds = append(cmds, a.tick())
		}
	case tea.KeyPressMsg:
		cmds = append(cmds, a.handleKey(m))
		a.dirty = true
	case tea.PasteMsg:
		if a.dialog != nil {
			cmd := a.dialogUpdate(m)
			cmds = append(cmds, cmd)
		} else if a.perm == nil {
			text := strings.ReplaceAll(m.Content, "\r\n", "\n")
			a.prompt.Paste(text)
			cmds = append(cmds, a.refreshCompletion())
		}
		a.dirty = true
	case tea.MouseWheelMsg:
		if a.dialog != nil {
			cmd := a.dialogUpdate(m)
			cmds = append(cmds, cmd)
		} else {
			if m.Button == tea.MouseWheelUp {
				a.tr.Scroll(-3)
				cmds = append(cmds, a.maybeLoadOlder())
			} else if m.Button == tea.MouseWheelDown {
				a.tr.Scroll(3)
			}
		}
		a.dirty = true
	case tea.MouseClickMsg:
		a.mouseDown(m.Mouse())
		a.dirty = true
	case tea.MouseMotionMsg:
		hover, down := a.hover, a.sel.down
		cmds = append(cmds, a.mouseDrag(m.Mouse()))
		// Every pointer move is a message (one console record each on Windows); one that stays over the
		// same block changes nothing, so the last frame is reused instead of rebuilding the transcript.
		still = !down && a.hover == hover
		a.dirty = true
	case tea.MouseReleaseMsg:
		cmds = append(cmds, a.mouseUp(m.Mouse()))
		a.dirty = true
	default:
		cmds = append(cmds, a.handleResult(msg))
	}
	if !still {
		a.frameOK = false
	}
	if a.quitting {
		a.cancel()
		return a, tea.Quit
	}
	if sd, ok := a.dialog.(*sessionDialog); ok {
		if it, ok := sd.p.Current(); ok && it.ID != "" && !a.previewing[it.ID] {
			if d, ok := a.store.Get(it.ID); !ok || (!d.loaded && len(d.msgs) == 0) {
				a.previewing[it.ID] = true
				a.pendingCmds = append(a.pendingCmds, a.loadPreview(it.ID))
			}
		}
	}
	if len(a.pendingCmds) > 0 {
		cmds = append(cmds, a.pendingCmds...)
		a.pendingCmds = nil
	}
	if !a.ticking && (a.smoothing() || a.animating()) {
		cmds = append(cmds, a.tick())
	}
	return a, tea.Batch(cmds...)
}

func (a *App) applyEvent(ev api.Event) tea.Cmd {
	var cmds []tea.Cmd
	for _, e := range a.store.Apply(ev) {
		cmds = append(cmds, a.effect(e))
	}
	return tea.Batch(cmds...)
}

// relevant reports whether a tui.* event addresses this UI's directory.
func (a *App) relevant(loc string) bool { return loc == "" || loc == a.cwd }

func (a *App) effect(e Effect) tea.Cmd {
	switch e.Kind {
	case effConnected:
		a.connected = true
		first := !a.everConnected
		a.everConnected = true
		if first {
			return a.bootstrap()
		}
		return tea.Batch(a.loadCatalogs(), a.resync())
	case effDisconnected:
		a.connected = false
	case effCatalog:
		if a.relevant(e.Location) {
			return a.loadCatalogs()
		}
	case effFetchSession:
		return a.fetchSession(e.SessionID)
	case effFetchMessage:
		return a.fetchMessage(e.SessionID, e.Text)
	case effToast:
		if !a.relevant(e.Location) {
			return nil
		}
		d := time.Duration(e.Duration) * time.Millisecond
		if d <= 0 {
			d = 5 * time.Second
		}
		var cmds []tea.Cmd
		cmds = append(cmds, a.showToast(e.Variant, e.Title, e.Text, d))
		// mods/workflows announces a start with this toast: show the fleet.
		if e.Title == "Workflow" && strings.HasPrefix(e.Text, "Started") {
			cmds = append(cmds, a.openFleet())
		}
		if e.Title == "Goal" && !a.focused {
			cmds = append(cmds, notify("Goal", e.Text))
		}
		return tea.Batch(cmds...)
	case effSelect:
		if a.relevant(e.Location) && e.SessionID != "" {
			return a.openSession(e.SessionID, false)
		}
	case effPromptAppend:
		if a.relevant(e.Location) {
			a.prompt.Insert(e.Text)
		}
	case effCommand:
		if a.relevant(e.Location) {
			return a.runNamedCommand(e.Text)
		}
	case effStarted:
		if d, ok := a.store.Get(e.SessionID); ok {
			a.tokensAt[e.SessionID] = d.info.Tokens.Output + d.info.Tokens.Reasoning
		}
		delete(a.notified, e.SessionID)
		return a.tick()
	case effDone:
		if e.SessionID == a.sessionID {
			if strings.HasPrefix(e.Text, "failed") && !a.focused {
				return notify("InfiniteOC", "Run failed")
			}
			if !a.focused && !a.notified[e.SessionID] {
				a.notified[e.SessionID] = true
				title := "InfiniteOC"
				if d, ok := a.store.Get(e.SessionID); ok {
					title = d.info.DisplayTitle()
				}
				return notify(title, "Finished")
			}
		}
	case effPermission:
		if a.store.InTree(a.treeRoot(), e.SessionID) || e.SessionID == a.sessionID {
			if a.yolo {
				return a.autoApprove()
			}
			if !a.focused {
				return notify("InfiniteOC", "Permission needed")
			}
		} else {
			return a.fetchSession(e.SessionID)
		}
	case effForm:
		if !a.focused {
			return notify("InfiniteOC", "A question is waiting")
		}
	case effDeleted:
		if e.SessionID == a.sessionID {
			a.sessionID = ""
			a.trail = nil
			return a.showToast("info", "", "This session was deleted", 4*time.Second)
		}
	case effToolCompleted:
		a.lastToolAt = time.Now()
		switch e.Text {
		case "edit", "write", "patch", "apply_patch", "multiedit", "shell":
			if e.SessionID == a.sessionID || a.store.InTree(a.treeRoot(), e.SessionID) {
				return a.fetchDiff(a.sessionID)
			}
		}
	}
	return nil
}

// treeRoot is the session whose subtree this view covers.
func (a *App) treeRoot() string {
	if len(a.trail) > 0 {
		return a.store.Root(a.trail[0])
	}
	return a.store.Root(a.sessionID)
}

// handleKey is the keyboard router: dialog > permission > form > leader > global > completion > prompt.
func (a *App) handleKey(k tea.KeyPressMsg) tea.Cmd {
	ks := k.String()
	if a.dialog != nil {
		if ks == "ctrl+c" && a.dialog.Closable() {
			a.dialog = nil
			return nil
		}
		return a.dialogUpdate(k)
	}
	if a.leader {
		a.leader = false
		return a.leaderKey(ks)
	}
	if card := a.activePermission(); card != nil {
		return card.update(a, k)
	}
	if f := a.activeForm(); f != nil {
		return f.update(a, k)
	}

	switch ks {
	case "ctrl+x":
		a.leader = true
		return nil
	case "ctrl+c":
		if a.prompt.Value() != "" {
			a.prompt.Reset()
			a.comp = nil
			return nil
		}
		if a.running() && time.Since(a.lastCtrlC) > 1500*time.Millisecond {
			a.lastCtrlC = time.Now()
			return a.interrupt()
		}
		if time.Since(a.lastCtrlC) < 1500*time.Millisecond {
			a.quitting = true
			return nil
		}
		a.lastCtrlC = time.Now()
		return a.showToast("info", "", "Press ctrl+c again to exit", 1500*time.Millisecond)
	case "ctrl+d":
		if a.prompt.Value() == "" {
			a.quitting = true
			return nil
		}
	case "ctrl+p":
		return a.openPalette()
	case "ctrl+f":
		return a.toggleFleet()
	case "ctrl+o":
		a.ropts.expandAll = !a.ropts.expandAll
		a.tr.cache = map[string]cachedLines{}
		return nil
	case "ctrl+t":
		return a.cycleVariant()
	case "shift+tab":
		return a.cycleAgent(1)
	case "ctrl+n":
		return a.newSession()
	case "ctrl+l":
		return a.openSessions()
	case "ctrl+y":
		return a.copyLast()
	case "ctrl+r":
		return a.openHistory()
	case "ctrl+b":
		if a.running() {
			return a.background()
		}
	case "f1", "ctrl+?":
		return a.openHelp()
	case "f2":
		return a.openModels()
	case "pgup":
		a.tr.Scroll(-max(3, a.tr.height-3))
		return a.maybeLoadOlder()
	case "pgdown":
		a.tr.Scroll(max(3, a.tr.height-3))
		return nil
	case "alt+up":
		a.tr.JumpTurn(-1)
		return a.maybeLoadOlder()
	case "alt+down":
		a.tr.JumpTurn(1)
		return nil
	case "shift+up", "ctrl+alt+up":
		a.tr.Scroll(-1)
		return a.maybeLoadOlder()
	case "shift+down", "ctrl+alt+down":
		a.tr.Scroll(1)
		return nil
	case "esc":
		if a.comp != nil {
			a.comp = nil
			return nil
		}
		if a.fleet.open {
			a.fleet.open = false
			return nil
		}
		if len(a.trail) > 0 {
			return a.leaveChild()
		}
		if a.running() {
			a.lastEsc = time.Now()
			return a.interrupt()
		}
		if time.Since(a.lastEsc) < 600*time.Millisecond && a.prompt.Value() == "" && a.sessionID != "" {
			a.lastEsc = time.Time{}
			return a.openTimeline()
		}
		a.lastEsc = time.Now()
		return nil
	}

	if a.home() && a.prompt.Value() == "" {
		switch ks {
		case "alt+1", "alt+2", "alt+3":
			if r := a.recentSessions(); int(ks[4]-'1') < len(r) {
				return a.openSession(r[ks[4]-'1'].ID, false)
			}
		}
	}
	if a.prompt.Value() == "" {
		switch ks {
		case "home":
			a.tr.Top()
			return a.maybeLoadOlder()
		case "end":
			a.tr.Bottom()
			return nil
		}
	}

	if a.comp != nil {
		if cmd, handled := a.comp.key(a, ks); handled {
			return cmd
		}
	}

	switch ks {
	case "enter":
		v := a.prompt.Value()
		// A trailing backslash continues the line, like a shell.
		if strings.HasSuffix(a.prompt.BeforeCursor(), "\\") {
			a.prompt.ReplaceRange(len([]rune(a.prompt.BeforeCursor()))-1, "\n", nil)
			return nil
		}
		return a.submit(v)
	case "up":
		if a.prompt.OnFirstLine() && a.prompt.HistoryPrev() {
			a.comp = nil
			return nil
		}
	case "down":
		if a.prompt.OnLastLine() && a.prompt.HistoryNext() {
			a.comp = nil
			return nil
		}
	}
	before := a.prompt.Value()
	cmd := a.prompt.Update(k)
	return tea.Batch(cmd, a.refreshCompletion(), a.warmOnTyping(before))
}

func (a *App) leaderKey(ks string) tea.Cmd {
	switch ks {
	case "n":
		return a.newSession()
	case "l":
		return a.openSessions()
	case "m":
		return a.openModels()
	case "a":
		return a.openAgents()
	case "v":
		return a.openEffort()
	case "u":
		return a.undo()
	case "r":
		return a.redo()
	case "c":
		return a.compact()
	case "y":
		return a.copyLast()
	case "e":
		return a.openEditor()
	case "t":
		return a.openThemes()
	case "h", "?":
		return a.openHelp()
	case "g":
		return a.openTimeline()
	case "s":
		return a.openStatus()
	case "x":
		return a.exportTranscript()
	case "q":
		a.quitting = true
	case "b":
		return a.toggleSidebar()
	case "f":
		return a.toggleFleet()
	case "right":
		return a.openLatestChild()
	case "left":
		return a.leaveChild()
	}
	return nil
}

func (a *App) running() bool {
	if a.sessionID == "" {
		return false
	}
	d, ok := a.store.Get(a.sessionID)
	return ok && d.running
}

func (a *App) handleClick(m tea.Mouse) tea.Cmd {
	if a.dialog != nil {
		return nil
	}
	if a.sidebarOn() && m.X >= a.mainWidth() {
		if id, ok := a.outlineRows[m.Y]; ok {
			a.tr.ScrollToMessage(id)
		}
		return nil
	}
	top := a.layout().transcriptTop
	row := m.Y - top
	if row < 0 || row >= a.tr.height {
		return nil
	}
	key := a.tr.OwnerAt(row)
	if key == "" {
		return nil
	}
	// A subagent block opens its child session.
	if child := a.childForBlock(key); child != "" {
		return a.enterChild(child)
	}
	if strings.HasSuffix(key, "|user") {
		return a.openTurnMenu(key)
	}
	if code, ok := a.codeAt(key, a.tr.Shown()+row-a.tr.unitStart[key]); ok {
		return tea.Batch(tea.SetClipboard(code), copyNative(code), a.showToast("success", "", fmt.Sprintf("Copied %s of code", plural(strings.Count(code, "\n")+1, "line", "lines")), 1500*time.Millisecond))
	}
	a.tr.Toggle(&a.ropts, key)
	return nil
}

func (a *App) childForBlock(key string) string {
	parts := strings.SplitN(key, "|", 2)
	d, ok := a.store.Get(a.sessionID)
	if !ok || len(parts) != 2 {
		return ""
	}
	m := d.index[parts[0]]
	if m == nil {
		return ""
	}
	b := toolBlock(m, parts[1])
	if b == nil || (b.Name != "subagent" && b.Name != "task") || b.State == nil {
		return ""
	}
	return str(parseObj(b.State.Metadata), "sessionID")
}

// Quit hook for main: whether to hand off to the classic UI.
func (a *App) writeHandoff() {
	if a.opt.Handoff == "" {
		return
	}
	_ = os.WriteFile(a.opt.Handoff, []byte(a.sessionID), 0o600)
}

// dialogUpdate forwards to the open dialog and closes it when done, unless it opened another one.
func (a *App) dialogUpdate(msg tea.Msg) tea.Cmd {
	d := a.dialog
	cmd, done := d.Update(msg)
	if done && a.dialog == d {
		a.dialog = nil
	}
	return cmd
}

// warmOnTyping opens provider connections as soon as a new prompt starts, so the request skips the
// handshake (mods/fastlane; a server without it answers 404, which is ignored).
func (a *App) warmOnTyping(before string) tea.Cmd {
	if before != "" || a.prompt.Value() == "" || time.Since(a.lastWarm) < 15*time.Second {
		return nil
	}
	a.lastWarm = time.Now()
	return func() tea.Msg {
		ctx, cancel := timeout(a.bg(), 5*time.Second)
		defer cancel()
		_ = a.client.Warm(ctx)
		return nil
	}
}
