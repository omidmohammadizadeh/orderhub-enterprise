#!/bin/sh
# OrderHub Worker production startup script
#
# The worker connects to Redis queues and processes order sync/print jobs.
# It does NOT serve HTTP traffic — no port is exposed.
#
# Used by Render Background Worker service and Railway worker service.

set -e

echo "[worker-startup] OrderHub Worker startup — $(date)"

# ── Validate required environment ─────────────────────────
if [ -z "$DATABASE_URL" ]; then
  echo "[worker-startup] ERROR: DATABASE_URL is not set. Aborting."
  exit 1
fi
if [ -z "$QUEUE_REDIS_URL" ] && [ -z "$REDIS_URL" ]; then
  echo "[worker-startup] ERROR: QUEUE_REDIS_URL / REDIS_URL not set. Aborting."
  exit 1
fi

echo "[worker-startup] Environment validation passed."
echo "[worker-startup] Starting OrderHub Worker..."
exec node dist/main
