#!/usr/bin/env bash
# self-check.sh
#
# Validate this skill's own structure and harness, so a broken edit fails fast:
#   1. SKILL.md frontmatter parses; name matches the directory; description <= 1024
#   2. SKILL.md body stays under the 500-line progressive-disclosure budget
#   3. required scripts exist and are executable
#   4. validate-skill.ts loads the repo's real skills
#   5. summarize.mjs tolerates a missing state file
#
# stdout: one PASS/FAIL line per check
# stderr: failure details
# exit:   0 all pass | 1 any failure

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

fail=0
pass() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; warn "$2"; fail=1; }

# 1 + 2: frontmatter and size budget
if SKILL_MD="$EVOLVE_SKILL_DIR/SKILL.md" node --input-type=module -e '
import { readFileSync } from "node:fs";
import matter from "gray-matter";
const path = process.env.SKILL_MD;
const raw = readFileSync(path, "utf8");
const parsed = matter(raw);
const name = parsed.data.name;
const dir = path.replace(/\/SKILL.md$/, "").split("/").pop();
const problems = [];
if (name !== dir) problems.push(`name "${name}" != directory "${dir}"`);
if (!parsed.data.description || parsed.data.description.length > 1024) problems.push("description missing or > 1024 chars");
const bodyLines = raw.split("\n").length;
if (bodyLines > 500) problems.push(`SKILL.md is ${bodyLines} lines (> 500)`);
if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
' 2>/tmp/giclaw-evolve-selfcheck.err; then
  pass "SKILL.md frontmatter + size budget"
else
  bad "SKILL.md frontmatter + size budget" "$(cat /tmp/giclaw-evolve-selfcheck.err)"
fi

# 3: scripts
missing=""
for s in lib.sh run-skill.sh latest-run.sh snapshot-skill.sh candidate.sh loop.sh promote.sh rollback.sh apply-patch.sh apply-patch.ts self-check.sh validate-skill.ts summarize.mjs; do
  [[ -x "$SCRIPT_DIR/$s" ]] || missing="$missing $s"
done
if [[ -z "$missing" ]]; then pass "all scripts present and executable"; else bad "missing/non-executable scripts" "$missing"; fi

# 4: real loader against repo skills
if ( cd "$REPO_ROOT" && pnpm exec tsx "$SCRIPT_DIR/validate-skill.ts" "$REPO_ROOT/skills" >/dev/null 2>/tmp/giclaw-evolve-selfcheck.err ); then
  pass "giclaw loader accepts repo skills"
else
  bad "giclaw loader rejected repo skills" "$(cat /tmp/giclaw-evolve-selfcheck.err)"
fi

# 5: summarizer tolerates empty state
if node "$SCRIPT_DIR/summarize.mjs" /tmp/does-not-exist.json /tmp/none /tmp/none 5 >/dev/null 2>&1; then
  pass "summarize.mjs handles missing state"
else
  bad "summarize.mjs failed on missing state" "see giclaw-evolve self-check output"
fi

rm -f /tmp/giclaw-evolve-selfcheck.err
exit "$fail"
