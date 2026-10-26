package ui

import (
	"context"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"infiniteoc/infinitui/internal/theme"
)

// localCommand runs inside the TUI (the rest come from the server's /api/command).
type localCommand struct {
	name     string
	aliases  []string
	title    string
	key      string
	category string
	args     string // argument hint; non-empty means enter waits for arguments
	hidden   bool
	run      func(a *App, args string) tea.Cmd
}

var localCommands []*localCommand

func findLocal(name string) *localCommand {
	for _, c := range localCommands {
		if c.name == name {
			return c
		}
		for _, al := range c.aliases {
			if al == name {
				return c
			}
		}
	}
	return nil
}

func init() {
	localCommands = []*localCommand{
		{name: "new", aliases: []string{"clear"}, title: "New session", key: "ctrl+n", category: "Session", run: func(a *App, _ string) tea.Cmd { return a.newSession() }},
		{name: "sessions", aliases: []string{"resume", "continue"}, title: "Switch session", key: "ctrl+l", category: "Session", run: func(a *App, _ string) tea.Cmd { return a.openSessions() }},
		{name: "rename", title: "Rename session", category: "Session", args: "<title>", run: func(a *App, args string) tea.Cmd { return a.rename(args) }},
		{name: "timeline", aliases: []string{"rewind"}, title: "Jump, rewind or fork from a message", key: "esc esc", category: "Session", run: func(a *App, _ string) tea.Cmd { return a.openTimeline() }},
		{name: "undo", title: "Undo the last message (restores files)", key: "ctrl+x u", category: "Session", run: func(a *App, _ string) tea.Cmd { return a.undo() }},
		{name: "redo", title: "Redo what /undo removed", key: "ctrl+x r", category: "Session", run: func(a *App, _ string) tea.Cmd { return a.redo() }},
		{name: "fork", title: "Fork this session", category: "Session", run: func(a *App, _ string) tea.Cmd { return a.forkAt("") }},
		{name: "compact", aliases: []string{"summarize"}, title: "Compact the context", key: "ctrl+x c", category: "Session", run: func(a *App, _ string) tea.Cmd { return a.compact() }},
		{name: "copy", title: "Copy the last response", key: "ctrl+y", category: "Session", run: func(a *App, _ string) tea.Cmd { return a.copyLast() }},
		{name: "export", aliases: []string{"transcript"}, title: "Export the transcript as Markdown", key: "ctrl+x x", category: "Session", run: func(a *App, _ string) tea.Cmd { return a.exportTranscript() }},
		{name: "subagent", title: "Open the latest subagent session", key: "ctrl+x →", category: "Session", run: func(a *App, _ string) tea.Cmd { return a.openLatestChild() }},
		{name: "interrupt", title: "Interrupt the agent", key: "esc", category: "Session", run: func(a *App, _ string) tea.Cmd { return a.interrupt() }},

		{name: "models", aliases: []string{"model"}, title: "Switch model", key: "f2", category: "Model", run: func(a *App, _ string) tea.Cmd { return a.openModels() }},
		{name: "agents", aliases: []string{"agent"}, title: "Switch agent", key: "shift+tab", category: "Model", run: func(a *App, _ string) tea.Cmd { return a.openAgents() }},
		{name: "effort", aliases: []string{"variants", "thinking"}, title: "Effort level (slider)", key: "ctrl+x v", category: "Model", run: func(a *App, _ string) tea.Cmd { return a.openEffort() }},
		{name: "infinicode", title: "Toggle InfiniCode (strongest effort, red theme)", category: "Model", run: func(a *App, _ string) tea.Cmd { return a.toggleInfiniCode() }},

		{name: "expand", title: "Expand or collapse all tool output", key: "ctrl+o", category: "View", run: func(a *App, _ string) tea.Cmd {
			a.ropts.expandAll = !a.ropts.expandAll
			a.tr.cache = map[string]cachedLines{}
			return nil
		}},
		{name: "thinking-view", title: "Show or hide full thinking", category: "View", run: func(a *App, _ string) tea.Cmd {
			a.ropts.showThought = !a.ropts.showThought
			a.uprefs.ShowThought = a.ropts.showThought
			a.uprefs.save()
			a.tr.cache = map[string]cachedLines{}
			return nil
		}},
		{name: "fleet", title: "Parallel agents panel (workflow steps live)", key: "ctrl+f", category: "View", run: func(a *App, args string) tea.Cmd { return a.fleetCommand(args) }},
		{name: "themes", aliases: []string{"theme"}, title: "Change theme", key: "ctrl+x t", category: "View", run: func(a *App, _ string) tea.Cmd { return a.openThemes() }},
		{name: "status", title: "Connection, model and MCP status", key: "ctrl+x s", category: "View", run: func(a *App, _ string) tea.Cmd { return a.openStatus() }},
		{name: "mcps", aliases: []string{"mcp"}, title: "MCP servers", category: "View", run: func(a *App, _ string) tea.Cmd { return a.openStatus() }},
		{name: "help", title: "Keyboard shortcuts", key: "f1", category: "View", run: func(a *App, _ string) tea.Cmd { return a.openHelp() }},
		{name: "history", title: "Search prompt history", key: "ctrl+r", category: "View", run: func(a *App, _ string) tea.Cmd { return a.openHistory() }},

		{name: "yolo", title: "Toggle YOLO (auto-approve permissions)", category: "System", run: func(a *App, _ string) tea.Cmd { return a.toggleYolo() }},
		{name: "reconnect", title: "Reconnect after a network or VPN change", category: "System", run: func(a *App, _ string) tea.Cmd {
			return tea.Batch(a.showToast("info", "", "Reconnecting: stuck requests resend on fresh connections", 2500*time.Millisecond), func() tea.Msg {
				ctx, cancel := timeout(a.bg(), 5*time.Second)
				defer cancel()
				if err := a.client.Reconnect(ctx); err != nil {
					return errMsg{"reconnect", err}
				}
				return nil
			})
		}},
		{name: "editor", title: "Write the prompt in $EDITOR", key: "ctrl+x e", category: "System", run: func(a *App, _ string) tea.Cmd { return a.openEditor() }},
		{name: "classic", title: "Switch to the classic OpenTUI interface", category: "System", run: func(a *App, _ string) tea.Cmd {
			return a.toClassic("")
		}},
		// Dialogs only the classic UI has: it opens on this session and runs the command there.
		{name: "connect", title: "Sign in to an AI provider (opens in the classic interface)", category: "System", run: func(a *App, _ string) tea.Cmd { return a.toClassic("connect") }},
		{name: "apps", title: "Connect apps: GitHub, Google, Notion, … (opens in the classic interface)", category: "System", run: func(a *App, _ string) tea.Cmd { return a.toClassic("apps") }},
		{name: "settings", title: "InfiniteOC settings (opens in the classic interface)", category: "System", run: func(a *App, _ string) tea.Cmd { return a.toClassic("settings") }},
		{name: "account", title: "Switch provider accounts (opens in the classic interface)", category: "System", run: func(a *App, _ string) tea.Cmd { return a.toClassic("account") }},
		{name: "exit", aliases: []string{"quit", "q"}, title: "Exit", key: "ctrl+d", category: "System", run: func(a *App, _ string) tea.Cmd {
			a.quitting = true
			return nil
		}},
	}
}

