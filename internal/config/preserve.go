// preserve.go — saving the user config by rewriting only the keys a save
// changed. The file is shared with the 1.x and studio lines and with hand
// edits, so a table this build does not decode is not its to drop.
package config

import (
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"

	fileencoding "reasonix/internal/fileutil/encoding"
)

// saveUserIncrementalResolved writes the user config the way the project config
// is written: only the keys this save changed are rewritten and every other byte
// of the file stays as it was.
//
// It never replaces an existing file with a whole render. The user config is
// shared with the CLI and Studio lines and with hand edits, so a whole render
// would silently drop every key this build does not model — including keys the
// build decodes but does not render. A save that cannot be expressed key by key
// therefore fails with the file left exactly as it was; the caller reports that
// error instead of pretending the setting was stored.
func (c *Config) saveUserIncrementalResolved(logicalPath, resolvedPath string) error {
	raw, err := fileencoding.ReadFileUTF8(resolvedPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		// First save: there is no user content to lose.
		return writeConfigFileResolved(resolvedPath, RenderTOMLForScope(c, RenderScopeUser), configFilePerm(logicalPath))
	}
	text := string(raw)
	if strings.TrimSpace(text) == "" {
		return writeConfigFileResolved(resolvedPath, RenderTOMLForScope(c, RenderScopeUser), configFilePerm(logicalPath))
	}
	full := renderUserConfigForSave(c, text)
	body, err := patchExistingUserConfig(logicalPath, text, c, full)
	if err != nil {
		return err
	}
	return writeConfigFileResolved(resolvedPath, body, configFilePerm(logicalPath))
}

// renderUserConfigForSave renders what the save should write. Loading a user
// config injects an official built-in provider the file never declared (a
// DeepSeek profile derived from legacy aliases). That belongs to the running
// process, not to the user's file: writing it would add a provider nobody asked
// for, and leaving it in the target while the loader injects it again makes the
// read-back guard refuse every save that touches provider access. Only an
// official built-in can be injected; a provider the save itself added stays.
func renderUserConfigForSave(c *Config, fileText string) string {
	full := RenderTOMLForScope(c, RenderScopeUser)
	declared, ok := declaredProviderNames(fileText)
	if !ok {
		return full
	}
	elems, ok := arrayElements(full, "providers")
	if !ok || len(elems) == 0 {
		return full
	}
	// Only an official built-in profile can be injected by the loader. Any other
	// provider the save added is the user's own and must be written.
	injected := make(map[string]bool, 1)
	for _, p := range c.Providers {
		name := strings.TrimSpace(p.Name)
		if name == "" || declared[name] || officialProviderKind(&p) == "" {
			continue
		}
		injected[name] = true
	}
	if len(injected) == 0 {
		return full
	}
	kept := make([]arrayElement, 0, len(elems))
	for _, elem := range elems {
		if !injected[elem.name] {
			kept = append(kept, elem)
		}
	}
	if len(kept) == len(elems) {
		return full
	}
	if len(kept) == 0 {
		return full[:elems[0].start] + full[elems[len(elems)-1].end:]
	}
	blocks := make([]string, 0, len(kept))
	for _, elem := range kept {
		blocks = append(blocks, strings.TrimRight(elem.text, "\n"))
	}
	rebuilt := strings.Join(blocks, "\n\n") + "\n\n"
	// Replace the whole array region, not just the kept elements' span: a
	// dropped element after the last kept one would otherwise come back with
	// the tail the slice appends.
	return full[:elems[0].start] + rebuilt + full[elems[len(elems)-1].end:]
}

// declaredProviderNames lists the provider names the file itself declares. It
// reports false when the file cannot be read as a plain provider list, which
// leaves the caller with the unmodified render.
func declaredProviderNames(text string) (map[string]bool, bool) {
	tree, ok := decodeUserConfigTree(text)
	if !ok {
		return nil, false
	}
	raw, present := tree["providers"]
	if !present {
		return map[string]bool{}, true
	}
	elems, ok := raw.([]map[string]any)
	if !ok {
		return nil, false
	}
	out := make(map[string]bool, len(elems))
	for _, elem := range elems {
		name, _ := elem["name"].(string)
		if name = strings.TrimSpace(name); name == "" {
			return nil, false
		}
		out[name] = true
	}
	return out, true
}

