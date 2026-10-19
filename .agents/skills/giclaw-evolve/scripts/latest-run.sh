#!/usr/bin/env bash
# latest-run.sh [tailN]
#
# Print the evidence digest for the most recent persisted run: outcome, task
# results, transcript tail, and newest failure/checkpoint screenshots. No model
# call, no browser. Safe to run as often as you like while iterating.
#
# stdout: the digest (human- and agent-readable)
# stderr: nothing on success
# exit:   0 (also when there is no run history yet)

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then show_help "$0"; exit 0; fi

node "$SCRIPT_DIR/summarize.mjs" "$STATE_FILE" "$TRANSCRIPTS_DIR" "$SCREENSHOT_DIR" "${1:-120}"
