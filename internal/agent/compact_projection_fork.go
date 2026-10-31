package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reasonix/internal/provider"
	"reasonix/internal/store"
	"strconv"
	"strings"
	"time"
)

// writeCompactionSidecar manages the session compaction sidecar
// (<session>.ckpt/): a "compacting.json" in-progress marker and the finished
// "latest-compaction.json" record. It lives in the agent so a compaction that
// finishes after its tab was released (switch-away mid-run) still persists —
// the controller's own sessionPath and executor can be cleared by then.
func writeCompactionSidecar(sessionPath, kind string, rec *CompactionRecord) {
	if sessionPath == "" {
		return
	}
	dir := store.SessionCheckpointDir(sessionPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	switch kind {
	case "marker":
		b, _ := json.Marshal(map[string]string{"startedAt": strconv.FormatInt(time.Now().UnixMilli(), 10)})
		_ = os.WriteFile(filepath.Join(dir, "compacting.json"), b, 0o644)
	case "record":
		if rec == nil {
			return
		}
		b, err := json.Marshal(rec)
		if err != nil {
			return
		}
		_ = os.WriteFile(filepath.Join(dir, "latest-compaction.json"), b, 0o644)
		_ = os.Remove(filepath.Join(dir, "compacting.json"))
	case "clear":
		_ = os.Remove(filepath.Join(dir, "compacting.json"))
	}
}

// CompactionRecord is the persisted summary of the most recent compaction.
// It lives in the sidecar so a session re-opened after its tab was released
// (switch-away mid-compact) can still render the compression result.
type CompactionRecord struct {
	Trigger  string `json:"trigger,omitempty"`
	Messages int    `json:"messages"`
	Summary  string `json:"summary"`
	// AnchorUserMessages 是压缩发生时对话里已有的真实用户消息数（“压缩发生
	// 在第几轮之后”）：卡片落在这一轮边界，也就是用户触发压缩时所处的位置。
	// 必须落在轮次边界：插在一轮中间会被折进折叠体。0 表示旧记录没有位置。
	AnchorUserMessages int `json:"anchorUserMessages,omitempty"`
	// AfterMessageID 是压缩分界处最后一条消息的 ULID。前端据此把卡片精确插在
	// 它之后：ID 不受分页窗口、rewind、轮次计数影响。空串表示旧记录无位置。
	AfterMessageID string `json:"afterMessageId,omitempty"`
}

// countCompactionAnchorUsers 数 covered 前缀里有多少条真实用户消息，作为
// 压缩卡片的轮次锚点。滚动摘要（上一轮折叠的产物）不算——它不是一轮对话的
// 起点，算进去会让锚点偏移。
func countCompactionAnchorUsers(msgs []provider.Message, covered int) int {
	if covered > len(msgs) {
		covered = len(msgs)
	}
	if covered <= 0 {
		return 0
	}
	n := 0
	for _, m := range msgs[:covered] {
		if m.Role != provider.RoleUser || isCompactionSummary(m) || isHostOnlyUserMessage(m.Content) {
			continue
		}
		// A mid-turn steer renders as a guidance notice, not a turn boundary, so
		// counting it would push the anchor past the last visible turn and drop
		// the card at the end of the transcript.
		if _, steered := SteerText(m.Content); steered {
			continue
		}
		n++
	}
	return n
}

// isHostOnlyUserMessage reports whether a user record carries nothing the
// transcript renders: the host session-context snapshot, or a message made up
// entirely of transient runtime blocks. The history projection drops these, so
// counting them here would make the compaction anchor one turn too large and
// push the card past the end of the loaded window.
func isHostOnlyUserMessage(content string) bool {
	trimmed := strings.TrimSpace(content)
	if strings.HasPrefix(trimmed, "<session-context") {
		return true
	}
	return strings.TrimSpace(StripTransientUserBlocks(trimmed)) == ""
}

// setLastCompaction records the receipt (atomic store) for sidecar persistence.
func (a *Agent) setLastCompaction(rec *CompactionRecord) {
	a.lastCompaction.Store(rec)
}

// LastCompaction returns the most recent compaction record, if any.
func (a *Agent) LastCompaction() *CompactionRecord {
	return a.lastCompaction.Load()
}

// lastCompactedMessageID 返回被压缩前缀最后一条消息的 ID。
//
// 前端把压缩卡片插在它之后：消息 ID 是 ULID，不受分页窗口、rewind、轮次
// 计数影响，所以位置精确且跨重启稳定。前缀为空时返回空串，表示没有位置。
func lastCompactedMessageID(msgs []provider.Message, covered int) string {
	if covered <= 0 || len(msgs) == 0 {
		return ""
	}
	if covered > len(msgs) {
		covered = len(msgs)
	}
	return msgs[covered-1].ID
}
