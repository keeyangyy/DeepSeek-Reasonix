package config

import (
	"errors"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/BurntSushi/toml"

	fileencoding "reasonix/internal/fileutil/encoding"
)

// saveUserIncrementalResolved writes the user config the way the project config
// is written: only the keys this save changed are rewritten and every other byte
// of the file stays as it was.
//
// It never replaces an existing file with a whole render while a key-by-key edit
// is possible. The user config is shared with the CLI and Studio lines and with
// hand edits, so a whole render would silently drop every key this build does
// not model — including keys the build decodes but does not render.
//
// When the edit cannot be expressed, or the patched text would not load back as
// the save intended, the prior bytes are kept beside the file and the whole
// render is written instead. A save that silently loses a setting is worse than
// a save that rewrites the file and says so: the setting the user just changed
// must reach disk, and the backup is what makes the loss visible and recoverable.
func (c *Config) saveUserIncrementalResolved(logicalPath, resolvedPath string) error {
	full := RenderTOMLForScope(c, RenderScopeUser)
	raw, err := fileencoding.ReadFileUTF8(resolvedPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		// First save: there is no user content to lose.
		return writeConfigFileResolved(resolvedPath, full, configFilePerm(logicalPath))
	}
	text := string(raw)
	if strings.TrimSpace(text) == "" {
		return writeConfigFileResolved(resolvedPath, full, configFilePerm(logicalPath))
	}
	body, err := patchExistingUserConfig(logicalPath, resolvedPath, text, c, full, raw)
	if err != nil {
		return err
	}
	return writeConfigFileResolved(resolvedPath, body, configFilePerm(logicalPath))
}

// saveScopedConfig writes one config scope: the user scope rewrites only the
// keys a save changed, and every other scope renders the whole file as before.
func (c *Config) saveScopedConfig(logicalPath, resolvedPath string, scope RenderScope) error {
	if scope == RenderScopeUser {
		return c.saveUserIncrementalResolved(logicalPath, resolvedPath)
	}
	return writeConfigFileResolved(resolvedPath, RenderTOMLForScope(c, scope), configFilePerm(logicalPath))
}

// writeConfigForPath writes a config to path at the scope that path implies,
// resolving the write target the way the whole-file path always has.
func (c *Config) writeConfigForPath(path string) error {
	scope := renderScopeForPath(path)
	if scope != RenderScopeUser {
		return atomicWriteToConfigFile(path, RenderTOMLForScope(c, scope), configFilePerm(path))
	}
	resolved, err := resolveConfigReadPath(path)
	if err != nil {
		return err
	}
	return c.saveUserIncrementalResolved(path, resolved)
}

// loadUserConfigFromText decodes one user config body the way a load would, so
// the save can compare what the file says with what the edit decided.
func loadUserConfigFromText(path, text string) (*Config, error) {
	cfg := Default()
	if _, err := mergeFileSnapshotWithRead(cfg, path, func(string) ([]byte, error) { return []byte(text), nil }); err != nil {
		return nil, err
	}
	normalizeConfigForEdit(cfg)
	return cfg, nil
}

// patchExistingUserConfig is the in-place edit of an existing user config.
//
// A patch the text cannot express, or one that would not load back as the save
// intended, is not written: the caller keeps the prior bytes beside the file and
// writes the whole render instead. The file always ends up holding the setting
// the user asked for.
func patchExistingUserConfig(logicalPath, resolvedPath, text string, next *Config, full string, raw []byte) (string, error) {
	base, err := loadUserConfigFromText(logicalPath, text)
	if err != nil {
		return "", fmt.Errorf("save user config %s: this build cannot read the existing file, so it was left unchanged: %w", logicalPath, err)
	}
	body, ok := patchUserConfigText(text, base, next, full)
	if ok {
		body = stripRetiredUserConfigLines(body)
		if looksLikeIntended(logicalPath, body, full) {
			return body, nil
		}
	}
	// In-place editing could not express this save. Write the render and keep
	// the prior bytes, so the change lands and a lost unknown key is recoverable.
	keepPriorUserConfig(logicalPath, resolvedPath, raw, "config: saved by full rewrite")
	return full, nil
}

// looksLikeIntended reports whether body loads and then renders exactly as the
// save intended. Loading normalizes the config (legacy migrations, official
// model defaults), so both sides are normalized before they are compared.
func looksLikeIntended(path, body, want string) bool {
	wantCfg, err := loadUserConfigFromText(path, want)
	if err != nil {
		return false
	}
	cfg, err := loadUserConfigFromText(path, body)
	if err != nil {
		return false
	}
	return sameUserRender(cfg, wantCfg)
}

