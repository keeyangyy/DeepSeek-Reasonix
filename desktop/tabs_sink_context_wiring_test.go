package main

import (
	"context"
	"testing"
)

// 后台会话跑完后前端收不到 turn_done，提示音就哑了。事件出口是
// tabEventSink.emitRuntimeEvent，它在 ctx 为空时静默丢弃，所以任何创建
// sink 的路径都必须立刻装上 App 的 ctx——不能指望 subsequent 的
// setContext 会补上（controller 构建失败/异步未完成时就永远补不到）。
func TestOpenTransientBlankRuntimeSinkCarriesContext(t *testing.T) {
	isolateDesktopUserDirs(t)
	app := NewApp()
	app.ctx = context.Background()
	root := globalTabWorkspaceRoot()

	if err := app.openTransientBlankRuntime("global", root); err != nil {
		t.Fatalf("open transient blank runtime: %v", err)
	}

	tab := app.tabs[app.activeTabID]
	if tab == nil {
		t.Fatal("no active tab after opening a blank runtime")
	}
	if tab.sink == nil {
		t.Fatal("blank runtime tab has no event sink")
	}
	if tab.sink.context() == nil {
		t.Fatal("新会话的 sink 没有 ctx：后台事件会被 emitRuntimeEvent 静默丢弃（切走后完成不响铃）")
	}
}

// 同一约束适用于会话重绑候选：它的 sink 会直接接管 tab，遗漏 ctx 会让
// 重绑后的会话在后台静默。
func TestSessionRebindCandidateSinkCarriesContext(t *testing.T) {
	app, tab, _, targetPath, _, loadedSession := newAtomicRebindTestApp(t)
	app.mu.RLock()
	source := snapshotTabRuntimeLocked(tab)
	app.mu.RUnlock()
	profile := loadTabSessionProfile(targetPath)

	candidate, err := app.buildSessionRebindCandidate(tab, source, targetPath, loadedSession, profile, false)
	if err != nil {
		t.Fatalf("build rebind candidate: %v", err)
	}
	if candidate.sink == nil {
		t.Fatal("rebind candidate has no sink")
	}
	if candidate.sink.context() == nil {
		t.Fatal("重绑候选的 sink 没有 ctx：重绑后的会话在后台静默")
	}
}
