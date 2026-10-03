package config

import (
	"strings"
	"testing"
)

// 复现（desktop 的 TestSetSubagentProfileModelSweepsAliasOnSet 在 CI 上暴露）：
// 在同一个节里同时「删一个键 + 加一个键」（过期别名 → 规范键）时，增量改写会写出
// 重复的节头，文件不再是合法 TOML —— 之后任何 load 都会失败（"Key ... has already
// been defined"），调用方只能退回默认值，看起来像设置根本没保存。
func TestSavingSectionWithKeySwapKeepsValidTOML(t *testing.T) {
	const body = `default_model = "deepseek/deepseek-v4-flash"

[[providers]]
name = "deepseek"
kind = "openai"
base_url = "https://api.deepseek.com"
models = ["deepseek-v4-flash", "deepseek-v4-pro"]
default = "deepseek-v4-flash"
api_key_env = "DEEPSEEK_API_KEY"

[agent.subagent_models]
security_review = "deepseek/deepseek-v4-flash"
`
	path := seedUserConfig(t, body)
	cfg := LoadForEdit(path)
	if cfg.Agent.SubagentModels == nil {
		cfg.Agent.SubagentModels = map[string]string{}
	}
	delete(cfg.Agent.SubagentModels, "security_review")
	cfg.Agent.SubagentModels["security-review"] = "deepseek/deepseek-v4-pro"
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	got := readUserConfig(t, path)
	// 规范写法是内联表，所以不能靠节头计数判断；这里守两件要紧的事：
	// 过期别名不再出现，新值只出现一次（重复定义会让文件不是合法 TOML）。
	if strings.Contains(got, "security_review") {
		t.Fatalf("过期别名仍在文件里:\n%s", got)
	}
	if n := strings.Count(got, "deepseek/deepseek-v4-pro"); n != 1 {
		t.Fatalf("新值出现 %d 次（应为 1，重复定义=非法 TOML）:\n%s", n, got)
	}
	// 能重新解析才算真的保存成功。
	reloaded := LoadForEdit(path)
	if reloaded.Agent.SubagentModels["security-review"] != "deepseek/deepseek-v4-pro" {
		t.Fatalf("规范键 = %q，应为新值；文件内容:\n%s", reloaded.Agent.SubagentModels["security-review"], got)
	}
	if _, ok := reloaded.Agent.SubagentModels["security_review"]; ok {
		t.Fatalf("过期别名没被清掉；文件内容:\n%s", got)
	}
	if !strings.Contains(got, "[[providers]]") || !strings.Contains(got, "api.deepseek.com") {
		t.Fatalf("[[providers]] 数组表被破坏:\n%s", got)
	}
}
