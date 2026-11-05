#!/bin/sh
# GDELT seeders on their own 15-minute cadence, for self-hosted installs.
#
# GDELT publishes a new file every 15 minutes and the materializer catches up
# at most 2 hours (8 files) per run, so the 3-hourly run-seeders.sh pass alone
# skips one hour in every three and the 7-day protest window never fills.
# Upstream runs the materializer on a 15-minute cron; this does the same on a
# host cron, next to the 3-hourly run-seeders.sh line:
#
#   */15 * * * * cd /path/to/worldmonitor && flock -n /tmp/wm-gdelt.lock ./scripts/run-gdelt-seeders.sh >> /tmp/wm-gdelt.log 2>&1
#
# The unrest seed runs right after, so new protests reach the map on the same
# tick. Both seeds take a Redis lock, so overlap with run-seeders.sh is skipped.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  . "$PROJECT_DIR/.env"
  set +a
fi

UPSTASH_REDIS_REST_URL="${UPSTASH_REDIS_REST_URL:-http://localhost:8079}"
if [ -n "${REDIS_TOKEN:-}" ]; then
  UPSTASH_REDIS_REST_TOKEN="$REDIS_TOKEN"
fi
if [ -z "${UPSTASH_REDIS_REST_TOKEN:-}" ]; then
  echo "ERROR: REDIS_TOKEN (or UPSTASH_REDIS_REST_TOKEN) is required." >&2
  exit 1
fi
export UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) GDELT seeders ==="
for seed in seed-gdelt-bulk-materializer.mjs seed-unrest-events.mjs; do
  printf -- '-> %s: ' "$seed"
  timeout -k 30 600 node "$SCRIPT_DIR/$seed" 2>&1 | tail -1
done
