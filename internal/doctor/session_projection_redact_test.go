package doctor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"reasonix/internal/store"
)

// 投影 sidecar（<id>.context.json）里的摘要由历史生成，因此同样可能含密钥；
// 它是派生缓存而非原始字节，masking 无法证明干净 —— 脱敏必须把它删掉。
// 钉住的上下文（<id>.pinned-context.json）是用户数据，只 mask、不删。
func TestRedactSessionsRemovesProjectionSidecar(t *testing.T) {
	dir := t.TempDir()
	const secret = "sk-real-secret-value-123456"
	sessionPath := filepath.Join(dir, "abc.jsonl")
	if err := os.WriteFile(sessionPath, []byte(`{"role":"user","content":"clean"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctxPath := store.SessionContext(sessionPath)
	projection := `{"messages":[{"role":"user","content":"DEEPSEEK_API_KEY=` + secret + `"}],"covered_prefix_hash":"x"}`
	if err := os.WriteFile(ctxPath, []byte(projection), 0o644); err != nil {
		t.Fatal(err)
	}
	pinnedPath := store.SessionPinnedContext(sessionPath)
	if err := os.WriteFile(pinnedPath, []byte(`{"workspace":"DEEPSEEK_API_KEY=`+secret+`"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	// dry run 只报告、不动文件。
	res := RedactSessions(RedactSessionsOptions{Dirs: []string{dir}, DryRun: true})
	if len(res.Errors) > 0 {
		t.Fatalf("dry-run errors = %v", res.Errors)
	}
	if res.FilesChanged == 0 {
		t.Fatal("dry run 没有把投影 sidecar 算进候选")
	}
	if _, err := os.Stat(ctxPath); err != nil {
		t.Fatalf("dry run 不该删除投影 sidecar: %v", err)
	}

	res = RedactSessions(RedactSessionsOptions{Dirs: []string{dir}})
	if len(res.Errors) > 0 {
		t.Fatalf("RedactSessions errors = %v", res.Errors)
	}
	if _, err := os.Stat(ctxPath); !os.IsNotExist(err) {
		data, _ := os.ReadFile(ctxPath)
		t.Fatalf("投影 sidecar 逃过了脱敏（stat err=%v）:\n%s", err, data)
	}
	remaining, err := os.ReadFile(pinnedPath)
	if err != nil {
		t.Fatalf("钉住的上下文不该被删除: %v", err)
	}
	if strings.Contains(string(remaining), secret) {
		t.Errorf("钉住的上下文里密钥残留:\n%s", remaining)
	}
}
