#!/usr/bin/env bash
# promote.sh <skill-id>
#
# Accept the currently installed candidate: copy ~/.giclaw/skills/<id>/SKILL.md
# over the committed repo skills/<id>/SKILL.md, snapshot the committed file it
# replaces, then remove the override so the repo becomes canonical again.
#
# This is the ONLY script that mutates committed files. Run it after a real,
# visible-browser run proved the candidate.
#
# stdout: JSON { skillId, promotedTo, removedOverride, snapshot }
# stderr: progress and the resulting git diff
# exit:   0 ok | 1 no installed candidate | 2 bad usage

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then show_help "$0"; exit 0; fi

skill="${1:-}"
require_skill_id "$skill"
init_workspace

override="$(override_skill_file "$skill")"
[[ -f "$override" ]] || die "no installed candidate for \"$skill\" ($override)" 1

dest="$(repo_skill_file "$skill")"
snap=""
if [[ -f "$dest" ]]; then
  snap="$(snapshot_skill "$skill" promote repo)"
  log "snapshotted committed file -> $snap"
fi

mkdir -p "$(dirname "$dest")"
cp "$override" "$dest"
rm -f "$override"
rmdir "$(dirname "$override")" 2>/dev/null || true

log "promoted candidate -> $dest"
log "removed override: $override"
if command -v git >/dev/null 2>&1; then
  ( cd "$REPO_ROOT" && git --no-pager diff -- "$dest" >&2 || true )
fi

printf '{"skillId":"%s","promotedTo":"%s","removedOverride":"%s","snapshot":"%s"}\n' \
  "$skill" "$dest" "$override" "$snap"
