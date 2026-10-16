package main

import (
	"reasonix/internal/agent"
	"strings"
)

// sidecarAutoTitleSynced reports whether the session sidecar already carries a
// non-placeholder topic title. 缺失视为未同步（补写会创建 sidecar，安全）；读
// 失败视为已同步（避免空转，常规写路径自有日志）。
func sidecarAutoTitleSynced(sessionPath string) bool {
	meta, ok, err := agent.LoadBranchMeta(sessionPath)
	if err != nil {
		return true
	}
	if !ok {
		return false
	}
	title := strings.TrimSpace(meta.TopicTitle)
	return title != "" && !isDefaultTopicTitle(title)
}

// topicTitleAllowsAutoRetitle reports whether a non-auto topic-title source is
// a dirty record worth self-healing: a topic can get stuck as title=默认 +
// source=manual with no real manual name behind it (no CustomTitle, no
// .titles.json entry — live user data: topic_20260919-093225), which then
// blocks auto-titling forever. Two guards keep a deliberate user choice safe:
// a non-default title is a real rename, and an auto-title-meta entry means the
// topic was auto-titled once before (a blank rename reset it on purpose), so
// neither may be re-titled here.
func topicTitleAllowsAutoRetitle(workspaceRoot, topicID, sessionPath string) bool {
	if !isDefaultTopicTitle(strings.TrimSpace(loadTopicTitle(workspaceRoot, topicID))) {
		return false
	}
	if _, ok := loadTopicAutoTitleMeta(workspaceRoot)[topicID]; ok {
		return false
	}
	return !sessionHasManualDisplayTitle(sessionPath)
}

// titleRootForRename resolves the workspace root of a topic for meta deletion
// best-effort; an empty root only misses the meta cleanup on project topics
// whose root cannot be found, which the next auto-title pass self-heals.
func titleRootForRename(f desktopProjectFile, topicID string) string {
	for _, p := range f.Projects {
		if _, ok := loadTopicTitles(p.Root)[topicID]; ok {
			return p.Root
		}
	}
	return ""
}
