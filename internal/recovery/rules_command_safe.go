package recovery

import (
	"path/filepath"
	"strings"

	"reasonix/internal/shellsafe"
)

func commandFieldsKnownSafeMutation(fields []string) bool {
	if len(fields) == 0 || commandFieldsHighRisk(fields) {
		return false
	}
	base := strings.ToLower(filepath.Base(fields[0]))
	rawArgs := fields[1:]
	args := lowerFields(rawArgs)
	switch base {
	case "env":
		wrapped, ok := unwrapEnvCommand(rawArgs)
		return ok && commandFieldsKnownSafeMutation(wrapped)
	case "command":
		wrapped, ok := unwrapCommandBuiltin(rawArgs)
		return ok && (len(wrapped) == 0 || commandFieldsKnownSafeMutation(wrapped))
	case "nohup":
		wrapped := trimLeadingOptions(rawArgs)
		return len(wrapped) > 0 && commandFieldsKnownSafeMutation(wrapped)
	case "git":
		return gitCommandKnownSafe(args)
	case "curl":
		return !curlCommandHighRisk(rawArgs)
	case "wget":
		return !wgetCommandHighRisk(args)
	case "gh":
		return !ghCommandHighRisk(args)
	case "http", "https", "xh":
		return !httpCommandHighRisk(args)
	case "sed", "gofmt", "goimports", "rustfmt", "prettier", "biome", "eslint", "black", "ruff",
		"cp", "mv", "mkdir", "touch", "ln":
		// These are deterministic workspace-editing families. The ordinary
		// permission/sandbox layer still owns path confinement.
		return true
	case "npm":
		return containsAny(args, "install", "add", "remove", "uninstall", "update", "dedupe") && !hasGlobalFlag(args)
	case "pnpm":
		return containsAny(args, "install", "add", "remove", "update", "dedupe", "import") && !hasGlobalFlag(args)
	case "yarn":
		return containsAny(args, "install", "add", "remove", "up", "upgrade", "dedupe") && !hasGlobalFlag(args) && !containsAny(args, "global")
	case "go":
		return containsAny(args, "get", "mod", "work", "fmt", "build", "test") && !containsAny(args, "install", "clean")
	case "cargo":
		return containsAny(args, "add", "remove", "update", "build", "check", "test", "fmt", "fix", "clippy")
	case "composer":
		return containsAny(args, "require", "remove", "update", "install", "dump-autoload") && !hasGlobalFlag(args) && !containsAny(args, "global")
	case "poetry":
		return containsAny(args, "add", "remove", "install", "update", "lock", "sync")
	case "uv":
		return containsAny(args, "add", "remove", "sync", "lock")
	case "dotnet":
		return containsAny(args, "add", "remove", "restore", "build", "test", "format") && !hasGlobalFlag(args)
	}
	// A coarse host mutation bit must not turn a statically proven read-only
	// diagnostic into a confirmation. Destructive argument forms were rejected
	// before reaching this point.
	if !shellsafe.ClassifyBash(strings.Join(fields, " ")).AnyMutation() {
		return true
	}
	return false
}

func gitCommandKnownSafe(args []string) bool {
	sub := gitSubcommand(args)
	switch sub {
	case "add", "commit", "status", "diff", "log", "show", "rev-parse", "rev-list", "describe",
		"blame", "grep", "ls-files", "ls-tree", "cat-file", "for-each-ref", "name-rev", "shortlog",
		"whatchanged", "cherry", "fetch", "pull", "clone", "init", "merge", "rebase", "cherry-pick",
		"revert", "apply", "am", "switch", "reset", "branch", "tag", "stash", "restore", "worktree",
		"remote", "config", "reflog":
		return true
	default:
		return false
	}
}

func gitSubcommand(args []string) string {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-c" || arg == "--git-dir" || arg == "--work-tree" || arg == "--namespace":
			i++
		case strings.HasPrefix(arg, "-"):
			continue
		default:
			return strings.ToLower(arg)
		}
	}
	return ""
}
