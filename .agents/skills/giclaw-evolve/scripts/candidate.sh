#!/usr/bin/env bash
# candidate.sh <skill-id> <candidate-SKILL.md> [--skip-validate]
#
# Install a proposed SKILL.md as the ~/.giclaw/skills override so the next run
# exercises the candidate instead of the committed file.
#
# Safety:
#   * validates with giclaw's real loader before anything is installed
#   * snapshots the override it is about to replace (if any)
#   * keeps an immutable copy under evolve/candidates/<id>/<stamp>/
#   * prints the committed -> candidate diff to stderr
#
# stdout: JSON { skillId, candidateFile, installedOverride, recordedCopy, validated }
# stderr: progress and the diff
# exit:   0 ok | 1 rejected by loader | 2 bad usage

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then show_help "$0"; exit 0; fi

skill="${1:-}"
candidate="${2:-}"
skip_validate=false
[[ "${3:-}" == "--skip-validate" ]] && skip_validate=true
require_skill_id "$skill"
[[ -n "$candidate" ]] || die "usage: candidate.sh <skill-id> <candidate-SKILL.md> [--skip-validate]" 2
[[ -f "$candidate" ]] || die "candidate file not found: $candidate" 2
init_workspace

candidate="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"

if [[ "$skip_validate" == false ]]; then
  staging="$(mktemp -d)"
  trap 'rm -rf "$staging"' EXIT
  mkdir -p "$staging/$skill"
  cp "$candidate" "$staging/$skill/SKILL.md"
  log "validating candidate with giclaw's loader..."
  if ! ( cd "$REPO_ROOT" && pnpm exec tsx "$SCRIPT_DIR/validate-skill.ts" "$staging" >&2 ); then
    die "candidate rejected by loader; nothing was installed"
  fi
fi

stamp="$(utc_stamp)"
record="$EVOLVE_HOME/candidates/$skill/$stamp"
mkdir -p "$record"
cp "$candidate" "$record/SKILL.md"
chmod -R go-rwx "$record" 2>/dev/null || true

existing="$(override_skill_file "$skill")"
if [[ -f "$existing" ]]; then
  snapshot_skill "$skill" pre-candidate override >/dev/null
fi

mkdir -p "$(dirname "$existing")"
cp "$candidate" "$existing"
chmod 600 "$existing" 2>/dev/null || true

log "candidate installed as override: $existing"
log "immutable copy: $record/SKILL.md"
if [[ -f "$(repo_skill_file "$skill")" ]]; then
  log "diff (committed -> candidate):"
  diff -u "$(repo_skill_file "$skill")" "$candidate" >&2 || true
fi

printf '{"skillId":"%s","candidateFile":"%s","installedOverride":"%s","recordedCopy":"%s","validated":%s}\n' \
  "$skill" "$candidate" "$existing" "$record/SKILL.md" "$([[ "$skip_validate" == true ]] && echo false || echo true)"
