#!/usr/bin/env bash
# apply-patch.sh <skill-id> <patch.json> [--base <SKILL.md>] [--out <file>] [--known-ids a,b]
#
# Apply a model-proposed patch (see src/evolve/types.ts skillPatchSchema) to the
# active SKILL.md and validate it offline. This is the bridge between a model
# diagnosis and candidate.sh: patch -> apply-patch.sh -> candidate.sh -> loop.sh.
#
# Default base is the active skill (override wins, then repo). Default out is an
# archived candidate path under ~/.giclaw/evolve/candidates/<id>/.
#
# stdout: JSON { ok, skillId, out, violations }
# stderr: diagnostics
# exit:   0 candidate written | 1 rejected | 2 bad usage

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then show_help "$0"; exit 0; fi

skill="${1:-}"
patch_file="${2:-}"
shift 2 || true
require_skill_id "$skill"
[[ -n "$patch_file" && -f "$patch_file" ]] || die "usage: apply-patch.sh <skill-id> <patch.json> [--base <file>] [--out <file>]" 2
init_workspace

base=""
out=""
known_ids=""
while (($#)); do
  case "$1" in
    --base) base="${2:-}"; shift ;;
    --out) out="${2:-}"; shift ;;
    --known-ids) known_ids="${2:-}"; shift ;;
    *) die "unknown option: $1 (try --help)" 2 ;;
  esac
  shift
done

[[ -n "$base" ]] || base="$(active_skill_file "$skill")"
[[ -f "$base" ]] || die "base SKILL.md not found: $base" 2
[[ -n "$out" ]] || out="$EVOLVE_HOME/candidates/$skill/$(utc_stamp)-patched/SKILL.md"

args=(--id "$skill" --base "$base" --patch "$patch_file" --out "$out")
[[ -n "$known_ids" ]] && args+=(--known-ids "$known_ids")

log "applying $patch_file to $base"
( cd "$REPO_ROOT" && pnpm exec tsx "$SCRIPT_DIR/apply-patch.ts" "${args[@]}" )