// sameUserRender compares two loaded configs by their user-scope render.
func sameUserRender(a, b *Config) bool {
	if a == nil || b == nil {
		return false
	}
	ma, okA := decodeRenderTree(RenderTOMLForScope(a, RenderScopeUser))
	mb, okB := decodeRenderTree(RenderTOMLForScope(b, RenderScopeUser))
	return okA && okB && sameValue(ma, mb)
}

// decodeRenderTree decodes a render, setting aside each line the decoder
// refuses, such as a float the renderer spells as NaN. skipped lists them so
// a caller can require both sides of a save to have set aside the same ones.
func decodeRenderTree(text string) (tree map[string]any, ok bool) {
	lines := strings.SplitAfter(text, "\n")
	for range 8 {
		_, err := toml.Decode(strings.Join(lines, ""), &tree)
		if err == nil {
			return tree, true
		}
		var pe toml.ParseError
		if !errors.As(err, &pe) || pe.Position.Line < 1 || pe.Position.Line > len(lines) {
			return nil, false
		}
		lines[pe.Position.Line-1] = "\n"
		tree = nil
	}
	return nil, false
}

// patchUserConfigText rewrites in text only the entries the save changed.
// ok is false when the change cannot be expressed entry by entry.
func patchUserConfigText(text string, base, next *Config, nextRender string) (string, bool) {
	baseRender := RenderTOMLForScope(base, RenderScopeUser)
	doc, parsed := parseTOMLDoc(text)
	if !parsed {
		return "", false
	}
	rendered, parsed := parseTOMLDoc(nextRender)
	if !parsed {
		return "", false
	}
	before, okB := decodeRenderTree(baseRender)
	after, okA := decodeRenderTree(nextRender)
	if !okB || !okA {
		return "", false
	}
	was, _ := encodeConfigTree(base)
	now, _ := encodeConfigTree(next)
	p := &configPatch{doc: doc, rendered: rendered}
	p.table(nil, configSide{before, was}, configSide{after, now})
	if was != nil && now != nil {
		p.dropUnrendered(nil, was, now, after)
	}
	if doc.broken || p.broken {
		return "", false
	}
	return doc.String(), true
}

// keepPriorUserConfig preserves the bytes a rewrite replaces, so a setting that
// could not be carried over remains recoverable by hand.
func keepPriorUserConfig(logicalPath, resolvedPath string, raw []byte, msg string) {
	backup := resolvedPath + ".rewrite-" + time.Now().Format("20060102-150405")
	if err := os.WriteFile(backup, raw, configFilePerm(logicalPath)); err != nil {
		return
	}
}

// stripRetiredUserConfigLines drops the retired keys a whole render drops by
// simply not writing them.
func stripRetiredUserConfigLines(body string) string {
	for _, strip := range []func(string) (string, bool){
		stripLegacyAgentStepLimitLines,
		stripLegacyRedactToolOutputLines,
		stripLegacyMemoryCompilerLines,
		stripLegacyMultiThresholdCompactionLines,
		stripLegacyMCPTierLines,
		stripLegacyCLIUpdateChannelLines,
	} {
		if stripped, changed := strip(body); changed {
			body = stripped
		}
	}
	return body
}

// stripLegacyCLIUpdateChannelLines drops only the retired [cli].update_channel
// key. The whole-file render never emits it, so leaving it on disk would claim a
// live setting that no longer exists — but the rest of [cli] and any sub-table
// belong to another line or to the user, so they stay.
func stripLegacyCLIUpdateChannelLines(raw string) (string, bool) {
	stripped, changed := stripTOMLKeyLines(raw, "cli", "update_channel")
	if !changed {
		return raw, false
	}
	if !tomlSectionHasContent(stripped, "cli") {
		return removeTOMLSection(stripped, "cli"), true
	}
	return stripped, true
}

// tomlSectionHasContent reports whether the table still holds a key or a
// sub-table after the retired keys are gone.
func tomlSectionHasContent(body, section string) bool {
	spans := tomlLineSpans(body)
	structural := tomlStructuralLineMask(spans)
	inSection := false
	for i, span := range spans {
		if !structural[i] {
			continue
		}
		if name, isArray, ok := tomlEditSectionHeader(span.text); ok {
			if inSection {
				if strings.HasPrefix(name, section+".") {
					return true
				}
				return false
			}
			inSection = !isArray && name == section
			continue
		}
		if !inSection {
			continue
		}
		if trimmed := strings.TrimSpace(span.text); trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			return true
		}
	}
	return false
}

func decodeUserConfigTree(text string) (map[string]any, bool) {
	var tree map[string]any
	if _, err := toml.Decode(text, &tree); err != nil {
		return nil, false
	}
	return tree, true
}

var _ = sort.Strings
var _ = reflect.DeepEqual
