package cli

import "testing"

// isWSLFor decides whether the clipboard write must go through PowerShell. It
// takes goos and the environment reader as parameters so the platform matrix is
// testable without spawning anything.
func TestIsWSLFor(t *testing.T) {
	env := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}
	cases := []struct {
		name string
		goos string
		env  map[string]string
		want bool
	}{
		{"linux with distro name", "linux", map[string]string{"WSL_DISTRO_NAME": "Ubuntu"}, true},
		{"linux with interop only", "linux", map[string]string{"WSL_INTEROP": "/run/WSL/8_interop"}, true},
		{"linux with both", "linux", map[string]string{"WSL_DISTRO_NAME": "Ubuntu", "WSL_INTEROP": "/run/WSL/8_interop"}, true},
		{"native linux", "linux", map[string]string{}, false},
		{"windows never routes through WSL", "windows", map[string]string{"WSL_DISTRO_NAME": "Ubuntu"}, false},
		{"darwin never routes through WSL", "darwin", map[string]string{"WSL_DISTRO_NAME": "Ubuntu"}, false},
		{"linux ignores unrelated vars", "linux", map[string]string{"DISPLAY": ":0"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isWSLFor(tc.goos, env(tc.env)); got != tc.want {
				t.Fatalf("isWSLFor(%q, %v) = %v, want %v", tc.goos, tc.env, got, tc.want)
			}
		})
	}
}

// The PowerShell script reads stdin as UTF-8 explicitly. If this ever regresses
// to clip.exe the Chinese text turns into mojibake on a CP936 host, so pin the
// two properties that prevent it.
func TestWSLClipboardScriptReadsUTF8(t *testing.T) {
	if !contains(wslClipboardWriteScript, "UTF8Encoding") {
		t.Fatal("clipboard script must decode stdin as UTF-8, not the OEM code page")
	}
	if !contains(wslClipboardWriteScript, "Set-Clipboard") {
		t.Fatal("clipboard script must write through Set-Clipboard")
	}
	if contains(wslClipboardWriteScript, "clip.exe") {
		t.Fatal("clipboard script must not fall back to clip.exe, which re-decodes UTF-8 as the OEM code page")
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
