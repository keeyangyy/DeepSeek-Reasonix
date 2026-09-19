package event

// WorkspaceWatchState names the health of the host-side workspace watcher.
type WorkspaceWatchState string

const (
	WorkspaceWatchActive      WorkspaceWatchState = "active"
	WorkspaceWatchDegraded    WorkspaceWatchState = "degraded"
	WorkspaceWatchUnavailable WorkspaceWatchState = "unavailable"
)

type WorkspaceRevision struct {
	Content     uint64 `json:"content"`
	Tree        uint64 `json:"tree"`
	WorkingTree uint64 `json:"workingTree"`
	GitMeta     uint64 `json:"gitMeta"`
	Session     uint64 `json:"session"`
}

type WorkspacePathChange struct {
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"`
	Op      string `json:"op"`
}

type WorkspaceChangedPayload struct {
	Revisions  WorkspaceRevision
	Changes    []WorkspacePathChange
	AllPaths   bool
	Source     string
	WatchState WorkspaceWatchState
}
