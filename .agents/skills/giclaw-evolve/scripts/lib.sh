#!/usr/bin/env bash
# Shared helpers for the giclaw-evolve development loop.
#
# Sourced, never executed directly. Resolves the repo root, the private
# evolution workspace, and logging/validation helpers reused by every script.
#
# Output contract (see agentskills.io "Using scripts in skills"):
#   * stdout  = machine-readable result (paths, JSON, digests)
#   * stderr  = human diagnostics (progress, warnings, errors)
#   * no interactive prompts; all input comes from argv or the environment
#
# This file never touches the network or the browser. The shell scripts only
# invoke giclaw's own CLI, which owns login, the serial queue, and persistence.

set -euo pipefail

# .agents/skills/giclaw-evolve/scripts -> repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVOLVE_SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EVOLVE_SKILL_DIR/../../.." && pwd)"

# giclaw's state directory is fixed at ~/.giclaw; the override exists so the
# harness itself can be smoke-tested in a throwaway directory.
STATE_DIR="${GICLAW_STATE_DIR:-$HOME/.giclaw}"
EVOLVE_HOME="${GICLAW_EVOLVE_HOME:-$STATE_DIR/evolve}"
# ~/.giclaw/skills is the LAST entry of tasks.skillsDirs, so a candidate placed
# here overrides both the bundled skills and the repo ./skills directory.
OVERRIDE_SKILLS_DIR="$STATE_DIR/skills"
DATA_DIR="$STATE_DIR/data"
TRANSCRIPTS_DIR="$DATA_DIR/transcripts"
SCREENSHOT_DIR="$DATA_DIR/screenshots"
STATE_FILE="$DATA_DIR/state.json"

GICLAW_DEV=(pnpm exec tsx src/cli.ts)

# Diagnostics always go to stderr so stdout stays parseable.
log() { printf '\033[1;36m[evolve]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[evolve]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[evolve]\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

# Minimal, dependency-free help printer: prints the leading comment block only.
show_help() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$1"; }

init_workspace() {
  for dir in "$EVOLVE_HOME" "$EVOLVE_HOME/snapshots" "$EVOLVE_HOME/candidates" \
    "$EVOLVE_HOME/runs" "$EVOLVE_HOME/generations" "$OVERRIDE_SKILLS_DIR"; do
    mkdir -p "$dir"
  done
  chmod 700 "$EVOLVE_HOME" "$OVERRIDE_SKILLS_DIR" 2>/dev/null || true
}

require_skill_id() {
  local id="${1:-}"
  [[ -n "$id" ]] || die "missing <skill-id>" 2
  [[ "$id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || die "invalid skill id \"$id\" (kebab-case only)" 2
}

# Canonical, committed source of a skill.
repo_skill_file() { printf '%s/skills/%s/SKILL.md' "$REPO_ROOT" "$1"; }
# Test override currently shadowing the canonical source.
override_skill_file() { printf '%s/%s/SKILL.md' "$OVERRIDE_SKILLS_DIR" "$1"; }
# The SKILL.md giclaw would actually load today: override wins, then repo.
active_skill_file() {
  local id="$1"
  if [[ -f "$(override_skill_file "$id")" ]]; then override_skill_file "$id"; else repo_skill_file "$id"; fi
}

# Run the real CLI from the repo root (pnpm exec avoids `--` forwarding quirks).
giclaw() { ( cd "$REPO_ROOT" && "${GICLAW_DEV[@]}" "$@" ); }

utc_stamp() { date -u +%Y%m%dT%H%M%SZ; }

# snapshot_skill <skill-id> [label] [source] -> absolute snapshot dir on stdout.
# source: "active" (default), "repo", "override", or an explicit SKILL.md path.
snapshot_skill() {
  local id="$1" label="${2:-manual}" source="${3:-active}"
  local src dest stamp
  case "$source" in
    active) src="$(active_skill_file "$id")" ;;
    repo) src="$(repo_skill_file "$id")" ;;
    override) src="$(override_skill_file "$id")" ;;
    *) src="$source" ;;
  esac
  [[ -f "$src" ]] || die "no SKILL.md to snapshot for \"$id\" (looked at $src)"
  stamp="$(utc_stamp)"
  dest="$EVOLVE_HOME/snapshots/$id/${stamp}-${label}"
  mkdir -p "$dest"
  # Copy the whole skill directory so bundled assets travel with the snapshot.
  cp -R "$(dirname "$src")/." "$dest/"
  chmod -R go-rwx "$dest" 2>/dev/null || true
  printf '%s\n' "$dest"
}
