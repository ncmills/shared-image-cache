#!/bin/bash
# Keep the CI question-set current as shared-data grows.
# Wired via launchd (com.ncmills.image-snapshot-refresh), daily 07:20.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
# On CI the sibling project repos are not checked out, so every loader falls
# back to queries.snapshot.json. That file IS the autonomous fetcher's input:
# a destination absent from it is never photographed, and nothing reports it.
#
# check-snapshot-drift catches one half of that — a LOADER edited after the
# snapshot was committed. It cannot catch the other half, which is the common
# one: shared-data gains 40 destinations, a site bumps its pin, and the loader
# file never changes while its OUTPUT does. The snapshot silently under-asks
# and the new cities render the branded fallback forever.
#
# Only a machine with the sibling checkouts can regenerate it. That is this
# laptop, so this runs here.
#
# ── WHY IT IS SAFE TO RUN UNATTENDED ────────────────────────────────────────
# The dangerous outcome would be writing a SMALLER snapshot because a sibling
# repo was missing or mid-rebase — CI would then quietly stop asking for those
# images. buildSnapshot() already refuses to do that: an absent data dir marks
# the slice `preserved` and carries the previous queries AND their original
# timestamp through untouched. Worst case here is a no-op, never a shrink.
#
# The gate still runs before anything is committed, and a failure exits
# non-zero with the reason rather than pushing.
set -euo pipefail

REPO="${REPO:-$HOME/shared-image-cache}"
LOG="${LOG:-$HOME/work/logs/image-snapshot-refresh.log}"
mkdir -p "$(dirname "$LOG")"

say() { echo "$(date +%FT%T) $*" >> "$LOG"; }

# ── heartbeat ───────────────────────────────────────────────────────────────
# Proof that this job ran, separate from whether it found anything. The two are
# different facts and conflating them is what makes a dead scheduler invisible:
# "the snapshot has not changed" is the expected state most nights, and it is
# also exactly what a job that stopped running looks like.
#
# Committed at most weekly, so it costs ~52 two-line commits a year rather than
# 365. CI reads it in check-snapshot-drift.
HEARTBEAT="$REPO/snapshot-heartbeat.json"
HEARTBEAT_COMMIT_EVERY_DAYS=7

write_heartbeat() {
  printf '{\n  "lastRunAt": "%s",\n  "by": "com.ncmills.image-snapshot-refresh"\n}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HEARTBEAT"

  local last_commit age_days
  last_commit=$(git log -1 --format=%ct -- snapshot-heartbeat.json 2>/dev/null || echo "")
  if [ -z "$last_commit" ]; then
    age_days=9999
  else
    age_days=$(( ( $(date +%s) - last_commit ) / 86400 ))
  fi

  if [ "$age_days" -lt "$HEARTBEAT_COMMIT_EVERY_DAYS" ]; then
    git checkout -- snapshot-heartbeat.json 2>/dev/null || true
    return 0
  fi

  git add snapshot-heartbeat.json
  git commit --quiet -m "snapshot heartbeat: refresher alive $(date -u +%F)

Proof the daily snapshot refresh ran, recorded separately from whether it found
a change. Most nights it finds nothing — which is also what a dead scheduler
looks like, so the two facts cannot share a signal.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" || return 0
  # Catch up first so a remote that moved since the top-of-script pull
  # doesn't reject this push outright; --ff-only refuses to do anything
  # cleverer than that, so a real divergence still falls through to the WARN.
  git pull --quiet --ff-only origin main || true
  git push --quiet origin main || say "WARN — heartbeat commit is local (push failed)"
  say "heartbeat committed (was ${age_days}d old)"
}

cd "$REPO"

# ── branch guard ─────────────────────────────────────────────────────────
# 2026-09-02: the live checkout sat on a PR branch
# (fix/evict-stale-state-template-heroes) for 10 days. Every run committed
# the heartbeat there, then `git push origin main` pushed the stale LOCAL
# main ref — `! [rejected] non-fast-forward` every single time, silently,
# because the push failure only ever produced a WARN. Committing is a
# main-branch-only action: a laptop left on a PR branch must skip, not
# write to whatever happens to be checked out.
CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  say "SKIP — checkout is on $CURRENT_BRANCH, not main; heartbeat not written"
  exit 0
