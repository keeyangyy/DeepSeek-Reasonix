package config

import (
	"fmt"
	"strings"
)

// renderServeConfig writes the [serve] table this build decodes. Without it a
// save would treat every [serve] key as retired — the renderer never writes the
// table, so the patch engine would drop the whole table on the next save,
// including keys a 2.x build owns (remember_paired_devices, share_port).
func renderServeConfig(b *strings.Builder, c *Config, scope RenderScope) {
	if scope == RenderScopeProject {
		return
	}
	s := c.Serve
	if s.AuthMode == "" && s.Token == "" && s.PasswordHash == "" && !s.BehindProxy {
		return
	}
	b.WriteString("[serve]   # HTTP serve frontend; user/global only, ./reasonix.toml cannot override\n")
	if s.AuthMode != "" {
		fmt.Fprintf(b, "auth_mode = %q   # none|token|password\n", s.AuthMode)
	}
	if s.Token != "" {
		fmt.Fprintf(b, "token = %q   # pre-shared token for auth_mode = token\n", s.Token)
	}
	if s.PasswordHash != "" {
		fmt.Fprintf(b, "password_hash = %q   # bcrypt hash for auth_mode = password\n", s.PasswordHash)
	}
	if s.BehindProxy {
		b.WriteString("behind_proxy = true   # trust X-Forwarded-For/Proto from a trusted reverse proxy\n")
	}
	b.WriteString("\n")
}
