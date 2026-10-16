package store

// jsonlSidecarSuffixes are the .jsonl sidecars a directory scan cannot tell
// apart from a transcript by extension. A listing classifies by name, so one
// missing here is shown to the user as a conversation of its own.
var jsonlSidecarSuffixes = []string{
	".events.jsonl",
	".conflicts.jsonl",
	".guardian.jsonl",
	".turns.jsonl",
	".wire.jsonl",
	".adjudication.jsonl",
	".execution.jsonl",
}
