package main

import (
	"context"
	"errors"
	"os"
	"strconv"
)

// errParentGone ends the program when the process that started InfiniTUI is gone (killed, or crashed):
// the server it leased went with it, and the terminal is the shell's again.
var errParentGone = errors.New("the process that started InfiniTUI has exited")

// watchParent cancels ctx with errParentGone once the launcher's process (INFINITUI_PARENT_PID) has exited.
// Run directly, without that variable, nothing is watched.
func watchParent(cancel context.CancelCauseFunc) {
	pid, err := strconv.Atoi(os.Getenv("INFINITUI_PARENT_PID"))
	os.Unsetenv("INFINITUI_PARENT_PID")
	if err != nil || pid <= 0 {
		return
	}
	go func() {
		if waitParent(pid) {
			cancel(errParentGone)
		}
	}()
}