func (a *App) rename(title string) tea.Cmd {
	sid := a.sessionID
	if sid == "" {
		return a.showToast("info", "", "Start a session first", 2*time.Second)
	}
	if strings.TrimSpace(title) == "" {
		d, _ := a.store.Get(sid)
		cur := ""
		if d != nil {
			cur = d.info.Title
		}
		a.dialog = newInputDialog("Rename session", "Empty title asks the model for one", cur, func(v string) tea.Cmd {
			return a.rename(" " + v)
		})
		return nil
	}
	title = strings.TrimSpace(title)
	return func() tea.Msg {
		if err := a.client.Rename(a.bg(), sid, title); err != nil {
			return errMsg{"rename", err}
		}
		return nil
	}
}

func (a *App) toggleYolo() tea.Cmd {
	if a.yolo {
		a.yolo = false
		return a.showToast("info", "", "YOLO off · permission prompts are back", 2500*time.Millisecond)
	}
	a.dialog = newConfirmDialog("Turn on YOLO?",
		"Every permission request is approved once, automatically: file edits, writes and shell commands, including any already waiting. InfiniteOC safety gates still ask. Only for this window.",
		"Turn on", func() tea.Cmd {
			a.yolo = true
			return tea.Batch(a.autoApprove(), a.showToast("warning", "", "YOLO on", 2500*time.Millisecond))
		})
	return nil
}

