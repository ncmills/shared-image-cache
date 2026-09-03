#!/bin/bash
# Regression test for the branch guard in refresh-snapshot.sh.
#
# Defect (measured 2026-09-02): the live checkout sat on
# fix/evict-stale-state-template-heroes for 10 days. refresh-snapshot.sh
# committed snapshot-heartbeat.json to that branch, then ran
# `git push --quiet origin main`, pushing the stale local main ref and
# getting `! [rejected] non-fast-forward` on every run.
#
# This test builds a throwaway repo + bare "origin" under $TMPDIR (never the
# real ~/shared-image-cache, never the network) and drives the real script
# via two env-var seams it now honors:
#   REPO                        — override the repo path (default: ~/shared-image-cache)
#   LOG                         — override the log path (default: ~/work/logs/...)
#   REFRESH_SNAPSHOT_GUARD_ONLY — exit right after the branch guard, before
#                                 any network/build work (dirty-tree check,
#                                 git pull, npx tsx, gate, commit, push)
#
# Asserts:
#   1. On a non-main branch: SKIP is logged naming the branch, no commit is
#      made, exit code is 0.
#   2. Positive control: on main, the guard does not fire (no SKIP line).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REFRESHER="$SCRIPT_DIR/refresh-snapshot.sh"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/refresh-snapshot-guard-test.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

ORIGIN="$WORKDIR/origin.git"
REPO="$WORKDIR/repo"
LOG="$WORKDIR/test.log"

fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

# ── build a fake bare origin + a clone with a heartbeat file to commit ──────
git init --quiet --bare "$ORIGIN"

git init --quiet "$REPO"
git -C "$REPO" config user.email "test@example.com"
git -C "$REPO" config user.name "Test"
git -C "$REPO" remote add origin "$ORIGIN"
echo '{"lastRunAt": "seed", "by": "seed"}' > "$REPO/snapshot-heartbeat.json"
git -C "$REPO" add snapshot-heartbeat.json
git -C "$REPO" commit --quiet -m "seed"
git -C "$REPO" branch -M main
git -C "$REPO" push --quiet -u origin main

BEFORE_SHA="$(git -C "$REPO" rev-parse HEAD)"

# ── Case 1: wrong branch — guard must fire ──────────────────────────────────
git -C "$REPO" checkout --quiet -b fix/evict-stale-state-template-heroes

set +e
REPO="$REPO" LOG="$LOG" REFRESH_SNAPSHOT_GUARD_ONLY=1 bash "$REFRESHER"
EXIT_CODE=$?
set -e

[ "$EXIT_CODE" -eq 0 ] || fail "wrong-branch run exited $EXIT_CODE, expected 0"

grep -q "SKIP" "$LOG" || fail "log missing SKIP line: $(cat "$LOG")"
grep -q "fix/evict-stale-state-template-heroes" "$LOG" || \
  fail "log did not name the branch: $(cat "$LOG")"

AFTER_SHA="$(git -C "$REPO" rev-parse HEAD)"
[ "$AFTER_SHA" = "$BEFORE_SHA" ] || fail "guard committed on the wrong branch"

pass "wrong branch → SKIP logged, names the branch, exit 0, no commit"

# ── Case 2 (positive control): on main — guard must NOT fire ───────────────
git -C "$REPO" checkout --quiet main
: > "$LOG"

set +e
REPO="$REPO" LOG="$LOG" REFRESH_SNAPSHOT_GUARD_ONLY=1 bash "$REFRESHER"
EXIT_CODE=$?
set -e

[ "$EXIT_CODE" -eq 0 ] || fail "main run exited $EXIT_CODE, expected 0"
if grep -q "SKIP" "$LOG"; then
  fail "guard fired on main: $(cat "$LOG")"
fi

pass "positive control: on main the guard does not fire"

echo "ALL PASS"
