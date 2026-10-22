//go:build windows

package ui

import (
	"os/exec"
	"syscall"
)

// hideConsole runs a helper (the clipboard reader) without a console, so it cannot change the input mode of ours.
func hideConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
