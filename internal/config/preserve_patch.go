// preserve_patch.go — the patch engine: it edits a parsed TOML document key by
// key, following what changed between two renders of the config.
package config

import (
	"reflect"
	"slices"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"
)

type configPatch struct {
	doc, rendered *tomlDoc
	broken, lossy bool
}

// configSide is one side of a save at one path: its value as rendered, and as
// the struct encodes it, which still tells apart values the render writes alike.
type configSide struct{ shown, raw any }

func (s configSide) at(key string) configSide {
	shown, _ := s.shown.(map[string]any)
	raw, _ := s.raw.(map[string]any)
	return configSide{shown[key], raw[key]}
}

func (p *configPatch) table(path tomlPath, before, after configSide) {
	shownB, _ := before.shown.(map[string]any)
	shownA, _ := after.shown.(map[string]any)
	for _, key := range sortedUnion(shownB, shownA) {
		was, inBefore := shownB[key]
		now, inAfter := shownA[key]
		switch {
		case !inAfter:
			if inBefore {
				p.remove(path, key)
			}
		case p.renderedAsLine(path, key):
			if inBefore && sameValue(was, now) && sameValue(before.at(key).raw, after.at(key).raw) {
				continue
			}
			p.dropTables(func(b tomlPath) bool { return b.under(path.child(key)) })
			p.setFromRender(path, key)
		default:
			p.nested(path, key, before.at(key), after.at(key))
		}
	}
}

func (p *configPatch) nested(path tomlPath, key string, was, now configSide) {
	var carry map[string]any
	if _, line := p.doc.key(p.doc.block(path), key); line {
		carry = p.inlineUnknown(path, key)
		p.doc.removeKey(path, key)
		was = configSide{}
	}
	switch v := now.shown.(type) {
	case map[string]any:
		prev, _ := was.shown.(map[string]any)
		if !p.doc.hasTable(path.child(key)) && !sameValue(prev, v) {
			p.insertFromRender(path.child(key))
		} else {
			p.table(path.child(key), was, now)
		}
		p.carryInline(path.child(key), carry)
	case []map[string]any:
		p.array(path.child(key), was, now)
	default:
		p.broken = true
	}
}

// array edits the elements the save changed in place. The whole array is
// written from the render instead when an element has no identity, when one
// the save touches is not a block of its own in the text (the load merged or
// renamed it), or when the save reorders the elements the text holds.
func (p *configPatch) array(path tomlPath, before, after configSide) {
	shownB, _ := before.shown.([]map[string]any)
	shownA, _ := after.shown.([]map[string]any)
	rawB, _ := before.raw.([]map[string]any)
	rawA, _ := after.raw.([]map[string]any)
	if sameValue(shownB, shownA) && sameValue(rawB, rawA) {
		return
	}
	rawWas, _ := elementsByIdentity(rawB)
	rawNow, _ := elementsByIdentity(rawA)
	was, okB := elementsByIdentity(shownB)
	now, okA := elementsByIdentity(shownA)
	changed := func(id string) bool {
		next, ok := now[id]
		return !ok || !sameValue(was[id], next) || !sameValue(rawWas[id], rawNow[id])
	}
	ids, named := p.docElementIDs(path)
	if !okB || !okA || len(ids) == 0 || !named || !docHoldsChanged(ids, was, changed) || !keepsOrder(ids, was, shownA) {
		p.replaceArray(path, was, now)
		return
	}
	gone := map[string]bool{}
	for id := range was {
		if _, ok := now[id]; !ok {
			gone[path.element(id).String()] = true
		}
	}
	if len(gone) > 0 {
		p.doc.removeTables(func(b tomlPath) bool { return len(b) >= len(path) && gone[b[:len(path)].String()] })
	}
	for i, next := range shownA {
		id := elementIdentity(next["name"], 0)
		if _, existed := was[id]; existed && !changed(id) {
			continue
		}
		el := path.element(id)
		if p.doc.block(el) < 0 {
			p.insertElement(el, p.nextBlockIn(path, shownA[i+1:]))
			continue
		}
		p.table(el, configSide{was[id], rawWas[id]}, configSide{next, rawNow[id]})
	}
}

// nextBlockIn is the header block of the first of rest the text holds, or -1.
func (p *configPatch) nextBlockIn(path tomlPath, rest []map[string]any) int {
	for _, el := range rest {
		if bi := p.doc.block(path.element(elementIdentity(el["name"], 0))); bi >= 0 {
			return bi
		}
	}
	return -1
}

// insertElement writes the rendered element el just before the block at
// index before, after the keys of the block ahead of it, so comments above
// that header stay with it; with no such block it goes after the array.
func (p *configPatch) insertElement(el tomlPath, before int) {
	if before < 1 {
		p.insertFromRender(el)
		return
	}
	region := p.rendered.region(func(b tomlPath) bool { return b.under(el) })
	if region == "" {
		return
	}
	prev := p.doc.blocks[before-1]
	at := prev.header + 1
	if n := len(prev.keys); n > 0 {
		at = prev.keys[n-1].last + 1
	}
	p.doc.splice(at, 0, region)
}

