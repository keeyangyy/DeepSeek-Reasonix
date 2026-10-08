package event

import "encoding/json"

// DetailIsPayload reports that a coded notice's Detail is the typed payload its
// sentence is worded from, so a sink that prints Text must not append it again.
func DetailIsPayload(code string) bool {
	return code == NoticeCodeUnappliedSteer || code == NoticeCodeExtensionSkipped
}

// ExtensionSkipReasonNoLiveSidecar: the extension's companion process is not running.
const ExtensionSkipReasonNoLiveSidecar = "no_live_sidecar"

// ExtensionSkipped is the Detail payload of NoticeCodeExtensionSkipped: which
// extension was left out, at which interception point, and the stable reason.
type ExtensionSkipped struct {
	Extension string `json:"extension"`
	Point     string `json:"point"`
	Reason    string `json:"reason"`
}

// Encode renders the payload as the notice's Detail.
func (p ExtensionSkipped) Encode() string {
	raw, err := json.Marshal(p)
	if err != nil {
		return ""
	}
	return string(raw)
}

// DecodeExtensionSkipped reads the payload back; ok is false for a Detail that
// is not one, so a caller keeps the kernel's English.
func DecodeExtensionSkipped(detail string) (ExtensionSkipped, bool) {
	var p ExtensionSkipped
	if err := json.Unmarshal([]byte(detail), &p); err != nil || p.Extension == "" {
		return ExtensionSkipped{}, false
	}
	return p, true
}
