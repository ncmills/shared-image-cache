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

# ── Cases 3-6: a pull that cannot resolve the host is categorised BY THE HOST'S STATE ────────
# (2026-09-03). The guard-only seam is left unset so the script reaches the pull; the origin
# URL is a name that cannot resolve, so `git pull` fails with `Could not resolve host` before
# any build work. REFRESH_SNAPSHOT_PMSET_LOG feeds a pmset fixture.
DARK_LOG="$WORKDIR/pmset-dark.log"
AWAKE_LOG="$WORKDIR/pmset-awake.log"
EMPTY_LOG="$WORKDIR/pmset-empty.log"
# Real column shapes from `pmset -g log` on this Mac. The trailing `Wake Requests` line is a
# forecast, not a wake — it must NOT flip a dark host to awake.
cat > "$DARK_LOG" <<'EOF'
2026-09-03 03:57:19 -0700 Sleep               	Entering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using AC (Charge:73%) 900 secs
2026-09-03 04:12:19 -0700 DarkWake            	DarkWake from Deep Idle [CDNPB] : due to NUB.SPMI0.SW3 nub-spmi0.0x02 rtc/Maintenance Using AC (Charge:73%)
2026-09-03 04:12:20 -0700 Wake Requests       	[*process=powerd request=Maintenance deltaSecs=900 wakeAt=2026-09-03 04:27:20]
EOF
cat > "$AWAKE_LOG" <<'EOF'
2026-09-03 08:29:28 -0700 Sleep               	Entering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using AC (Charge:100%) 340 secs
2026-09-03 08:35:08 -0700 DarkWake            	DarkWake from Deep Idle [CDNPB] : due to smc.sysState.Wake(0x70070000) USB-C_plug Using AC (Charge:100%) 3 secs
2026-09-03 08:35:11 -0700 Wake                	DarkWake to FullWake from Deep Idle [CDNVA] : due to UserActivity Assertion Using BATT (Charge:100%)
EOF
: > "$EMPTY_LOG"

git -C "$REPO" checkout --quiet main
git -C "$REPO" remote set-url origin https://nonexistent.invalid/refresh-snapshot-test.git

run_pull_case () {  # $1 = pmset fixture path
  : > "$LOG"
  set +e
  # WAIT_MAX=0: the dark-host wait is the production behaviour; the test asserts the terminal
  # categories, so it closes the window at once (a real run polls for up to 6 h).
  REPO="$REPO" LOG="$LOG" REFRESH_SNAPSHOT_PMSET_LOG="$1" REFRESH_SNAPSHOT_WAIT_MAX=0 bash "$REFRESHER" 2>/dev/null
  EXIT_CODE=$?
  set -e
}

# Case 3: DNS failure on a DARK host -> exit 69, NOT MEASURED, names the pmset line.
run_pull_case "$DARK_LOG"
[ "$EXIT_CODE" -eq 69 ] || fail "dark-host DNS failure exited $EXIT_CODE, expected 69: $(cat "$LOG")"
grep -q "NOT MEASURED" "$LOG" || fail "dark-host log missing NOT MEASURED: $(cat "$LOG")"
grep -q "DarkWake" "$LOG" || fail "dark-host log did not name the pmset transition: $(cat "$LOG")"
pass "dark host + no DNS → exit 69, NOT MEASURED, pmset line named"

# Case 4 (positive control): the SAME failure on an AWAKE host stays exit 1 — a real failure.
run_pull_case "$AWAKE_LOG"
[ "$EXIT_CODE" -eq 1 ] || fail "awake-host DNS failure exited $EXIT_CODE, expected 1: $(cat "$LOG")"
grep -q "FAIL — git pull" "$LOG" || fail "awake-host log missing FAIL line: $(cat "$LOG")"
grep -q "awake" "$LOG" || fail "awake-host log did not say the host was awake: $(cat "$LOG")"
pass "positive control: awake host + no DNS → exit 1 (RED), says awake"

# Case 5: pmset unreadable -> a dark verdict cannot be affirmed -> exit 1, never downgraded.
run_pull_case "$EMPTY_LOG"
[ "$EXIT_CODE" -eq 1 ] || fail "unknown-host DNS failure exited $EXIT_CODE, expected 1: $(cat "$LOG")"
grep -q "unknown" "$LOG" || fail "unknown-host log did not say unknown: $(cat "$LOG")"
pass "pmset unreadable + no DNS → exit 1 (could-not-tell never downgrades)"

# Case 6: a NON-network pull failure on a dark host is still exit 1 — dark excuses only DNS.
git -C "$REPO" remote set-url origin "$WORKDIR/does-not-exist.git"
run_pull_case "$DARK_LOG"
[ "$EXIT_CODE" -eq 1 ] || fail "non-DNS pull failure on a dark host exited $EXIT_CODE, expected 1: $(cat "$LOG")"
if grep -q "NOT MEASURED" "$LOG"; then
  fail "a non-network failure was excused as NOT MEASURED: $(cat "$LOG")"
fi
pass "dark host + non-network pull failure → exit 1 (only DNS is host-attributable)"

echo "ALL PASS"
