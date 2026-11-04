package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 这三个用例守的是跨线共享的配置文件：别的线（2.x / Studio）写的键，本线
// 不认识，也不能在保存时被顺手删掉。增量保存要么保留原字节，要么明确失败，
// 不能静默丢。

func TestSavingServeKeepsForeignKey(t *testing.T) {
	const body = `config_version = 9

[serve]
auth_mode = "token"
remember_paired_devices = true
share_port = 41234
`
	path := seedUserConfig(t, body)
	cfg := LoadForEdit(path)
	cfg.Serve.AuthMode = "password"
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	got := readUserConfig(t, path)
	for _, want := range []string{"remember_paired_devices", "share_port", `auth_mode = "password"`} {
		if !strings.Contains(got, want) {
			t.Errorf("保存后丢了 %q:\n%s", want, got)
		}
	}
	if backups, _ := filepath.Glob(path + ".rewrite-*"); len(backups) != 0 {
		t.Errorf("保存退化成了整份重写: %v", backups)
	}
}

func TestSavingBotConnectionKeepsForeignKey(t *testing.T) {
	const body = `config_version = 9

[[bot.connections]]
id = "c1"
provider = "qq"
enabled = true
studio_extra = "keep"
`
	path := seedUserConfig(t, body)
	cfg := LoadForEdit(path)
	if len(cfg.Bot.Connections) != 1 {
		t.Fatalf("fixture did not load: %+v", cfg.Bot.Connections)
	}
	cfg.Bot.Connections[0].Model = "deepseek-pro"
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	got := readUserConfig(t, path)
	if !strings.Contains(got, "studio_extra") {
		t.Errorf("保存后丢了元素内未知字段:\n%s", got)
	}
	if !strings.Contains(got, `model = "deepseek-pro"`) {
		t.Errorf("保存没写回改动:\n%s", got)
	}
}

func TestProjectSaveKeepsSameTableForeignKey(t *testing.T) {
	home := t.TempDir()
	t.Setenv("REASONIX_HOME", home)
	t.Setenv("REASONIX_CREDENTIALS_STORE", "file")
	project := t.TempDir()
	path := filepath.Join(project, "reasonix.toml")
	const body = `config_version = 9

[agent]
temperature = 0.5
turn_narration = "detailed"

[studio_only]
x = 1
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	cfg.Agent.Temperature = 0.9
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	got := readUserConfig(t, path)
	for _, want := range []string{"turn_narration", "[studio_only]", "temperature"} {
		if !strings.Contains(got, want) {
			t.Errorf("项目配置保存后丢了 %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "temperature = 0.5") {
		t.Errorf("项目配置没有写回 temperature:\n%s", got)
	}
}

func TestProjectSaveRestoresDefaultWithoutDroppingForeignKeys(t *testing.T) {
	home := t.TempDir()
	t.Setenv("REASONIX_HOME", home)
	t.Setenv("REASONIX_CREDENTIALS_STORE", "file")
	project := t.TempDir()
	path := filepath.Join(project, "reasonix.toml")
	const body = `config_version = 9

[agent]
temperature = 0.5
turn_narration = "detailed"
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadForEditReadOnlyStrict(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	cfg.Agent.Temperature = Default().Agent.Temperature
	if err := cfg.SaveTo(path); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	got := readUserConfig(t, path)
	if !strings.Contains(got, "turn_narration") {
		t.Errorf("恢复默认时误删了同节未知键:\n%s", got)
	}
	if _, err := LoadForEditReadOnlyStrict(path); err != nil {
		t.Errorf("恢复默认后的项目配置无法加载: %v\n%s", err, got)
	}
}