fi

# Test-only seam: stop here, right after the guard above and before any
# network/build work (dirty-tree check, pull, npx tsx, gate, commit, push).
# Lets scripts/test-refresh-snapshot-branch-guard.sh exercise the guard
# against a throwaway repo without touching the real one or the network.
[ -z "${REFRESH_SNAPSHOT_GUARD_ONLY:-}" ] || exit 0

# Never regenerate on top of local work. A dirty tree means a human or another
# session is mid-change; committing over it would be theft, and `git pull
# --rebase` refuses outright. Checking the WHOLE tree, not just the snapshot:
# the first version of this guard watched only queries.snapshot.json and the
# pull then died on unrelated unstaged files — a scheduled job must never fight
# a working tree it does not own.
#
# SKIP, exit 0, not a failure: a laptop mid-edit is the normal state of this
# machine, and a nightly job that alarms on it is one whose log stops being read.
if [ -n "$(git status --porcelain)" ]; then
  say "SKIP — working tree is dirty (someone is mid-change); will try again tomorrow"
  exit 0
fi

git pull --quiet --rebase origin main || { say "FAIL — git pull"; exit 1; }

npx tsx scripts/snapshot-queries.ts >> "$LOG" 2>&1 || { say "FAIL — snapshot generation"; exit 1; }

# Did the QUESTIONS change, or only the clock?
#
# buildSnapshot re-stamps `generatedAt` on every live slice, so a regeneration
# always dirties the file even when every query is byte-identical. Committing
# that would be a nightly noise commit forever — and worse, it would defeat the
# heartbeat below, which measures how long it has been since a real refresh:
# a job that commits every night always looks alive, including when the query
# set has silently frozen. Compare the payload, ignore the timestamps.
QUERIES_CHANGED=$(node -e '
  const {execSync}=require("child_process");
  const cur=JSON.parse(require("fs").readFileSync("queries.snapshot.json","utf8"));
  const prev=JSON.parse(execSync("git show HEAD:queries.snapshot.json",{encoding:"utf8"}));
  process.stdout.write(JSON.stringify(cur.projects)===JSON.stringify(prev.projects) ? "no" : "yes");
') || { say "FAIL — could not diff snapshot payload"; exit 1; }

if [ "$QUERIES_CHANGED" = "no" ]; then
  # Throw away the timestamp-only churn; record that a refresh really ran.
  git checkout -- queries.snapshot.json
  write_heartbeat
  say "no change — snapshot already current (timestamps only)"
  exit 0
fi

# What actually moved, so the log answers "why did this commit happen".
DELTA=$(node -e '
  const {execSync}=require("child_process");
  const cur=JSON.parse(require("fs").readFileSync("queries.snapshot.json","utf8"));
  const prev=JSON.parse(execSync("git show HEAD:queries.snapshot.json",{encoding:"utf8"}));
  const out=[];
  for (const p of Object.keys(cur.projects)) {
    const a=(prev.projects?.[p]||[]).length, b=cur.projects[p].length;
    if (a!==b) out.push(`${p} ${a}->${b}`);
  }
  process.stdout.write(out.join(", ") || "same counts, different queries");
')

npm run gate >> "$LOG" 2>&1 || { say "FAIL — gate rejected the new snapshot ($DELTA); NOT committing"; exit 1; }

git add queries.snapshot.json
git commit --quiet -m "snapshot: refresh CI query set ($DELTA)

Regenerated by com.ncmills.image-snapshot-refresh. The sibling repos' data
changed without their loaders changing — shared-data growth, a pin bump, or new
destinations — so the questions CI asks were behind the catalogue.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" || { say "FAIL — commit"; exit 1; }

git push --quiet origin main || { say "FAIL — push (commit is local)"; exit 1; }

write_heartbeat
say "refreshed + pushed: $DELTA"
