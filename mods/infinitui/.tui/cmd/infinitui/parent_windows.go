//go:build windows

package main

import (
	"errors"
	"os"
	"syscall"
)

// OpenProcess fails with ERROR_INVALID_PARAMETER when no process has the pid.
const errorInvalidParameter = syscall.Errno(87)

// waitParent returns true once process pid has exited. A pid with no process (already gone) counts as exited;
// a process that cannot be opened or waited on is not watched.
func waitParent(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return errors.Is(err, errorInvalidParameter)
	}
	_, err = p.Wait()
	return err == nil
}
