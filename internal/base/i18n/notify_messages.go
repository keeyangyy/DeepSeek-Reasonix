package i18n

// NotifyMessages is the text of every desktop notification; Messages embeds it,
// so a new notification kind adds a line here and not to the catalogue struct.
type NotifyMessages struct {
	NotifyTitle         string // desktop notification title
	NotifyTurnDone      string // the turn finished
	NotifyTurnFailed    string // the turn failed
	NotifyApproval      string // something is waiting to be approved
	NotifyAsk           string // the model asked a question
	NotifyFeedbackReply string // a feedback report has a new reply
}
