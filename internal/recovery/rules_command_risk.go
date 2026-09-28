package recovery

import (
	"path/filepath"
	"strings"

	"reasonix/internal/shellparse"
)

func bashRiskBoundary(command string, enforceMutationAllowlist bool) riskBoundary {
	command = strings.TrimSpace(command)
	if command == "" {
		return riskBoundary{highRisk: true}
	}
	lower := strings.ToLower(command)
	// Fast markers cover destructive redirection and commands whose static
	// tokenization may be obscured by shell punctuation. Project-local installs
	// and version-controlled configuration edits intentionally stay automatic.
	riskMarkers := []string{
		"rm -", "rmdir", "unlink ", "shred ",
		"git reset --hard", "git clean",
		"chmod ", "chown ", "mkfs", "dd if=",
		"> /", ">> /",
	}
	for _, m := range riskMarkers {
		if strings.Contains(lower, m) {
			return riskBoundary{highRisk: true}
		}
	}
	segments, _, ok := shellparse.SplitTopLevel(command)
	if !ok {
		return riskBoundary{highRisk: true}
	}
	var grant taskGrantBoundary
	for _, segment := range segments {
		fields, malformed := shellparse.StaticFields(segment)
		if malformed != "" || len(fields) == 0 {
			return riskBoundary{highRisk: true}
		}
		if commandFieldsHighRisk(fields) {
			if len(segments) == 1 {
				grant = commandFieldsTaskGrantBoundary(fields)
			}
			return riskBoundary{
				highRisk:         true,
				taskGrantKey:     grant.key,
				taskGrantDisplay: grant.display,
			}
		}
		if enforceMutationAllowlist && !commandFieldsKnownSafeMutation(fields) {
			// The host knows this call can mutate, but this policy cannot prove it is
			// a reversible workspace operation. Fail closed instead of letting an
			// unlisted shell or PowerShell command silently widen Auto.
			return riskBoundary{highRisk: true}
		}
	}
	return riskBoundary{}
}

