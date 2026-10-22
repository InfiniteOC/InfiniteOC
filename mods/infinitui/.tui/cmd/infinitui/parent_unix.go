//go:build !windows

package main

import (
	"os"
	"time"
)

// waitParent returns true once pid is no longer this process's parent: an orphan is re-parented to init or a
// subreaper. A parent that is already gone is noticed on the first check.
func waitParent(pid int) bool {
	for os.Getppid() == pid {
		time.Sleep(100 * time.Millisecond)
	}
	return true
}
