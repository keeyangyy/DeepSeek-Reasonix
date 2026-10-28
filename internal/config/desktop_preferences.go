package config

import (
	"net/url"
	"strings"
)

// DesktopConfig controls desktop-only UI preferences. It is intentionally
// separate from top-level language and [ui] so desktop choices do not affect CLI
// language, terminal colours, or provider-visible prompt/request data.
type DesktopConfig struct {
	Language                string   `toml:"language"`                   // auto|en|zh; empty/auto = browser/OS auto-detect
	Currency                string   `toml:"currency"`                   // legacy display currency; migrated to [billing].display_currency
	LayoutStyle             string   `toml:"layout_style"`               // workbench|creation; legacy classic is migrated on startup
	Theme                   string   `toml:"theme"`                      // auto|dark|light|schedule; empty resolves to auto
	ThemeStyle              string   `toml:"theme_style"`                // graphite|aurora|slate|carbon|nocturne|amber and legacy aliases
	ThemeScheduleDarkStart  string   `toml:"theme_schedule_dark_start"`  // "HH:MM" dark-window start for theme=schedule; empty = unconfigured
	ThemeScheduleDarkEnd    string   `toml:"theme_schedule_dark_end"`    // "HH:MM" dark-window end for theme=schedule (may cross midnight)
	TerminalTheme           string   `toml:"terminal_theme"`             // auto|dark|light; auto follows the desktop app theme
	ExternalOpener          string   `toml:"external_opener"`            // preferred installed app used by the desktop Open control
	CloseBehavior           string   `toml:"close_behavior"`             // quit|background; desktop window close behavior
	DisplayMode             string   `toml:"display_mode"`               // standard|compact (legacy "minimal" maps to compact); transcript display mode
	StatusBarStyle          string   `toml:"status_bar_style"`           // icon|text; desktop status bar metric labels
	StatusBarItems          []string `toml:"status_bar_items"`           // ordered visible desktop status bar items
	DefaultToolApprovalMode string   `toml:"default_tool_approval_mode"` // ask|auto|yolo; defaults to auto for newly-created desktop sessions
	CheckUpdates            *bool    `toml:"check_updates"`              // startup update checks; nil keeps the default enabled
	// UpdateChannel is a legacy compatibility field. It is accepted on read but
	// ignored and omitted from future canonical writes.
	UpdateChannel        string   `toml:"update_channel"`
	Telemetry            *bool    `toml:"telemetry"`          // anonymous launch ping plus scrubbed next-launch native crash diagnostics; nil keeps the default enabled
	Metrics              *bool    `toml:"metrics"`            // aggregate desktop metrics (anonymous signal/bucket counts, including lifecycle health; no content); nil keeps the default enabled
	ProviderAccess       []string `toml:"provider_access"`    // desktop-only list of provider entries shown in Settings > Model > Access
	SessionExperience    string   `toml:"session_experience"` // standard|deep; canonical desktop transcript experience
	ExpandThinking       bool     `toml:"expand_thinking"`    // deprecated compatibility alias: true maps to auto
	ReasoningDisplayMode string   `toml:"reasoning_display_mode"`
	ConversationWidth    string   `toml:"conversation_width"` // standard|full; max transcript width; empty = standard
	// UpdateSourceEnabled gates mirror acceleration for update downloads; nil
	// keeps the default (enabled) so existing configs need no migration.
	UpdateSourceEnabled *bool `toml:"update_source_enabled"`
	// UpdateMirrors are ordered GitHub proxy prefixes. They are tried in order
	// and the official source is always appended last by the updater.
	UpdateMirrors []UpdateMirrorConfig `toml:"update_mirrors"`
}

// UpdateMirrorConfig is one proxy prefix such as https://gh-proxy.com. Disabled
// keeps the row and its position while skipping it, so a dead mirror can be
// switched off without losing where the user put it.
type UpdateMirrorConfig struct {
	URL      string `toml:"url"`
	Disabled bool   `toml:"disabled"`
}

// UpdateSourceMirrorsEnabled reports whether mirror acceleration is on. A nil
// pointer means the default (on), so existing config files need no migration.
func (c *Config) UpdateSourceMirrorsEnabled() bool {
	if c == nil || c.Desktop.UpdateSourceEnabled == nil {
		return true
	}
	return *c.Desktop.UpdateSourceEnabled
}

// SetUpdateSourceEnabled flips the mirror switch without touching the list, so
// turning acceleration off and on again preserves the user's mirrors and order.
func (c *Config) SetUpdateSourceEnabled(enabled bool) {
	if c == nil {
		return
	}
	v := enabled
	c.Desktop.UpdateSourceEnabled = &v
}

// UpdateMirrorPrefixes returns the enabled proxy prefixes in user order. The
// official source is never included here; callers append it last themselves.
func (c *Config) UpdateMirrorPrefixes() []string {
	if c == nil || !c.UpdateSourceMirrorsEnabled() {
		return nil
	}
	out := make([]string, 0, len(c.Desktop.UpdateMirrors))
	for _, m := range c.Desktop.UpdateMirrors {
		if m.Disabled {
			continue
		}
		if prefix := normalizeMirrorPrefix(m.URL); prefix != "" {
			out = append(out, prefix)
		}
	}
	return out
}

// SetUpdateMirrors replaces the ordered list, dropping unusable or duplicate
// entries. Only https is accepted: a plain-http proxy would let an on-path
// attacker rewrite catalog responses (artifact signatures still hold, but the
// update flow itself would be tamperable).
func (c *Config) SetUpdateMirrors(mirrors []UpdateMirrorConfig) {
	if c == nil {
		return
	}
	seen := make(map[string]bool, len(mirrors))
	out := make([]UpdateMirrorConfig, 0, len(mirrors))
	for _, m := range mirrors {
		prefix := normalizeMirrorPrefix(m.URL)
		if prefix == "" || seen[prefix] {
			continue
		}
		seen[prefix] = true
		out = append(out, UpdateMirrorConfig{URL: prefix, Disabled: m.Disabled})
	}
	c.Desktop.UpdateMirrors = out
}

// normalizeMirrorPrefix keeps only bare https origins-and-paths without a
// trailing slash, turning " https://x.com/ " into "https://x.com".
func normalizeMirrorPrefix(raw string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return ""
	}
	return trimmed
}

// DesktopExternalOpener returns the selected opener id; unavailable ids fall
// back to the platform file manager in the desktop shell.
func (c *Config) DesktopExternalOpener() string {
	if c == nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(c.Desktop.ExternalOpener))
}
