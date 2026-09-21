package agent

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"reasonix/internal/event"
	"reasonix/internal/jobs"
	"reasonix/internal/tool"
)

// TestBuildTaskSpecWriterWithoutPathsHasNoWholeWorkspaceClaim 守护"无
// write_paths 的 writer 不再被推断为 whole-workspace"：推断式 whole-workspace
// 会让所有此类子代理在 SubagentScheduler 中全局互斥（串行执行），并让主 agent
// 的写工具与后台子代理互相锁死（"write path is claimed by a running background
// subagent"）。无声明 writer 之间应并行，仅受 max_parallel_writers 上限约束。
func TestBuildTaskSpecWriterWithoutPathsHasNoWholeWorkspaceClaim(t *testing.T) {
	task := NewTaskTool(&mockProvider{name: "sub"}, nil, tool.NewRegistry(), 20, 0, 0, 0, 0, 0, 0, 0.0, "", "sys", nil, 0, "", "", nil).
		WithScheduler(NewSubagentScheduler(6, 3))
	task.workspaceRoot = t.TempDir()

	spec, err := task.buildTaskSpec(context.Background(), "prompt", "label", "", nil, nil, 0, "", "", "", "", false, false)
	if err != nil {
		t.Fatalf("buildTaskSpec: %v", err)
	}
	if spec.Grant.ReadOnly {
		t.Fatal("writer task resolved as read-only")
	}
	if spec.Grant.WritePaths.WholeWorkspace {
		t.Fatalf("writer without write_paths must not claim the whole workspace; got %+v", spec.Grant.WritePaths)
	}
}

// TestBackgroundTaskWithoutWritePathsRunsConcurrently 守护后台 task 并行：
// 两个无 write_paths 的后台 writer 应全部立即开始（受 maxTotal/maxParallelWriters
// 限制），而不是因 whole-workspace 互斥而串行排队。
func TestBackgroundTaskWithoutWritePathsRunsConcurrently(t *testing.T) {
	root := t.TempDir()
	prov := &fleetHoldProvider{started: make(chan struct{}, 2), release: make(chan struct{})}
	defer close(prov.release)
	task := NewTaskTool(prov, nil, tool.NewRegistry(), 20, 0, 0, 0, 0, 0, 0, 0.0, "", "sys", nil, 0, "", "", nil).
		WithTranscripts(mustSubagentStore(t), root, "base", "high").
		WithScheduler(NewSubagentScheduler(2, 2))
	manager := jobs.NewManager(event.Discard)
	defer manager.Close()
	ctx := withCallContext(context.Background(), "task-call", event.Discard, nil, false)
	ctx = jobs.WithManager(ctx, manager)
	ctx = jobs.WithSession(ctx, "parent-session")

	for i := 0; i < 2; i++ {
		args, _ := json.Marshal(map[string]any{
			"prompt":            "prompt",
			"run_in_background": true,
		})
		if _, err := task.Execute(ctx, args); err != nil {
			t.Fatalf("task %d: %v", i, err)
		}
	}
	// 修复前：第二个 task 被 whole-workspace 互斥排队，不会启动。
	for i := 0; i < 2; i++ {
		select {
		case <-prov.started:
		case <-time.After(3 * time.Second):
			t.Fatalf("background task %d did not start concurrently (serialized by whole-workspace claim)", i)
		}
	}
}

// TestFleetWritersWithoutWritePathsRunConcurrently 守护 fleet 并行：无
// write_paths 的 writer 项应全部并行启动。
func TestFleetWritersWithoutWritePathsRunConcurrently(t *testing.T) {
	root := t.TempDir()
	prov := &fleetHoldProvider{started: make(chan struct{}, 2), release: make(chan struct{})}
	defer close(prov.release)
	task := NewTaskTool(prov, nil, tool.NewRegistry(), 20, 0, 0, 0, 0, 0, 0, 0.0, "", "sys", nil, 0, "", "", nil).
		WithTranscripts(mustSubagentStore(t), root, "base", "high").
		WithScheduler(NewSubagentScheduler(2, 2))
	fleet := NewFleetTool(task)
	manager := jobs.NewManager(event.Discard)
	defer manager.Close()
	ctx := withCallContext(context.Background(), "fleet-call", event.Discard, nil, false)
	ctx = jobs.WithManager(ctx, manager)
	ctx = jobs.WithSession(ctx, "parent-session")
	args := json.RawMessage(`{
		"run_in_background":true,
		"tasks":[
			{"prompt":"first"},
			{"prompt":"second"}
		]
	}`)
	if _, err := fleet.Execute(ctx, args); err != nil {
		t.Fatalf("fleet: %v", err)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-prov.started:
		case <-time.After(3 * time.Second):
			t.Fatalf("fleet item %d did not start concurrently (serialized by whole-workspace claim)", i)
		}
	}
}