// patchExistingUserConfig is the in-place edit of an existing user config. It
// returns an error — never a substitute body — when the save cannot be applied
// to the text as it stands, so one setting change can never take the rest of the
// file with it.
func patchExistingUserConfig(logicalPath, text string, next *Config, full string) (string, error) {
	base, err := loadUserConfigFromText(logicalPath, text)
	if err != nil {
		return "", fmt.Errorf("save user config %s: this build cannot read the existing file, so it was left unchanged: %w", logicalPath, err)
	}
	body, ok := patchUserConfigText(text, base, next, full)
	if !ok {
		return "", fmt.Errorf("save user config %s: this change has no key-by-key form, so the file was left unchanged", logicalPath)
	}
	if !userConfigRendersAs(logicalPath, body, full) {
		return "", fmt.Errorf("save user config %s: the edited file would not read back as intended, so it was left unchanged", logicalPath)
	}
	return body, nil
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
// want would once it has been through the same load. Loading normalizes the
// config (legacy migrations, official-model defaults), so comparing a loaded
// body against an unloaded render would report a difference for every value the
// loader derives. Normalizing both sides compares what the save actually
// decided, which is what makes an in-place patch safe to write.
func userConfigRendersAs(path, body, want string) bool {
	wantCfg, err := loadUserConfigFromText(path, want)
	if err != nil {
		return false
	}
	normalizedWant := RenderTOMLForScope(wantCfg, RenderScopeUser)
	cfg, err := loadUserConfigFromText(path, body)
	if err != nil {
		return false
	}
	got := RenderTOMLForScope(cfg, RenderScopeUser)
	return got == normalizedWant
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
		patched, ok := upsertUserConfigEntry(body, nextRender, entry, droppedElementKeys(before, after, entry.key.section))
		if !ok {
			return "", false
		}
		body = patched
	}
	return stripRetiredUserConfigLines(body), true
}

// droppedElementKeys lists, for one array-of-tables section, the element keys
// the save intentionally removed: keys present in the base render for an element
// that is still there, and absent from the next render. Those are deletions the
// save decided on, not fields this build fails to model, so the carry-over step
// must not write them back.
func droppedElementKeys(before, after map[string]userConfigEntry, section string) map[string]bool {
	entry, ok := after[userConfigKey{section: section}.id()]
	if !ok || !entry.table {
		return nil
	}
	beforeEntry, hadBefore := before[userConfigKey{section: section}.id()]
	if !hadBefore || !beforeEntry.table {
		return nil
	}
	oldElems, ok := sessionOwnElementKeys(beforeEntry.value)
	if !ok {
		return nil
	}
	newElems, ok := sessionOwnElementKeys(entry.value)
	if !ok {
		return nil
	}
	dropped := map[string]bool{}
	for name, keys := range oldElems {
		kept, present := newElems[name]
		if !present {
			continue
		}
		for key := range keys {
			if !kept[key] {
				dropped[key] = true
			}
		}
	}
	if len(dropped) == 0 {
		return nil
	}
	return dropped
}

