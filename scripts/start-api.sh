#!/bin/sh
# OrderHub API production startup script
# Runs before the API process starts: generates Prisma client and applies migrations.
#
# Used by:
#   - Render pre-deploy command
#   - Railway build command
#   - docker-compose.prod.yml (can override CMD)
#   - Any production startup that needs DB ready before app boots

set -e

echo "[startup] OrderHub API startup — $(date)"

# ── 1. Validate required environment ──────────────────────
if [ -z "$DATABASE_URL" ]; then
  echo "[startup] ERROR: DATABASE_URL is not set. Aborting."
  exit 1
fi
if [ -z "$JWT_SECRET" ]; then
  echo "[startup] ERROR: JWT_SECRET is not set. Aborting."
  exit 1
fi
if [ -z "$CREDENTIAL_ENCRYPTION_KEY" ] && [ -z "$CREDENTIAL_ENCRYPTION_KEY_CURRENT" ]; then
  echo "[startup] ERROR: CREDENTIAL_ENCRYPTION_KEY is not set. Aborting."
  exit 1
fi

echo "[startup] Environment validation passed."

# ── 2. Generate Prisma client ─────────────────────────────
echo "[startup] Generating Prisma client..."
npx prisma generate --schema=packages/database/prisma/schema.prisma
echo "[startup] Prisma client generated."

# ── 3. Apply database migrations ─────────────────────────
echo "[startup] Applying database migrations..."
npx prisma migrate deploy --schema=packages/database/prisma/schema.prisma
echo "[startup] Migrations complete."

# ── 4. Start the API ─────────────────────────────────────
echo "[startup] Starting OrderHub API..."
exec node dist/main
