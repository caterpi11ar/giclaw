#!/usr/bin/env bash
# run-skill.sh <skill-id> [--headless] [--no-headless] [--dry-run] [--verbose]
#
# Execute exactly one skill through the real giclaw pipeline. Default is the
# visible browser, because UI debugging is the point. The full log is tee'd into
# the private evolution workspace, then the evidence digest is printed.
#
# This script only runs; it never edits a file. Pair it with candidate.sh to
# test a proposed SKILL.md, and with latest-run.sh to re-read evidence.
#
# stdout: JSON { skillId, mode, exit, logFile } on the last line
# stderr: live giclaw log and the evidence digest
# exit:   the giclaw run's exit code

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then show_help "$0"; exit 0; fi

skill="${1:-}"
shift || true
require_skill_id "$skill"
init_workspace

headless=false
dry=false
verbose=()
while (($#)); do
  case "$1" in
    --headless) headless=true ;;
    --no-headless) headless=false ;;
    --dry-run) dry=true ;;
    --verbose|-v) verbose+=(--verbose) ;;
    *) die "unknown option: $1 (try --help)" 2 ;;
  esac
  shift
done

args=(run --tasks "$skill")
[[ "$headless" == true ]] && args+=(--headless) || args+=(--no-headless)
[[ "$dry" == true ]] && args+=(--dry-run)
if ((${#verbose[@]})); then args+=("${verbose[@]}"); fi

# Use the override when present so `candidate.sh` takes effect.
if [[ -f "$(override_skill_file "$skill")" ]]; then
  log "using candidate override: $(override_skill_file "$skill")"
else
  log "using committed skill: $(repo_skill_file "$skill")"
fi

log_file="$EVOLVE_HOME/runs/$(utc_stamp)-${skill}$([[ "$dry" == true ]] && echo '-dryrun').log"
log "running: giclaw ${args[*]}"
log "log: $log_file"

set +e
giclaw "${args[@]}" 2>&1 | tee "$log_file" >&2
status="${PIPESTATUS[0]}"
set -e
chmod 600 "$log_file" 2>/dev/null || true

mode="run"
if [[ "$dry" == true ]]; then
  mode="dry-run"
  log "dry-run exit=$status (structural validation only; no browser/model calls)"
else
  log "run exit=$status"
  node "$SCRIPT_DIR/summarize.mjs" "$STATE_FILE" "$TRANSCRIPTS_DIR" "$SCREENSHOT_DIR" 120 >&2 || true
fi

printf '{"skillId":"%s","mode":"%s","exit":%s,"logFile":"%s"}\n' "$skill" "$mode" "$status" "$log_file"
exit "$status"
