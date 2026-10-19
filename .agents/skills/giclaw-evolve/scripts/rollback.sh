#!/usr/bin/env bash
# rollback.sh <skill-id> [snapshot-dir]
#
# Reject the current candidate and return to the committed, known-good SKILL.md.
#
# With no snapshot argument this simply removes the ~/.giclaw/skills override so
# the repo file is authoritative again. candidate.sh never modifies the repo, so
# removing the override IS a complete rollback of a candidate.
#
# Pass an explicit snapshot directory to additionally restore the committed file
# from it (for example to undo a promote.sh). Snapshots are never auto-selected,
# because a "loop"/candidate snapshot may itself contain candidate content.
#
# stdout: JSON { skillId, restoredFrom, removedOverride }
# stderr: progress
# exit:   0 ok | 1 nothing to roll back | 2 bad usage

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then show_help "$0"; exit 0; fi

skill="${1:-}"
snapshot="${2:-}"
require_skill_id "$skill"
init_workspace

dest="$(repo_skill_file "$skill")"
restored=""

if [[ -n "$snapshot" ]]; then
  [[ -f "$snapshot/SKILL.md" ]] || die "snapshot has no SKILL.md: $snapshot" 1
  mkdir -p "$(dirname "$dest")"
  cp "$snapshot/SKILL.md" "$dest"
  restored="$snapshot"
  log "restored committed file from snapshot: $snapshot -> $dest"
fi

override="$(override_skill_file "$skill")"
removed=false
if [[ -f "$override" ]]; then
  rm -f "$override"
  rmdir "$(dirname "$override")" 2>/dev/null || true
  removed=true
  log "removed override: $override"
fi

if [[ -z "$restored" && "$removed" == false ]]; then
  if [[ -f "$dest" ]]; then
    log "no candidate installed and no snapshot given; $skill is already at the committed revision"
  else
    die "nothing to roll back for \"$skill\" (no override, no snapshot, no committed file)" 1
  fi
fi

log "rollback of $skill complete"
printf '{"skillId":"%s","restoredFrom":"%s","removedOverride":%s}\n' "$skill" "$restored" "$removed"