func commandFieldsHighRisk(fields []string) bool {
	if len(fields) == 0 {
		return true
	}
	base := strings.ToLower(filepath.Base(fields[0]))
	rawArgs := fields[1:]
	args := lowerFields(rawArgs)
	switch base {
	case "sudo", "doas", "pkexec", "xargs":
		// Privilege escalation and dynamic command dispatch are high risk even
		// when the wrapped command itself is not statically recoverable here.
		return true
	case "env":
		wrapped, ok := unwrapEnvCommand(rawArgs)
		return !ok || commandFieldsHighRisk(wrapped)
	case "command":
		wrapped, ok := unwrapCommandBuiltin(rawArgs)
		return !ok || (len(wrapped) > 0 && commandFieldsHighRisk(wrapped))
	case "nohup":
		return commandFieldsHighRisk(trimLeadingOptions(rawArgs))
	case "rm", "rmdir", "unlink", "shred", "dd", "mkfs", "chmod", "chown",
		"docker", "kubectl", "terraform":
		return true
	case "remove-item", "clear-content", "set-content", "add-content", "move-item", "copy-item",
		"new-item", "rename-item", "invoke-restmethod", "invoke-webrequest", "start-process",
		"stop-process", "restart-computer", "stop-computer", "format-volume", "clear-disk",
		"initialize-disk", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "cmd", "cmd.exe",
		"del", "erase", "rd", "format", "diskpart":
		// Reasonix runs the bash tool through PowerShell on Windows. Bash AST still
		// gives us useful static words for simple native commands, but these verbs
		// are not reversible workspace operations and must never fall through.
		return true
	case "find":
		return containsAny(args, "-delete", "-exec", "-execdir", "-ok", "-okdir")
	case "git":
		return gitCommandHighRisk(args)
	case "curl":
		return curlCommandHighRisk(rawArgs)
	case "wget":
		return wgetCommandHighRisk(args)
	case "gh":
		return ghCommandHighRisk(args)
	case "http", "https", "xh":
		return httpCommandHighRisk(args)
	case "aws", "gcloud", "az", "oci", "doctl", "heroku", "vercel", "netlify",
		"flyctl", "railway", "firebase", "wrangler", "cloudflared", "ssh", "scp",
		"sftp", "rsync", "psql", "mysql", "redis-cli", "mongosh":
		// These tools can mutate remote services or hosts, and their command
		// languages are too broad for this layer to prove a call read-only. Keep
		// them behind Auto's explicit external-action boundary.
		return true
	case "npm":
		return containsAny(args, "publish", "unpublish", "link", "unlink", "config") || hasGlobalFlag(args)
	case "pnpm":
		return containsAny(args, "publish", "deploy", "link", "unlink", "setup") || hasGlobalFlag(args) ||
			(containsAny(args, "env") && containsAny(args, "use", "remove") && containsAny(args, "--global"))
	case "yarn":
		return containsAny(args, "publish", "link", "unlink") || hasGlobalFlag(args) ||
			(containsAny(args, "global") && containsAny(args, "add", "remove", "upgrade"))
	case "pip", "pip3", "pipx":
		// Python installers mutate the active interpreter environment unless the
		// host can prove a project-local target, which this command layer cannot.
		return containsAny(args, "install", "uninstall", "inject", "upgrade")
	case "brew", "apt", "apt-get", "dnf", "yum", "apk", "pacman":
		return containsAny(args, "install", "add", "remove", "uninstall", "upgrade", "update")
	case "go":
		if containsAny(args, "install", "clean") {
			return true
		}
		if containsAny(args, "env") && containsAny(args, "-w", "-u") {
			return true
		}
		return false
	case "cargo":
		return containsAny(args, "install", "uninstall", "publish", "yank", "login", "logout")
	case "composer":
		return (containsAny(args, "config") && hasGlobalFlag(args)) ||
			(containsAny(args, "global") && containsAny(args, "require", "remove", "update", "install", "config", "exec"))
	case "poetry":
		return containsAny(args, "publish", "config", "self")
	case "uv":
		return containsAny(args, "publish", "tool")
	case "dotnet":
		return containsAny(args, "push", "delete") || hasGlobalFlag(args)
	case "gem", "bundle", "bundler":
		return containsAny(args, "install", "uninstall", "update", "add", "remove", "push", "yank", "publish")
	}
	return false
}
func gitCommandHighRisk(args []string) bool {
	if containsAny(args, "push", "clean", "prune", "filter-branch", "filter-repo") {
		return true
	}
	if containsAny(args, "gc") {
		return true
	}
	if containsAny(args, "reset") && containsAny(args, "--hard", "--merge", "--keep") {
		return true
	}
	if containsAny(args, "checkout") {
		// `git checkout .` and `git checkout path` discard worktree contents even
		// without -f/--. Prefer the unambiguous switch command for safe branch
		// changes; keep all checkout forms behind confirmation.
		return true
	}
	if containsAny(args, "switch") && containsAny(args, "--discard-changes") {
		return true
	}
	if containsAny(args, "restore") && (!containsAny(args, "--staged") || containsAny(args, "--worktree")) {
		// Restoring only the index is reversible from the worktree; restoring the
		// worktree can discard the user's uncommitted contents.
		return true
	}
	if containsAny(args, "branch") && containsAny(args, "-d", "--delete", "-f", "--force") {
		return true
	}
	if containsAny(args, "tag") && containsAny(args, "-d", "--delete", "-f", "--force") {
		return true
	}
	if containsAny(args, "stash") && containsAny(args, "clear", "drop") {
		return true
	}
	if containsAny(args, "reflog") && containsAny(args, "expire", "delete") {
		return true
	}
	if containsAny(args, "worktree") && containsAny(args, "remove", "prune") {
		return true
	}
	if containsAny(args, "update-ref") && containsAny(args, "-d", "--delete", "--stdin") {
		return true
	}
	if containsAny(args, "remote") && containsAny(args, "add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update") {
		return true
	}
	// Repository-local git config is not version-controlled workspace config and
	// can redirect hooks, credentials, or future pushes. Read-only config probes
	// are the only fast path.
	if containsAny(args, "config") {
		if containsAny(args, "--unset", "--unset-all", "--add", "--replace-all", "--rename-section", "--remove-section", "--edit", "-e") {
			return true
		}
		return !containsAny(args, "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--name-only")
	}
	return false
}
func curlCommandHighRisk(args []string) bool {
	method := ""
	for i, arg := range args {
		lower := strings.ToLower(arg)
		switch {
		case arg == "-X" || lower == "--request":
			if i+1 >= len(args) {
				return true
			}
			method = strings.ToUpper(args[i+1])
		case strings.HasPrefix(arg, "-X") && len(arg) > 2:
			method = strings.ToUpper(arg[2:])
		case strings.HasPrefix(lower, "--request="):
			method = strings.ToUpper(arg[len("--request="):])
		case arg == "-d" || lower == "--data" || lower == "--data-ascii" || lower == "--data-binary" ||
			lower == "--data-raw" || lower == "--data-urlencode" || lower == "--json" ||
			arg == "-F" || lower == "--form" || lower == "--form-string" ||
			arg == "-T" || lower == "--upload-file":
			return true
		case strings.HasPrefix(arg, "-d") && len(arg) > 2,
			strings.HasPrefix(arg, "-F") && len(arg) > 2,
			strings.HasPrefix(arg, "-T") && len(arg) > 2,
			strings.HasPrefix(lower, "--data="), strings.HasPrefix(lower, "--data-ascii="),
			strings.HasPrefix(lower, "--data-binary="), strings.HasPrefix(lower, "--data-raw="),
			strings.HasPrefix(lower, "--data-urlencode="), strings.HasPrefix(lower, "--json="),
			strings.HasPrefix(lower, "--form="), strings.HasPrefix(lower, "--form-string="),
			strings.HasPrefix(lower, "--upload-file="):
			return true
		}
	}
	return method != "" && method != "GET" && method != "HEAD" && method != "OPTIONS"
}
func wgetCommandHighRisk(args []string) bool {
	for i, arg := range args {
		switch {
		case arg == "--post-data" || arg == "--post-file" || strings.HasPrefix(arg, "--post-data=") || strings.HasPrefix(arg, "--post-file="):
			return true
		case arg == "--method":
			if i+1 >= len(args) {
				return true
			}
			method := strings.ToUpper(args[i+1])
			return method != "GET" && method != "HEAD" && method != "OPTIONS"
		case strings.HasPrefix(arg, "--method="):
			method := strings.ToUpper(strings.TrimPrefix(arg, "--method="))
			return method != "GET" && method != "HEAD" && method != "OPTIONS"
		}
	}
	return false
}
func ghCommandHighRisk(args []string) bool {
	group, rest := ghCommandGroup(args)
	switch group {
	case "api":
		return ghAPICommandHighRisk(rest)
	case "pr":
		return containsAny(rest, "create", "close", "comment", "edit", "merge", "ready", "reopen", "review")
	case "issue":
		return containsAny(rest, "create", "close", "comment", "delete", "edit", "reopen", "transfer", "pin", "unpin", "lock", "unlock")
	case "repo":
		return containsAny(rest, "create", "delete", "archive", "edit", "fork", "rename", "sync")
	case "release":
		return containsAny(rest, "create", "delete", "edit", "upload")
	case "workflow":
		return containsAny(rest, "run", "enable", "disable")
	case "run":
		return containsAny(rest, "cancel", "delete", "rerun")
	case "secret", "variable":
		return containsAny(rest, "set", "delete")
	case "label":
		return containsAny(rest, "create", "delete", "edit", "clone")
	case "gist":
		return containsAny(rest, "create", "delete", "edit")
	case "ssh-key", "gpg-key":
		return containsAny(rest, "add", "delete")
	case "cache":
		return containsAny(rest, "delete")
	case "auth":
		return containsAny(rest, "login", "logout", "refresh", "setup-git", "switch")
	case "alias":
		return containsAny(rest, "set", "delete")
	case "config":
		return containsAny(rest, "set", "clear")
	case "extension":
		return containsAny(rest, "install", "remove", "upgrade", "create")
	case "project", "codespace":
		return !containsAny(rest, "list", "view", "status", "logs")
	}
	return false
}
func ghCommandGroup(args []string) (string, []string) {
	groups := map[string]struct{}{
		"api": {}, "pr": {}, "issue": {}, "repo": {}, "release": {}, "workflow": {}, "run": {},
		"secret": {}, "variable": {}, "label": {}, "gist": {}, "ssh-key": {}, "gpg-key": {},
		"cache": {}, "auth": {}, "alias": {}, "config": {}, "extension": {}, "project": {}, "codespace": {},
	}
	for i, arg := range args {
		if _, ok := groups[arg]; ok {
			return arg, args[i+1:]
		}
	}
	return "", nil
}
func ghAPICommandHighRisk(args []string) bool {
	method := ""
	hasBody := false
	for i, arg := range args {
		switch {
		case arg == "-x" || arg == "--method":
			if i+1 >= len(args) {
				return true
			}
			method = strings.ToUpper(args[i+1])
		case strings.HasPrefix(arg, "-x") && len(arg) > 2:
			method = strings.ToUpper(arg[2:])
		case strings.HasPrefix(arg, "--method="):
			method = strings.ToUpper(strings.TrimPrefix(arg, "--method="))
		case arg == "-f" || arg == "--raw-field" || arg == "--field" || arg == "--input":
			hasBody = true
		case strings.HasPrefix(arg, "-f") && len(arg) > 2:
			hasBody = true
		case strings.HasPrefix(arg, "--raw-field=") || strings.HasPrefix(arg, "--field=") || strings.HasPrefix(arg, "--input="):
			hasBody = true
		}
	}
	if method == "" {
		return hasBody // gh api switches its default from GET to POST when fields/input are supplied.
	}
	return method != "GET" && method != "HEAD" && method != "OPTIONS"
}
func httpCommandHighRisk(args []string) bool {
	for _, arg := range args {
		upper := strings.ToUpper(arg)
		switch upper {
		case "POST", "PUT", "PATCH", "DELETE", "CONNECT", "PURGE", "LOCK", "UNLOCK":
			return true
		}
		lower := strings.ToLower(arg)
		if lower == "--raw" || lower == "--form" || strings.HasPrefix(lower, "--raw=") {
			return true
		}
		if strings.HasPrefix(arg, "-") || strings.Contains(arg, "://") {
			continue
		}
		if strings.Contains(arg, "==") && !strings.Contains(arg, ":=") && !strings.Contains(arg, "@") {
			continue // HTTPie query-string item; remains a GET by default.
		}
		// HTTPie-style request items with a value or file body implicitly switch
		// the default method from GET to a mutating request.
		if strings.Contains(arg, "=") || strings.Contains(arg, "@") {
			return true
		}
	}
	return false
}