func docHoldsChanged(ids []string, was map[string]map[string]any, changed func(string) bool) bool {
	inDoc := make(map[string]bool, len(ids))
	for _, id := range ids {
		inDoc[id] = true
	}
	for id := range was {
		if changed(id) && !inDoc[id] {
			return false
		}
	}
	return true
}

// keepsOrder reports whether next lists the elements it keeps from the text
// in the order the text holds them.
func keepsOrder(ids []string, was map[string]map[string]any, next []map[string]any) bool {
	at := make(map[string]int, len(ids))
	for i, id := range ids {
		at[id] = i
	}
	last := -1
	for _, el := range next {
		id := elementIdentity(el["name"], 0)
		i, inDoc := at[id]
		if _, kept := was[id]; !kept || !inDoc {
			continue
		}
		if i < last {
			return false
		}
		last = i
	}
	return true
}

// elementsByIdentity keys elements by name; ok is false when any element has
// no name or two share one, which leaves the array to be written as a whole.
func elementsByIdentity(list []map[string]any) (map[string]map[string]any, bool) {
	out := make(map[string]map[string]any, len(list))
	for _, el := range list {
		name, _ := el["name"].(string)
		if name == "" {
			return nil, false
		}
		id := elementIdentity(name, 0)
		if _, dup := out[id]; dup {
			return nil, false
		}
		out[id] = el
	}
	return out, true
}

// docElementIDs lists the identities of the array's elements in text order;
// named is false when one has no name or two share one.
func (p *configPatch) docElementIDs(path tomlPath) (ids []string, named bool) {
	seen := map[string]bool{}
	named = true
	probe := path.element("x")
	for _, b := range p.doc.blocks[1:] {
		if !b.path.sameArray(probe) {
			continue
		}
		id := b.path[len(path)-1].elem
		if strings.HasPrefix(id, "#") || seen[id] {
			named = false
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids, named
}

// dropUnrendered removes a key the edit changed but the renderer never
// writes: the build owns it and has decided it no longer belongs on disk.
func (p *configPatch) dropUnrendered(path tomlPath, was, now, rendered map[string]any) {
	for _, key := range sortedUnion(was, now) {
		if _, shown := rendered[key]; shown {
			if wasT, ok := was[key].(map[string]any); ok {
				nowT, _ := now[key].(map[string]any)
				shownT, _ := rendered[key].(map[string]any)
				p.dropUnrendered(path.child(key), wasT, nowT, shownT)
			}
			continue
		}
		if !sameValue(was[key], now[key]) {
			p.remove(path, key)
		}
	}
}

func encodeConfigTree(c *Config) (map[string]any, bool) {
	var b strings.Builder
	if err := toml.NewEncoder(&b).Encode(c); err != nil {
		return nil, false
	}
	var out map[string]any
	_, err := toml.Decode(b.String(), &out)
	return out, err == nil
}

func (p *configPatch) remove(path tomlPath, key string) {
	if len(p.inlineUnknown(path, key)) > 0 {
		p.lossy = true
	}
	p.doc.removeKey(path, key)
	p.dropTables(func(b tomlPath) bool { return b.under(path.child(key)) })
}

func (p *configPatch) renderedAsLine(path tomlPath, key string) bool {
	_, ok := p.rendered.key(p.rendered.block(path), key)
	return ok
}

func (p *configPatch) setFromRender(path tomlPath, key string) {
	k, ok := p.rendered.key(p.rendered.block(path), key)
	if !ok {
		p.broken = true
		return
	}
	p.doc.setKey(path, key, strings.Join(p.rendered.lines[k.first:k.last+1], ""))
}

func (p *configPatch) insertFromRender(path tomlPath) {
	region := p.rendered.region(func(b tomlPath) bool { return b.under(path) })
	if region == "" {
		return
	}
	p.doc.insertRegion(path, strings.TrimPrefix(region, "\n"))
}

// sameValue is reflect.DeepEqual over decoded TOML, except that NaN equals
// NaN: a float the file holds as nan is the same value on both sides.
func sameValue(a, b any) bool {
	switch x := a.(type) {
	case float64:
		y, ok := b.(float64)
		return ok && (x == y || x != x && y != y)
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			if w, ok := y[k]; !ok || !sameValue(v, w) {
				return false
			}
		}
		return true
	case []map[string]any:
		y, ok := b.([]map[string]any)
		return ok && slices.EqualFunc(x, y, func(m, n map[string]any) bool { return sameValue(m, n) })
	case []any:
		y, ok := b.([]any)
		return ok && slices.EqualFunc(x, y, sameValue)
	}
	return reflect.DeepEqual(a, b)
}

func sortedUnion(a, b map[string]any) []string {
	keys := make([]string, 0, len(a)+len(b))
	for k := range a {
		keys = append(keys, k)
	}
	for k := range b {
		if _, ok := a[k]; !ok {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}
