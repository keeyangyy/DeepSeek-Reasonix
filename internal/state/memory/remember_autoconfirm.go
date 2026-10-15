package memory

import (
	"encoding/json"
	"strings"
)

// AssessRememberSwitch reports whether the user's own auto-confirm switch may
// let this write through without the dialog. Which scope the switch covers is
// the caller's question; the content floor stays here, so a sensitive body
// still asks however the switch is set. The assessed Name travels so the
// caller can name the fact in the receipt the write owes.
func AssessRememberSwitch(store Store, args json.RawMessage) RememberAssessment {
	in, err := parseRememberRequest(args)
	if err != nil {
		return RememberAssessment{Reason: "invalid remember request"}
	}
	ref := parseMemoryReference(rememberRequestName(in))
	assessment := RememberAssessment{Name: ref.name}
	if assessment.Name == "" {
		// An id-only call still has a name to report: the stored fact's own.
		assessment.Name = storedMemoryName(store, in.ID)
	}
	if strings.TrimSpace(in.Description) == "" || strings.TrimSpace(in.Body) == "" {
		assessment.Reason = "description and body are required"
		return assessment
	}
	if assessment.Name == "" {
		assessment.Reason = "memory name cannot be derived"
		return assessment
	}
	if len([]rune(in.Body)) > maxAutoRememberBodyRunes {
		assessment.Reason = "memory body exceeds the automatic-write budget"
		return assessment
	}
	if rememberRequestSensitive(in) {
		assessment.Reason = "memory may contain sensitive information"
		return assessment
	}
	assessment.AutoAllow = true
	assessment.Reason = "the user's switch covers this write"
	return assessment
}

// RememberWriteScope names the memory a remember call would write. An explicit
// scope or a qualified name wins; when an update leaves the scope out, the
// stored fact answers, so a global memory cannot ride the project switch.
func RememberWriteScope(store Store, args json.RawMessage) FactScope {
	in, err := parseRememberRequest(args)
	if err != nil {
		return FactScopeProject
	}
	if ref := parseMemoryReference(rememberRequestName(in)); ref.qualified {
		return ref.scope
	}
	if scope := strings.TrimSpace(in.Scope); scope != "" {
		return NormalizeFactScope(scope)
	}
	stored, ok := storedMemoryByID(store, in.ID)
	if !ok {
		return FactScopeProject
	}
	return NormalizeFactScope(string(stored.Scope))
}

// storedMemoryName is the name of the fact an id-only call names, or "" when
// the store cannot say: a write whose name cannot be derived still asks.
func storedMemoryName(store Store, id string) string {
	stored, ok := storedMemoryByID(store, id)
	if !ok {
		return ""
	}
	return stored.Name
}

// storedMemoryByID looks a fact up by the id an update names. A store that
// cannot be read answers "not found": the write then asks, which is the safe
// direction.
func storedMemoryByID(store Store, id string) (Memory, bool) {
	if id = strings.TrimSpace(id); id == "" {
		return Memory{}, false
	}
	memories, err := store.ListAll()
	if err != nil {
		return Memory{}, false
	}
	for _, m := range memories {
		if m.ID == id {
			return m, true
		}
	}
	return Memory{}, false
}
