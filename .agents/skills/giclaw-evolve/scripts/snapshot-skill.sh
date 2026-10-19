#!/usr/bin/env bash
# snapshot-skill.sh <skill-id> [label] [source]
#
# Copy a SKILL.md (and sibling assets) into the private evolution workspace
# before you edit it, so every generation can be traced back and rolled back.
#
# source: active (default) | repo | override | explicit path to a SKILL.md
#
# stdout: absolute snapshot directory
# stderr: progress
# exit:   0 ok | 1 no source | 2 bad usage

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then show_help "$0"; exit 0; fi

skill="${1:-}"
label="${2:-manual}"
source_kind="${3:-repo}"
require_skill_id "$skill"
init_workspace

dest="$(snapshot_skill "$skill" "$label" "$source_kind")"
log "snapshot of $skill ($source_kind) -> $dest"
printf '%s\n' "$dest"
