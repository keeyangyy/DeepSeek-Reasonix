package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reasonix/internal/provider"
	"reasonix/internal/store"
	"slices"
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
		payload := map[string]any{"startedAt": strconv.FormatInt(time.Now().UnixMilli(), 10)}
		// 压缩开始时对话进行到第几轮。完成时用它写锚点，重启后卡片才能回到
		// 用户按下压缩的那一轮边界；「折叠覆盖到哪」是另一回事（默认会保留
		// 最近若干轮），拿它当锚点会让卡片在重启后往前跳一大段。
		if rec != nil && rec.AnchorUserMessages > 0 {
			payload["anchorUserMessages"] = rec.AnchorUserMessages
		}
		// 压缩开始时对话停在哪条消息。完成时转写进 record，重启后前端按这个 id
		// 找位置：找不到就说明那条消息还没加载，卡片不显示（而不是猜一个位置）。
		if rec != nil && rec.AnchorMessageID != "" {
			payload["anchorMessageId"] = rec.AnchorMessageID
		}
		b, _ := json.Marshal(payload)
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

// compactionMarkerAnchor reads the turn count snapshotted when the compaction
// started. Zero means the marker is gone or predates the snapshot.
func compactionMarkerAnchor(sessionPath string) int {
	if sessionPath == "" {
		return 0
	}
	b, err := os.ReadFile(filepath.Join(store.SessionCheckpointDir(sessionPath), "compacting.json"))
	if err != nil {
		return 0
	}
	var payload struct {
		AnchorUserMessages int `json:"anchorUserMessages"`
	}
	if json.Unmarshal(b, &payload) != nil {
		return 0
	}
	return payload.AnchorUserMessages
}

// compactionMarkerMessageID reads the ULID of the message the conversation had
// reached when the compaction started. Empty means no snapshot (older marker).
func compactionMarkerMessageID(sessionPath string) string {
	if sessionPath == "" {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(store.SessionCheckpointDir(sessionPath), "compacting.json"))
	if err != nil {
		return ""
	}
	var payload struct {
		AnchorMessageID string `json:"anchorMessageId"`
	}
	if json.Unmarshal(b, &payload) != nil {
		return ""
	}
	return payload.AnchorMessageID
}

// compactionAnchorMessageIDForRecord prefers the message id snapshotted when the
// compaction started: that is where the live card was inserted, and it stays
// valid no matter how many pages the frontend has loaded. Falling back to the
// current conversation tail keeps records written by older builds placeable.
func compactionAnchorMessageIDForRecord(canonical []provider.Message, sessionPath string) string {
	if id := compactionMarkerMessageID(sessionPath); id != "" {
		return id
	}
	return lastMessageID(canonical)
}

// lastMessageID returns the ULID of the newest message that still carries one.
// Messages without an ID are skipped: host-generated protocol rows can lack it,
// and anchoring on an empty ID would make the card unplaceable.
func lastMessageID(msgs []provider.Message) string {
	for i := range slices.Backward(msgs) {
		if msgs[i].ID != "" {
			return msgs[i].ID
		}
	}
	return ""
}

// compactionAnchorForRecord prefers the turn count snapshotted when the
// compaction started: that is the boundary the user pressed compact at, and
// where the live card was inserted. The folded prefix is only a fallback for
// markers written before that snapshot existed.
func compactionAnchorForRecord(canonical []provider.Message, covered int, sessionPath string) int {
	if anchor := compactionMarkerAnchor(sessionPath); anchor > 0 {
		return anchor
	}
	return countCompactionAnchorUsers(canonical, covered)
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
	// AnchorMessageID 是压缩开始时对话最后一条消息的 ULID：卡片插在它之后。
	// 前端按 id 查找，找不到（那条消息还没加载）就不显示——这比数「第几轮」可靠，
	// 既不受注入消息类型影响，也不会随分页加载多少而变位置。
	AnchorMessageID string `json:"anchorMessageId,omitempty"`
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
