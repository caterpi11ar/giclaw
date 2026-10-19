#!/usr/bin/env bash
# loop.sh <skill-id> [--headless] [--dry-only]
#
# One full iteration of the development loop against whatever SKILL.md is
# currently active (candidate override if installed, otherwise committed):
#
#   1. snapshot the active file        (recoverable)
#   2. structural dry-run validation   (fast, offline, no browser)
#   3. real run through the pipeline   (visible by default)
#   4. evidence digest                 (transcript + screenshots)
#
# The script deliberately does NOT edit anything. After reading the digest, edit
# the candidate, install it with candidate.sh, and run loop.sh again. That tight
# edit -> validate -> run -> read cycle is the "develop while debugging while
# executing" contract.
#
# stdout: JSON { skillId, snapshot, validated, runExit }
# stderr: live logs and the evidence digest
# exit:   0 iteration completed | 1 validation failed | 2 bad usage

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then show_help "$0"; exit 0; fi

skill="${1:-}"
shift || true
require_skill_id "$skill"
init_workspace

headless_flag=(--no-headless)
dry_only=false
while (($#)); do
  case "$1" in
    --headless) headless_flag=(--headless) ;;
    --dry-only) dry_only=true ;;
    *) die "unknown option: $1 (try --help)" 2 ;;
  esac
  shift
done

log "iteration for $skill"
# Snapshot the committed, known-good file (never the candidate) so a rejected
# iteration has an unambiguous recovery point.
if [[ -f "$(repo_skill_file "$skill")" ]]; then
  snap="$(snapshot_skill "$skill" loop repo)"
else
  snap="$(snapshot_skill "$skill" loop active)"
fi
log "1/4 snapshot -> $snap"

log "2/4 dry-run validation"
set +e
"$SCRIPT_DIR/run-skill.sh" "$skill" "${headless_flag[@]}" --dry-run >/dev/null
validate_rc=$?
set -e
if [[ "$validate_rc" -ne 0 ]]; then
  printf '{"skillId":"%s","snapshot":"%s","validated":false,"runExit":null}\n' "$skill" "$snap"
  die "dry-run validation failed; fix the candidate before running" 1
fi
log "validation passed"

if [[ "$dry_only" == true ]]; then
  printf '{"skillId":"%s","snapshot":"%s","validated":true,"runExit":null}\n' "$skill" "$snap"
  log "stopping after validation (--dry-only)"
  exit 0
fi

log "3/4 real run"
set +e
"$SCRIPT_DIR/run-skill.sh" "$skill" "${headless_flag[@]}" >/dev/null
run_rc=$?
set -e

log "4/4 evidence digest"
"$SCRIPT_DIR/latest-run.sh" 120 >&2 || true

log "next: read the digest, propose a minimal patch, then"
log "      candidate.sh $skill <path/to/SKILL.md>"
log "      loop.sh $skill"
log "      on success: promote.sh $skill   |   on regression: rollback.sh $skill"

printf '{"skillId":"%s","snapshot":"%s","validated":true,"runExit":%s}\n' "$skill" "$snap" "$run_rc"
exit "$run_rc"
