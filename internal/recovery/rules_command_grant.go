package recovery

import (
	"path/filepath"
	"strings"
)

type taskGrantBoundary struct {
	key     string
	display string
}

func commandFieldsTaskGrantBoundary(fields []string) taskGrantBoundary {
	if len(fields) == 0 {
		return taskGrantBoundary{}
	}
	base := strings.ToLower(filepath.Base(fields[0]))
	rawArgs := fields[1:]
	switch base {
	case "env":
		wrapped, ok := unwrapEnvCommand(rawArgs)
		if ok {
			return commandFieldsTaskGrantBoundary(wrapped)
		}
	case "command":
		wrapped, ok := unwrapCommandBuiltin(rawArgs)
		if ok {
			return commandFieldsTaskGrantBoundary(wrapped)
		}
	case "git":
		return gitPushTaskGrantBoundary(rawArgs)
	case "gh":
		return ghTaskGrantBoundary(rawArgs)
	}
	return taskGrantBoundary{}
}

func gitPushTaskGrantBoundary(args []string) taskGrantBoundary {
	lower := lowerFields(args)
	if gitSubcommand(lower) != "push" || containsAny(lower,
		"-f", "--force", "--mirror", "--delete", "--prune", "--all", "--tags", "--follow-tags",
	) {
		return taskGrantBoundary{}
	}
	for _, arg := range lower {
		if strings.HasPrefix(arg, "--force") || strings.HasPrefix(arg, ":") || strings.HasPrefix(arg, "+") {
			return taskGrantBoundary{}
		}
	}
	pushAt := -1
	for i, arg := range lower {
		if arg == "push" {
			pushAt = i
			break
		}
	}
	if pushAt != 0 {
		// Global options such as -C/--git-dir can redirect an otherwise identical
		// command to another repository. Keep those forms one-shot because the
		// displayed remote alias would no longer identify the same target context.
		return taskGrantBoundary{}
	}
	var positionals []string
	for i := pushAt + 1; i < len(args); i++ {
		arg := lower[i]
		switch arg {
		case "-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "--progress", "--no-progress":
			continue
		}
		if strings.HasPrefix(arg, "-") {
			// Behavior-changing and unknown push options are deliberately one-shot.
			// In particular, push-option/receive-pack/no-verify must not inherit a
			// grant issued for an ordinary push to the same ref.
			return taskGrantBoundary{}
		}
		positionals = append(positionals, strings.TrimSpace(args[i]))
	}
	// A reusable grant needs both an explicit remote and exactly one explicit
	// refspec. Bare `git push` depends on mutable branch/upstream configuration.
	if len(positionals) != 2 {
		return taskGrantBoundary{}
	}
	remote, refspec := positionals[0], positionals[1]
	if remote == "" || refspec == "" || strings.Contains(refspec, "*") {
		return taskGrantBoundary{}
	}
	target := refspec
	if before, after, ok := strings.Cut(refspec, ":"); ok {
		if strings.TrimSpace(before) == "" || strings.TrimSpace(after) == "" {
			return taskGrantBoundary{}
		}
		target = strings.TrimSpace(after)
	}
	if target == "HEAD" || target == "@" {
		return taskGrantBoundary{}
	}
	return taskGrantBoundary{
		key:     "bash:git.push:" + CallFingerprint("git.push", remote, target, nil),
		display: "git push " + remote + " → " + target,
	}
}

func ghTaskGrantBoundary(args []string) taskGrantBoundary {
	lower := lowerFields(args)
	group, rest := ghCommandGroup(lower)
	if len(rest) == 0 {
		return taskGrantBoundary{}
	}
	verb := rest[0]
	if (group != "pr" && group != "issue") || verb != "comment" {
		return taskGrantBoundary{}
	}
	if containsAny(lower, "--edit-last", "--delete-last") {
		return taskGrantBoundary{}
	}
	repo := "current"
	for i, arg := range lower {
		switch {
		case (arg == "--repo" || arg == "-r") && i+1 < len(args):
			repo = args[i+1]
		case strings.HasPrefix(arg, "--repo="):
			repo = strings.TrimSpace(args[i][len("--repo="):])
		case strings.HasPrefix(arg, "-r") && len(arg) > 2:
			repo = strings.TrimSpace(args[i][2:])
		}
	}
	target := "current"
	if len(rest) > 1 && !strings.HasPrefix(rest[1], "-") {
		target = rest[1]
	} else if len(rest) > 1 {
		// Options before a positional target are legal in gh. Avoid guessing
		// through their values; a form the host cannot scope exactly stays
		// one-shot rather than sharing an accidentally broad "current" grant.
		return taskGrantBoundary{}
	}
	// "current" can change after a checkout or branch switch. Require an
	// explicit PR/issue target before offering a reusable external-write grant.
	if target == "current" {
		return taskGrantBoundary{}
	}
	repo = strings.TrimSpace(repo)
	target = strings.TrimSpace(target)
	display := "gh " + group + " comment " + target
	if repo != "current" {
		display += " --repo " + repo
	}
	return taskGrantBoundary{
		key:     "bash:gh." + group + ".comment:" + CallFingerprint("gh."+group+".comment", repo, target, nil),
		display: display,
	}
}
