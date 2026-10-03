package config

import (
	"strings"
	"testing"
)

// 同一份用户配置会被别的线和手工编辑用不同写法写出来：内联表、多行字符串、
// 不同缩进。增量保存只需保证两件事：改动的键真的生效，其余内容（尤其本线
// 根本不认识的节）不丢 —— 写法本身允许被规范化。
func TestSavingKeepsInlineTableAndForeignTable(t *testing.T) {
	const body = `config_version = 12

ui = { theme = "dark" }

[checkpoints]
retain_turns = 7
`
	path := seedUserConfig(t, body)
	cfg := LoadForEdit(path)
	cfg.UI.Theme = "light"
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	got := readUserConfig(t, path)
	if !strings.Contains(got, "[checkpoints]\nretain_turns = 7") {
		t.Errorf("内联表写法下丢了别的线写的节:\n%s", got)
	}
	if reloaded := LoadForEdit(path); reloaded.UI.Theme != "light" {
		t.Errorf("内联表写法下主题没生效，得到 %q", reloaded.UI.Theme)
	}
}

func TestSavingKeepsMultilineValueBytes(t *testing.T) {
	const multi = "system_prompt = \"\"\"\nfirst line\nsecond line\n\"\"\"\n"
	body := "config_version = 12\n\n[agent]\n" + multi + "\n[checkpoints]\nretain_turns = 7\n"
	path := seedUserConfig(t, body)

	cfg := LoadForEdit(path)
	cfg.UI.Theme = "light"
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	got := readUserConfig(t, path)
	if !strings.Contains(got, strings.TrimRight(multi, "\n")) {
		t.Errorf("多行值被改写或丢失:\n%s", got)
	}
	if !strings.Contains(got, "[checkpoints]\nretain_turns = 7") {
		t.Errorf("多行值写法下丢了别的线写的节:\n%s", got)
	}
}