// sessionOwnElementKeys indexes one array-of-tables value by element identity,
// then by that element's own key names. Elements are matched the same way
// carryArrayElementFields matches them: on their `name` (providers, plugins) or
// `id` (bot connections).
func sessionOwnElementKeys(value any) (map[string]map[string]bool, bool) {
	elems, ok := value.([]map[string]any)
	if !ok {
		return nil, false
	}
	out := make(map[string]map[string]bool, len(elems))
	for _, elem := range elems {
		name := ""
		for _, key := range []string{"name", "id"} {
			if v, ok := elem[key].(string); ok {
				name = v
				break
			}
		}
		if name == "" {
			return nil, false
		}
		keys := make(map[string]bool, len(elem))
		for key := range elem {
			keys[key] = true
		}
		out[name] = keys
	}
	return out, true
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

// stripLegacyCLIUpdateChannelLines drops only the retired [cli].update_channel
// key. The whole-file render never emits it, so leaving it on disk would claim a
// live setting that no longer exists — but the rest of [cli] and any sub-table
// belong to another line or to the user, so they stay.
func stripLegacyCLIUpdateChannelLines(raw string) (string, bool) {
	stripped, changed := stripTOMLKeyLines(raw, "cli", "update_channel")
	if !changed {
		return raw, false
	}
	// A [cli] header with nothing left under it is only noise now.
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
				// A sub-table of this section is content; any other header ends
				// the section with nothing found.
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
func upsertUserConfigEntry(body, nextRender string, entry userConfigEntry, dropped map[string]bool) (string, bool) {
	body = dropInlinePathSection(body, nextRender, entry.key)
	if entry.key.section != "" {
		var ok bool
		if body, ok = expandShadowingInlineTable(body, entry.key.section); !ok {
			return "", false
		}
	}
	if entry.table {
		block := userConfigRenderTableBlock(nextRender, entry.key.section)
		if block == "" {
			return "", false
		}
		// Elements keep the keys this build does not model; refuse when they
		// cannot be matched by name instead of replacing them wholesale.
		patched := replaceTOMLSection(body, entry.key.section, block)
		return carryArrayElementFieldsExcept(body, patched, entry.key.section, dropped)
	}
	line := userConfigRenderKeyLine(nextRender, entry.key)
	if line == "" {
		// The render may spell this path as an inline key of its parent, so
		// write that key and drop the sub-table it replaces.
		parent, name, split := splitUserConfigSection(entry.key.section)
		if !split {
			return "", false
		}
		line = userConfigRenderKeyLine(nextRender, userConfigKey{section: parent, name: name})
		if line == "" {
			return "", false
		}
		body = removeTOMLSection(body, entry.key.section)
		return upsertTOMLSectionKey(body, parent, name, line), true
	}
	if entry.key.section == "" {
		return mergeTOMLTopLevelFields(body, line), true
	}
	return upsertTOMLSectionKey(body, entry.key.section, entry.key.name, line), true
}

// expandShadowingInlineTable rewrites a table the file spells as one top-level
// inline value (ui = { theme = "dark" }) as the [ui] table the render writes.
// Writing the table without removing the inline key would define the same path
// twice; dropping the inline key without writing its other entries would lose
// the ones this build does not model.
func expandShadowingInlineTable(body, section string) (string, bool) {
	if section == "" || !tomlBodyHasTopLevelKey(body, section) {
		return body, true
	}
	tree, ok := decodeUserConfigTree(body)
	if !ok {
		return "", false
	}
	value, present := tree[section]
	if !present {
		return body, true
	}
	var b strings.Builder
	if err := toml.NewEncoder(&b).Encode(map[string]any{section: value}); err != nil {
		return "", false
	}
	body, ok = removeTOMLTopLevelField(body, section)
	if !ok {
		return "", false
	}
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	return body + "\n" + b.String(), true
}

// splitUserConfigSection splits "agent.subagent_models" into the parent table
// and the key inside it. Quoted or dotted leaf keys are declined: this fallback
// only covers plain table paths.
func splitUserConfigSection(section string) (parent, name string, ok bool) {
	idx := strings.LastIndex(section, ".")
	if idx <= 0 || idx == len(section)-1 {
		return "", "", false
	}
	parent, name = section[:idx], section[idx+1:]
	if strings.ContainsAny(name, ".\"") {
		return "", "", false
	}
	return parent, name, true
}

func decodeUserConfigTree(text string) (map[string]any, bool) {
	var tree map[string]any
	if _, err := toml.Decode(text, &tree); err != nil {
		return nil, false
	}
	return tree, true
}

// dropInlinePathSection removes a section that names a path the render writes
// inside its parent table — [agent.subagent_models] when the render emits
// subagent_models = {…} in [agent]. Writing the new form while the old section
// survives defines the same key twice, which makes the file invalid TOML and
// every later load fall back to defaults.
func dropInlinePathSection(body, nextRender string, key userConfigKey) string {
	if key.section == "" || key.name == "" {
		return body
	}
	path := key.section + "." + key.name
	if tomlBodyHasSection(nextRender, path) || !tomlBodyHasSection(body, path) {
		return body
	}
	return removeTOMLSection(body, path)
}

// removeUserConfigEntry drops one entry from body. It reports false when the
// entry has no in-place form here, which makes the caller stop rather than
// rewrite the whole file: a key of the user's that the build does not know must
// never be collateral damage of one setting change.
func removeUserConfigEntry(body string, key userConfigKey) (string, bool) {
	switch {
	case key.section == "" && key.name == "":
		return "", false
	case key.section == "":
		return removeTOMLTopLevelField(body, key.name)
	case key.name != "" && tomlBodyHasSection(body, key.section+"."+key.name):
		// The entry is spelled as its own table here rather than a key inside
		// the parent, so removing it means dropping that whole table.
		return removeTOMLSection(body, key.section+"."+key.name), true
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
// element. Sub-tables the render nests under the same path ([[remote.hosts]]
// with [[remote.hosts.forwards]], [network] with [network.proxy]) belong to the
// region: leaving them out would drop them when the region replaces the table.
func userConfigRenderTableBlock(render, section string) string {
	start, end := -1, -1
	lastContent := -1
	for _, span := range tomlLineSpans(render) {
		name, _, ok := tomlEditSectionHeader(span.text)
		if ok {
			if start >= 0 && name != section && !strings.HasPrefix(name, section+".") {
				end = span.start
				break
			}
			if name == section || strings.HasPrefix(name, section+".") {
				if start < 0 {
					start = span.start
				}
				lastContent = span.end
			}
			continue
		}
		if start < 0 {
			continue
		}
		trimmed := strings.TrimSpace(span.text)
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			lastContent = span.end
		}
	}
	if start < 0 {
		return ""
	}
	if end < 0 {
		// Stop at the last line that belongs to the table. Comments after it
		// describe whatever the renderer writes next, not this table.
		end = lastContent
	}
	if end <= start {
		return ""
	}
	return render[start:end]
}
