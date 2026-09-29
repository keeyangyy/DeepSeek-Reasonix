package recovery

import (
	"encoding/json"
	"strings"
)

func commandFromArgs(args json.RawMessage) string {
	if len(args) == 0 {
		return ""
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(args, &fields); err != nil {
		return ""
	}
	raw, ok := fields["command"]
	if !ok {
		return ""
	}
	var cmd string
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return ""
	}
	return strings.TrimSpace(cmd)
}

func pathsFromArgs(args json.RawMessage) []string {
	if len(args) == 0 {
		return nil
	}
	var fields map[string]any
	if err := json.Unmarshal(args, &fields); err != nil {
		return nil
	}
	var paths []string
	for _, key := range []string{
		"path", "file_path", "file", "target", "destination",
		"source_path", "destination_path", "old_path", "new_path",
	} {
		if v, ok := fields[key].(string); ok && strings.TrimSpace(v) != "" {
			paths = append(paths, strings.TrimSpace(v))
		}
	}
	return uniqueStrings(paths)
}

func normalizeCommand(s string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(s)), " ")
}
func hasGlobalFlag(fields []string) bool {
	return containsAny(fields, "-g", "--global", "--system", "--user")
}

func unwrapEnvCommand(args []string) ([]string, bool) {
	for len(args) > 0 {
		arg := args[0]
		lower := strings.ToLower(arg)
		switch {
		case lower == "-i" || lower == "--ignore-environment" || lower == "-0" || lower == "--null":
			args = args[1:]
		case lower == "-u" || lower == "--unset" || lower == "-c" || lower == "--chdir":
			if len(args) < 2 {
				return nil, false
			}
			args = args[2:]
		case strings.HasPrefix(lower, "--unset=") || strings.HasPrefix(lower, "--chdir="):
			args = args[1:]
		case strings.HasPrefix(arg, "-"):
			// Split-string and unknown options can change the command shape.
			return nil, false
		case strings.Contains(arg, "="):
			args = args[1:]
		default:
			return args, true
		}
	}
	return nil, false
}

func unwrapCommandBuiltin(args []string) ([]string, bool) {
	for len(args) > 0 {
		switch strings.ToLower(args[0]) {
		case "-p":
			args = args[1:]
		case "-v":
			// Inspection-only command lookup; there is no wrapped execution.
			return nil, true
		default:
			if strings.HasPrefix(args[0], "-") {
				return nil, false
			}
			return args, true
		}
	}
	return nil, false
}

func trimLeadingOptions(args []string) []string {
	for len(args) > 0 && strings.HasPrefix(args[0], "-") {
		args = args[1:]
	}
	return args
}

func lowerFields(fields []string) []string {
	out := make([]string, len(fields))
	for i, field := range fields {
		out[i] = strings.ToLower(strings.TrimSpace(field))
	}
	return out
}

func containsAny(fields []string, values ...string) bool {
	wanted := make(map[string]struct{}, len(values))
	for _, value := range values {
		wanted[value] = struct{}{}
	}
	for _, field := range fields {
		if _, ok := wanted[field]; ok {
			return true
		}
	}
	return false
}
