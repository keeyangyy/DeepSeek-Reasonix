package agent

import (
	"errors"
	"fmt"
	"time"

	"reasonix/internal/provider"
)

type summaryProjectionCommit struct {
	canonical, fold, projected                       []provider.Message
	result                                           foldSummary
	transcriptVersion, projectionVersion, generation uint64
	activeTurn                                       int64
	trigger, summary, inputHash, outputHash          string
	sourceTokens, projectionTokens                   int
	// covered is the canonical length the frozen projection body represents;
	// messages past it splice live from the transcript.
	covered int
	// 压缩开始时捕获：途中切走会让 a.sess.* 指向新会话，用实时值校验和
	// 落盘会把已经算好的摘要整份丢掉，写错会话。
	conversation *Session
	sessionPath  string
}

// commitSummaryProjection CAS-installs a checkpoint under compactionMu:
// transcript version/hash, projection version, and generation must still match.
// The maintenance event is emitted only after the lock is released so a sink
// that re-enters ContextMaintenanceSnapshot cannot deadlock.
func (a *Agent) commitSummaryProjection(commit summaryProjectionCommit) (CompactionState, error) {
	state := a.summaryProjectionState(commit)

	// 校验与落盘都以「压缩开始时捕获的会话」为准。压缩途中切走会话会让
	// a.sess.conversation / a.sess.path 指向新会话，拿实时值比对会把已经
	// 算好的摘要整份判成过期丢掉——用户等的那次压缩就白跑了。
	conv := commit.conversation
	if conv == nil {
		conv = a.sess.conversation
	}
	targetPath := commit.sessionPath
	if targetPath == "" {
		targetPath = a.sess.path
	}

	a.sess.compactionMu.Lock()
	current, currentVersion := conv.snapshotMessagesVersion()
	if currentVersion != commit.transcriptVersion ||
		len(current) != len(commit.canonical) ||
		coveredPrefixHash(current, len(current)) != coveredPrefixHash(commit.canonical, len(commit.canonical)) {
		a.sess.compactionMu.Unlock()
		return CompactionState{}, errCompressStaleContext
	}
	// 目标仍是当前会话时才比对内存里的投影版本/generation；切走后内存状态
	// 已属于别的会话，比对无意义，也不该被这次结果覆盖。
	stillCurrent := targetPath == "" || targetPath == a.sess.path
	if stillCurrent && (a.sess.compactionState.Projection.ProjectionVersion != commit.projectionVersion ||
		a.sess.compactionState.Generation != commit.generation) {
		a.sess.compactionMu.Unlock()
		return CompactionState{}, errCompressStaleContext
	}
	if stillCurrent {
		prev := a.sess.compactionState
		a.sess.compactionState = state
		if err := a.persistCompactionStateLocked(); err != nil {
			a.sess.compactionState = prev
			a.sess.compactionMu.Unlock()
			if errors.Is(err, errCompressStaleContext) {
				return CompactionState{}, err
			}
			return CompactionState{}, fmt.Errorf("persist projection: %w", err)
		}
		a.sess.checkpointState = "applied"
		if commit.activeTurn != 0 && commit.trigger != CompactionTriggerManual {
			a.sess.compaction.lastTurn.Store(commit.activeTurn)
		}
	} else if err := SaveCompactionState(targetPath, state); err != nil {
		// 切走了：只把结果写回压缩开始时那个会话，不动当前会话的内存状态。
		a.sess.compactionMu.Unlock()
		if errors.Is(err, errCompressStaleContext) {
			return CompactionState{}, err
		}
		return CompactionState{}, fmt.Errorf("persist projection: %w", err)
	}
	receipt := state.LastReceipt
	a.sess.compactionMu.Unlock()
	a.emitContextMaintenance(receipt)
	return state, nil
}

func (a *Agent) summaryProjectionState(commit summaryProjectionCommit) CompactionState {
	projectionVersion := commit.projectionVersion + 1
	now := time.Now().UTC()
	summaryHash := summaryContentHash(commit.summary)
	coveredHash := coveredPrefixHash(commit.canonical, commit.covered)
	receipt := &ContextMaintenanceReceipt{
		OperationID: fmt.Sprintf("summary-%d-%s", projectionVersion, commit.outputHash), Status: "applied",
		Action: "summary", Trigger: commit.trigger, SourceProjection: commit.projectionVersion,
		ProjectionVersion: projectionVersion, CoveredCount: commit.covered, CoveredPrefixHash: coveredHash,
		InputHash: commit.inputHash, OutputHash: commit.outputHash, InputTokens: commit.sourceTokens,
		ResultTokens: commit.projectionTokens, SavedTokens: max(0, commit.sourceTokens-commit.projectionTokens),
		SummaryHash: summaryHash, CacheBreak: true, CreatedAt: now,
	}
	// LastReceipt is authoritative; do not mirror last_trigger/last_mode/token
	// counters or top-level blocked_* fields (stripped again on save).
	// A successful commit opens a new generation and a fresh recall budget.
	return CompactionState{
		SchemaVersion: compactionStateSchemaCurrent, TranscriptVersion: commit.transcriptVersion,
		Generation: commit.generation + 1, PromptCacheKey: a.currentPromptCacheKey(),
		Recall: RecallLedger{Generation: commit.generation + 1},
		Projection: ContextProjection{
			Messages: commit.projected, TranscriptVersion: commit.transcriptVersion,
			ProjectionVersion: projectionVersion, CoveredCount: commit.covered, CoveredPrefixHash: coveredHash,
			PinnedContextHash: pinnedContextCoverageHash(commit.canonical, commit.covered),
			SummaryHash:       summaryHash, SourceTokens: commit.sourceTokens, ProjectionTokens: commit.projectionTokens,
			ViewInputHash: commit.inputHash, ViewOutputHash: commit.outputHash, CreatedAt: now,
		},
		LastReceipt: receipt, UpdatedAt: now,
	}
}