var infiniCodePrevious = map[string]string{}

func (a *App) toggleInfiniCode() tea.Cmd {
	mm, ok := a.store.Model(a.model)
	if !ok || !mm.HasVariant("infinicode") {
		return a.showToast("warning", "", "This model has no InfiniCode level (is mods/infinicode enabled?)", 3*time.Second)
	}
	if a.model.Variant == "infinicode" {
		return a.setVariant(infiniCodePrevious[a.model.Key()])
	}
	infiniCodePrevious[a.model.Key()] = a.model.Variant
	return a.setVariant("infinicode")
}

// openPalette lists every command: local, InfiniteOC views and server commands.
func (a *App) openPalette() tea.Cmd {
	var items []PickItem
	for _, c := range localCommands {
		items = append(items, PickItem{ID: "local:" + c.name, Title: c.title, Detail: "/" + c.name, Key: c.key, Category: c.category, Value: c, Keywords: strings.Join(c.aliases, " ")})
	}
	for _, f := range a.store.features {
		items = append(items, PickItem{ID: "feature:" + f.ID, Title: f.Title, Detail: "/" + f.Slash, Category: "InfiniteOC", Value: f.ID, Keywords: f.Description})
	}
	classic := map[string]bool{}
	for _, f := range a.visibleClassicFeatures() {
		classic[f.Slash] = true
		items = append(items, PickItem{ID: "classic:" + f.Slash, Title: f.Title, Detail: "/" + f.Slash, Category: nonEmpty(f.Category, "Mods"), Value: f.Slash, Keywords: strings.Join(f.Aliases, " ")})
	}
	for _, c := range a.store.commands {
		if findLocal(c.Name) != nil || a.findFeature(c.Name) != nil || classic[c.Name] {
			continue
		}
		items = append(items, PickItem{ID: "server:" + c.Name, Title: "/" + c.Name, Detail: firstLine(c.Description), Category: "Commands", Value: c.Name})
	}
	p := NewPicker("Commands", items)
	p.Footer = "enter run · commands that take arguments fill the prompt"
	p.OnPick = func(it PickItem) tea.Cmd {
		switch {
		case strings.HasPrefix(it.ID, "local:"):
			c := it.Value.(*localCommand)
			if c.args != "" && c.name != "rename" {
				a.prompt.SetValue("/" + c.name + " ")
				return nil
			}
			return c.run(a, "")
		case strings.HasPrefix(it.ID, "feature:"):
			return a.runFeature(it.Value.(string), "", "")
		case strings.HasPrefix(it.ID, "classic:"):
			return a.toClassic(it.Value.(string))
		default:
			a.prompt.SetValue("/" + it.Value.(string) + " ")
			return a.refreshCompletionOff()
		}
	}
	a.dialog = &pickerDialog{p: p, width: 76}
	return nil
}

func (a *App) refreshCompletionOff() tea.Cmd {
	a.comp = nil
	return nil
}

// openThemes picks a palette.
func (a *App) openThemes() tea.Cmd {
	items := []PickItem{
		{ID: "infiniteoc", Title: "InfiniteOC", Detail: "violet and pink on deep purple"},
		{ID: "infiniteoc-light", Title: "InfiniteOC Light", Detail: "for light terminals"},
		{ID: "infinicode", Title: "InfiniCode", Detail: "the red InfiniCode palette"},
	}
	for i := range items {
		if items[i].ID == theme.Current.Name {
			items[i].Mark = "●"
		}
	}
	p := NewPicker("Theme", items)
	p.Grouped = false
	p.SelectID(theme.Current.Name)
	p.OnPick = func(it PickItem) tea.Cmd {
		a.uprefs.Theme = it.ID
		a.uprefs.save()
		a.applyVariantTheme()
		return nil
	}
	a.dialog = &pickerDialog{p: p, width: 60}
	return nil
}

func (a *App) withTimeout(d time.Duration, fn func(ctx context.Context) tea.Msg) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := timeout(a.bg(), d)
		defer cancel()
		return fn(ctx)
	}
}
