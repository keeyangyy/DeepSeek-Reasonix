// preserve.go — saving the user config by rewriting only the keys a save
// changed. The file is shared with the 1.x and studio lines and with hand
// edits, so a table this build does not decode is not its to drop.
package config

import (
	"log/slog"
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
// of the file stays as it was. A save that cannot be shown to load back as c
// falls back to the whole render, with the prior bytes kept beside it and every
// top-level table this build does not decode carried over verbatim.
func (c *Config) saveUserIncrementalResolved(logicalPath, resolvedPath string) error {
	full := RenderTOMLForScope(c, RenderScopeUser)
	raw, err := fileencoding.ReadFileUTF8(resolvedPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		return writeConfigFileResolved(resolvedPath, full, configFilePerm(logicalPath))
	}
	text := string(raw)
	if strings.TrimSpace(text) == "" {
		return writeConfigFileResolved(resolvedPath, full, configFilePerm(logicalPath))
	}
	if base, err := loadUserConfigFromText(logicalPath, text); err == nil {
		body, ok := patchUserConfigText(text, base, c, full)
		if ok && userConfigRendersAs(logicalPath, body, full) {
			return writeConfigFileResolved(resolvedPath, body, configFilePerm(logicalPath))
		}
	}
	keepPriorUserConfig(logicalPath, resolvedPath, text)
	return writeConfigFileResolved(resolvedPath, carryUnknownUserTables(text, full), configFilePerm(logicalPath))
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

// loadUserConfigFromText decodes one user config body the way a load would, so a
// save can tell which of its keys are about to change.
func loadUserConfigFromText(path, text string) (*Config, error) {
	cfg := Default()
	if _, err := mergeFileSnapshotWithRead(cfg, path, func(string) ([]byte, error) { return []byte(text), nil }); err != nil {
		return nil, err
	}
	normalizeConfigForEdit(cfg)
	return cfg, nil
}

// userConfigRendersAs reports whether body loads and then renders exactly as
// want, which is what makes an in-place patch safe to write.
func userConfigRendersAs(path, body, want string) bool {
	cfg, err := loadUserConfigFromText(path, body)
	if err != nil {
		return false
	}
	return RenderTOMLForScope(cfg, RenderScopeUser) == want
}

// keepPriorUserConfig writes the bytes a whole-render save is about to replace
// next to them, so a setting this build could not carry stays recoverable.
func keepPriorUserConfig(logicalPath, resolvedPath, text string) {
	backup := resolvedPath + ".rewrite-" + time.Now().Format("20060102-150405")
	if err := os.WriteFile(backup, []byte(text), configFilePerm(logicalPath)); err != nil {
		slog.Warn("config: back up the prior user config", "path", resolvedPath, "err", err)
		return
	}
	slog.Warn("config: saved by whole render, prior bytes kept", "path", resolvedPath, "backup", backup)
}

// userConfigKey addresses one entry of a user config: the table it lives in
// ("" at the top level) and the key inside it. A table of tables is addressed by
// its own path with an empty key, so its edit stays inside that table.
type userConfigKey struct {
	section string
	name    string
}

func (k userConfigKey) id() string { return k.section + "\x00" + k.name }

// userConfigEntry is one addressable entry of a render: a scalar key, or a table
// (an array of tables such as [[providers]]) that has to be written as a whole.
type userConfigEntry struct {
	key   userConfigKey
	value any
	table bool
}

// patchUserConfigText rewrites in text only the entries whose value differs
// between base and next. It reports false when the change cannot be expressed
// entry by entry, leaving the caller to fall back to the whole render.
func patchUserConfigText(text string, base, next *Config, nextRender string) (string, bool) {
	before, ok := flattenUserConfigKeys(RenderTOMLForScope(base, RenderScopeUser))
	if !ok {
		return "", false
	}
	after, ok := flattenUserConfigKeys(nextRender)
	if !ok {
		return "", false
	}
	body := text
	for _, id := range userConfigChangedIDs(before, after) {
		entry, kept := after[id]
		if !kept {
			patched, ok := removeUserConfigEntry(body, before[id].key)
			if !ok {
				return "", false
			}
			body = patched
			continue
		}
		patched, ok := upsertUserConfigEntry(body, nextRender, entry)
		if !ok {
			return "", false
		}
		body = patched
	}
	return stripRetiredUserConfigLines(body), true
}

// stripRetiredUserConfigLines drops the retired keys a whole render drops by
// simply not writing them. An incremental save carries the file's other lines
// over, so it has to remove these explicitly or a stale key survives forever.
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

// stripLegacyCLIUpdateChannelLines drops the retired [cli] table. The whole-file
// render never emits it, so leaving the table (or a dangling empty header) on
// disk would claim a live setting that no longer exists.
func stripLegacyCLIUpdateChannelLines(raw string) (string, bool) {
	stripped, changed := stripTOMLKeyLines(raw, "cli", "update_channel")
	if !tomlBodyHasSection(stripped, "cli") {
		return stripped, changed
	}
	return removeTOMLSection(stripped, "cli"), true
}

// userConfigChangedIDs lists the addresses the two renders disagree on, in a
// stable order so a patch is reproducible.
func userConfigChangedIDs(before, after map[string]userConfigEntry) []string {
	ids := make([]string, 0, len(before)+len(after))
	for id := range before {
		ids = append(ids, id)
	}
	for id := range after {
		if _, seen := before[id]; !seen {
			ids = append(ids, id)
		}
	}
	out := ids[:0]
	for _, id := range ids {
		was, inBefore := before[id]
		now, inAfter := after[id]
		if inBefore && inAfter && reflect.DeepEqual(was.value, now.value) && was.table == now.table {
			continue
		}
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// flattenUserConfigKeys flattens one user render into the entries a save can
// address: scalars by their table and key, arrays of tables by their path. A
// render that does not decode is reported so the caller falls back instead.
func flattenUserConfigKeys(render string) (map[string]userConfigEntry, bool) {
	var tree map[string]any
	if _, err := toml.Decode(render, &tree); err != nil {
		return nil, false
	}
	out := make(map[string]userConfigEntry, len(tree))
	if !flattenUserConfigTable("", tree, out) {
		return nil, false
	}
	return out, true
}

func flattenUserConfigTable(section string, table map[string]any, out map[string]userConfigEntry) bool {
	for _, name := range sortedUserConfigNames(table) {
		path := name
		if section != "" {
			path = section + "." + name
		}
		switch value := table[name].(type) {
		case map[string]any:
			if !flattenUserConfigTable(path, value, out) {
				return false
			}
		case []map[string]any:
			key := userConfigKey{section: path}
			out[key.id()] = userConfigEntry{key: key, value: value, table: true}
		case []any:
			key := userConfigKey{section: section, name: name}
			out[key.id()] = userConfigEntry{key: key, value: value}
		default:
			key := userConfigKey{section: section, name: name}
			out[key.id()] = userConfigEntry{key: key, value: value}
		}
	}
	return true
}

func sortedUserConfigNames(table map[string]any) []string {
	names := make([]string, 0, len(table))
	for name := range table {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// upsertUserConfigEntry writes one entry into body from the lines nextRender
// gives it. A table is replaced whole; a scalar is written at its key, leaving
// the rest of its table — comments included — untouched.
func upsertUserConfigEntry(body, nextRender string, entry userConfigEntry) (string, bool) {
	if entry.table {
		block := userConfigRenderTableBlock(nextRender, entry.key.section)
		if block == "" {
			return "", false
		}
		return replaceTOMLSection(body, entry.key.section, block), true
	}
	line := userConfigRenderKeyLine(nextRender, entry.key)
	if line == "" {
		return "", false
	}
	if entry.key.section == "" {
		return mergeTOMLTopLevelFields(body, line), true
	}
	return upsertTOMLSectionKey(body, entry.key.section, entry.key.name, line), true
}

// removeUserConfigEntry drops one entry from body. Removing a top-level key is
// not supported: a save that wants one gone takes the whole-render path.
func removeUserConfigEntry(body string, key userConfigKey) (string, bool) {
	switch {
	case key.section == "" && key.name == "":
		return removeTOMLSection(body, key.section), true
	case key.section == "":
		return "", false
	case key.name == "" && !tomlBodyHasSection(body, key.section):
		return body, true
	case key.name == "":
		return removeTOMLSection(body, key.section), true
	default:
		return removeTOMLSectionKey(body, key.section, key.name), true
	}
}

// userConfigRenderKeyLine returns the line(s) render writes for one scalar key,
// with the comments that belong to it.
func userConfigRenderKeyLine(render string, key userConfigKey) string {
	spans := tomlLineSpans(render)
	section := ""
	for i, span := range spans {
		if name, _, ok := tomlEditSectionHeader(span.text); ok {
			section = name
			continue
		}
		if section != key.section {
			continue
		}
		if got, _, ok := tomlKeyValue(span.text); ok && got == key.name {
			end := tomlValueEndSpan(spans, i)
			var b strings.Builder
			for j := i; j <= end; j++ {
				b.WriteString(spans[j].text)
			}
			return b.String()
		}
	}
	return ""
}

// userConfigRenderTableBlock returns the region render writes for one table,
// taken verbatim so an array of tables keeps its [[name]] headers and every
// element.
func userConfigRenderTableBlock(render, section string) string {
	start, end := -1, -1
	for _, span := range tomlLineSpans(render) {
		name, _, ok := tomlEditSectionHeader(span.text)
		if !ok {
			continue
		}
		if name != section {
			if start >= 0 {
				end = span.start
				break
			}
			continue
		}
		if start < 0 {
			start = span.start
		}
	}
	if start < 0 {
		return ""
	}
	if end < 0 {
		end = len(render)
	}
	return render[start:end]
}

// carryUnknownUserTables appends to render every top-level table of text the
// render does not write, verbatim. This build decodes neither [checkpoints] nor
// [browser], and dropping them would change what another line does.
func carryUnknownUserTables(text, render string) string {
	known := map[string]bool{}
	for _, block := range userConfigTopLevelBlocks(render) {
		known[block.name] = true
	}
	out := render
	for _, block := range userConfigTopLevelBlocks(text) {
		if known[block.name] {
			continue
		}
		if !strings.HasSuffix(out, "\n") {
			out += "\n"
		}
		out += "\n" + block.text
	}
	return out
}

type userConfigBlock struct {
	name string
	text string
}

// userConfigTopLevelBlocks splits body into its top-level table blocks, each
// holding its header, its keys and the comments below it.
func userConfigTopLevelBlocks(body string) []userConfigBlock {
	var blocks []userConfigBlock
	var current *userConfigBlock
	var b strings.Builder
	for _, span := range tomlLineSpans(body) {
		name, _, ok := tomlEditSectionHeader(span.text)
		if ok {
			if current != nil {
				current.text = b.String()
				blocks = append(blocks, *current)
			}
			b.Reset()
			current = &userConfigBlock{name: name}
		}
		if current != nil {
			b.WriteString(span.text)
		}
	}
	if current != nil {
		current.text = b.String()
		blocks = append(blocks, *current)
	}
	return blocks
}
