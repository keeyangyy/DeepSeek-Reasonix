package main

import (
	"reasonix/internal/checkpoint"
	"reasonix/internal/store"
	"strings"
)

// inheritForkCheckpointBoundaries copies conversation-only checkpoint
// boundaries (turns <= forkTurn) from the source session into the fork's
// session checkpoint dir, before the new tab's controller rebinds. A fork
// always lands on a fresh session file whose checkpoint dir is empty, so
// without this every turn action in the fork shows "这条消息没有可恢复点" and
// "压缩此处之前/之后" is disabled. File snapshots are intentionally NOT
// copied: the fork's workspace state differs from the source's.
func inheritForkCheckpointBoundaries(sourcePath, targetPath string, forkTurn int) error {
	if strings.TrimSpace(sourcePath) == "" || strings.TrimSpace(targetPath) == "" {
		return nil
	}
	src := checkpoint.New(store.SessionCheckpointDir(sourcePath), "")
	dst := checkpoint.New(store.SessionCheckpointDir(targetPath), "")
	boundaries := src.ExportForkBoundaries(forkTurn)
	if len(boundaries) == 0 {
		return nil
	}
	return dst.ImportForkBoundaries(boundaries)
}
