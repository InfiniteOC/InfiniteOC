package main

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

func TestWatchParent(t *testing.T) {
	// Without the variable (run directly) nothing is watched.
	t.Setenv("INFINITUI_PARENT_PID", "")
	ctx, cancel := context.WithCancelCause(context.Background())
	watchParent(cancel)
	select {
	case <-ctx.Done():
		t.Fatal("cancelled without a parent to watch")
	case <-time.After(300 * time.Millisecond):
	}

	// The real parent is alive: no cancel.
	t.Setenv("INFINITUI_PARENT_PID", strconv.Itoa(os.Getppid()))
	ctx, cancel = context.WithCancelCause(context.Background())
	watchParent(cancel)
	if os.Getenv("INFINITUI_PARENT_PID") != "" {
		t.Fatal("INFINITUI_PARENT_PID must not reach the agent's tools")
	}
	select {
	case <-ctx.Done():
		t.Fatal("cancelled while the parent is alive")
	case <-time.After(300 * time.Millisecond):
	}

	// A launcher that is already gone (here: a finished child) is noticed at once.
	gone := exec.Command(os.Args[0], "-test.run=^$")
	if err := gone.Run(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("INFINITUI_PARENT_PID", strconv.Itoa(gone.Process.Pid))
	ctx, cancel = context.WithCancelCause(context.Background())
	watchParent(cancel)
	select {
	case <-ctx.Done():
		if context.Cause(ctx) != errParentGone {
			t.Fatalf("cause %v", context.Cause(ctx))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a parent that exited was not noticed")
	}
}
