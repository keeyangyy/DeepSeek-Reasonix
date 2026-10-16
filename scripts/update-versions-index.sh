#!/usr/bin/env bash
# Merge one published release into this line's version catalog and print it.
#
# The catalog is what the update panel lists: it names which versions were ever
# public and where each one's immutable manifest lives. It deliberately does NOT
# copy asset URLs or signatures — an entry points at <tag>/latest.json, so
# installing an older version verifies through exactly the same path as a
# forward update, and there is never a second source of truth for what an
# artifact should be.
#
# Merging is additive: an existing entry for the same version wins, so a rerun
# or a recovery publication can never rewrite history. Usage:
#
#   update-versions-index.sh <existing-index|-> <version> <tag> <channel> <published-at> [keep] [notes-url]
#
# channel is decided by the caller (the release workflow): "stable" for
# vX.Y.Z and "beta" for vX.Y.Z-beta.N. catalogfilter reads that field to decide
# which entries the panel shows, so it must be right.
#
# notes-url names a release-notes object to link from the entry. It is optional;
# without it the entry carries no notes field, which is how a version with no
# notes reads.
set -euo pipefail

if [ "$#" -lt 5 ] || [ "$#" -gt 7 ]; then
  echo "usage: $0 <existing-index|-> <version> <tag> <channel> <published-at> [keep] [notes-url]" >&2
  exit 2
fi

existing="$1"
version="$2"
tag="$3"
channel="$4"
published_at="$5"
keep="${6:-20}"
notes="${7:-}"

# This line publishes on its own GitHub releases; the catalog entry must point
# at the manifest that lives there, not at another line's CDN.
manifest_base="${MANIFEST_BASE:-https://github.com/keeyangyy/DeepSeek-Reasonix/releases/download}"

for value in "$version" "$tag" "$channel" "$published_at"; do
  if [ -z "$value" ]; then
    echo "::error::versions index requires version, tag, channel and published-at" >&2
    exit 1
  fi
done
case "$channel" in
  stable|beta) ;;
  *)
    echo "::error::channel must be stable or beta, got $channel" >&2
    exit 1
    ;;
esac
case "$notes" in
  ''|https://*) ;;
  *)
    echo "::error::notes-url must be empty or an https URL, got $notes" >&2
    exit 1
    ;;
esac
case "$keep" in
  ''|*[!0-9]*)
    echo "::error::keep must be a positive integer, got $keep" >&2
    exit 1
    ;;
esac
if [ "$keep" -lt 1 ]; then
  echo "::error::keep must be at least 1" >&2
  exit 1
fi

base="{\"schemaVersion\":1,\"versions\":[]}"
if [ "$existing" != "-" ]; then
  if [ ! -f "$existing" ]; then
    echo "::error::existing index $existing not found" >&2
    exit 1
  fi
  # A corrupt index must fail the release rather than silently reset the list:
  # losing history is exactly the failure this file exists to prevent.
  if ! jq -e '.versions | type == "array"' "$existing" >/dev/null; then
    echo "::error::existing index $existing is not a versions index" >&2
    exit 1
  fi
  base="$(cat "$existing")"
fi

printf '%s' "$base" | jq \
  --arg version "$version" \
  --arg tag "$tag" \
  --arg channel "$channel" \
  --arg publishedAt "$published_at" \
  --arg manifestBase "$manifest_base" \
  --arg notes "$notes" \
  --argjson keep "$keep" '
  def semver: [splits("[.-]")] | map(select(test("^[0-9]+$")) | tonumber);
  ([.withdrawn // [] | .[].version | ltrimstr("v")]) as $gone
  | (.withdrawn // []) as $withdrawn
  | {
    schemaVersion: 1,
    updatedAt: $publishedAt,
    versions: (
      (.versions // [])
      + [{
          version: $version,
          tag: $tag,
          channel: $channel,
          publishedAt: $publishedAt,
          manifest: ($manifestBase + "/" + $tag + "/latest.json"),
        } + (if $notes == "" then {} else {notes: $notes} end)]
      # Existing entries win: unique_by keeps the first of each group, so a
      # rerun cannot rewrite what was already published under that version.
      | unique_by(.version)
      # A withdrawn release is never listed again, even by a rerun of its own
      # publication.
      | map(select((.version | ltrimstr("v")) as $v | $gone | index($v) | not))
      | sort_by(.version | semver)
      | reverse
      | .[0:$keep]
    ),
  } + (if ($withdrawn | length) == 0 then {} else {withdrawn: $withdrawn} end)
'