#!/usr/bin/env bash
# Behaviour tests for update-versions-index.sh.
#
# The catalog's order is what the update panel shows and what catalogfilter
# counts as "newest", so the release-over-pre-release rule is asserted here
# rather than left to the eye: a shipped release must outrank its own betas.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
script="$repo_root/scripts/update-versions-index.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/reasonix-versions-index-test.XXXXXX")"
cleanup() {
	case "$test_root" in
	*/reasonix-versions-index-test.*) rm -rf -- "$test_root" ;;
	*) echo "refusing to clean unexpected test directory: $test_root" >&2 ;;
	esac
}
trap cleanup EXIT

add() { # <existing|-> <version> <channel>
	"$script" "$1" "$2" "$2" "$3" "2026-10-16T00:00:00Z"
}

# jq on Windows writes CRLF; strip it so these assertions compare values, not
# line endings (on the Linux CI runner the filter is a no-op).
jqr() { jq -r "$@" | tr -d '\r'; }

versions() { jqr '.versions[].version' "$1"; }

# Build a catalog the way releases would: two betas, then the release they
# belong to, over an older release.
catalog="$test_root/catalog.json"
add - "v1.38.53" stable >"$catalog"
add "$catalog" "v1.38.54-beta.1" beta >"$catalog.next"
add "$catalog.next" "v1.38.54-beta.2" beta >"$catalog.next2"
add "$catalog.next2" "v1.38.54" stable >"$catalog"

want=$'v1.38.54\nv1.38.54-beta.2\nv1.38.54-beta.1\nv1.38.53'
got="$(versions "$catalog")"
[ "$got" = "$want" ] || {
	echo "ordering: got" >&2
	printf '%s\n' "$got" >&2
	echo "want" >&2
	printf '%s\n' "$want" >&2
	exit 1
}

# Pre-releases number numerically, not as strings (beta.11 > beta.9). The
# output goes to a different path first: a plain redirect would truncate the
# index before the script read it.
add - "v1.38.55-beta.9" beta >"$test_root/pre.json"
add "$test_root/pre.json" "v1.38.55-beta.11" beta >"$test_root/pre.next"
mv "$test_root/pre.next" "$test_root/pre.json"
[ "$(versions "$test_root/pre.json" | head -n 1)" = "v1.38.55-beta.11" ] ||
	{ echo "pre-release numbering is not numeric" >&2; exit 1; }

# Rerunning a release must not duplicate or reorder its entry.
add "$catalog" "v1.38.54" stable >"$catalog.rerun"
[ "$(versions "$catalog.rerun")" = "$want" ] ||
	{ echo "rerun changed the catalog" >&2; versions "$catalog.rerun" >&2; exit 1; }

# Channel survives, and an entry points at its own version's manifest.
[ "$(jqr '.versions[] | select(.version == "v1.38.54-beta.2") | .channel' "$catalog")" = "beta" ] ||
	{ echo "beta channel lost" >&2; exit 1; }
[ "$(jqr '.versions[] | select(.version == "v1.38.54") | .manifest' "$catalog")" = \
	"https://github.com/keeyangyy/DeepSeek-Reasonix/releases/download/v1.38.54/latest.json" ] ||
	{ echo "manifest URL is not the version's own release" >&2; exit 1; }

# keep trims to the newest N entries after ordering.
"$script" "$catalog" "v1.38.56" "v1.38.56" stable "2026-10-16T01:00:00Z" 2 >"$test_root/keep.json"
[ "$(versions "$test_root/keep.json" | paste -sd, -)" = "v1.38.56,v1.38.54" ] ||
	{ echo "keep did not retain the newest two" >&2; versions "$test_root/keep.json" >&2; exit 1; }

# A withdrawn version is never listed again, even by its own rerun.
jq '.withdrawn = [{"version": "v1.38.53"}]' "$catalog" >"$test_root/withdrawn.json"
"$script" "$test_root/withdrawn.json" "v1.38.53" "v1.38.53" stable "2026-10-16T02:00:00Z" >"$test_root/after.json"
versions "$test_root/after.json" | grep -qx "v1.38.53" &&
	{ echo "withdrawn version came back" >&2; exit 1; }

# Bad input fails loudly instead of writing a broken catalog.
if "$script" - "v1.38.54" "v1.38.54" nightly "2026-10-16T00:00:00Z" >/dev/null 2>&1; then
	echo "unknown channel was accepted" >&2
	exit 1
fi

echo "update-versions-index: all assertions passed"
