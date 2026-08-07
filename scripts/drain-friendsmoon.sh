#!/bin/bash
# Drain the friendsmoon image queue against Unsplash's hourly rate limit.
#
# 248 queries and ~50 requests/hour means the friendsmoon cache cannot be filled
# in one run. This is the hourly nibbler. `fetch.ts` is idempotent — already
# cached keys are skipped — so a run after the queue empties is a cheap no-op.
#
# It unloads its own launchd agent once nothing is pending, so this does not
# become another permanent hourly job nobody remembers installing.
#
# Installed as ~/Library/LaunchAgents/com.secondnick.friendsmoon-image-drain.plist

set -uo pipefail

REPO="$HOME/shared-image-cache"
LABEL="com.secondnick.friendsmoon-image-drain"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/work/logs/friendsmoon-image-drain.log"

mkdir -p "$(dirname "$LOG")"
cd "$REPO" || exit 0

echo "── $(date '+%Y-%m-%d %H:%M:%S') ──────────────────────────────" >>"$LOG"

# --commit pushes each batch, so the site's prebuild sync picks new images up on
# the next deploy without anyone doing anything.
npx tsx scripts/fetch.ts --project=friendsmoon --limit=45 --commit >>"$LOG" 2>&1

# `fetch.ts` prints "N still pending" on every run. Zero means done.
PENDING=$(grep -Eo '[0-9]+ still pending' "$LOG" | tail -1 | grep -Eo '^[0-9]+')

if [ "${PENDING:-1}" = "0" ]; then
  echo "✓ friendsmoon image queue drained — unloading $LABEL" >>"$LOG"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  rm -f "$PLIST"
fi
