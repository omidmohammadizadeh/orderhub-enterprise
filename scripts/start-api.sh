#!/bin/sh
# OrderHub API production startup script
# Validates env, applies Prisma migrations, then starts the API process.
#
# Used by:
#   - infrastructure/docker/Dockerfile.api (CMD)
#   - docker-compose.prod.yml (can override CMD)
#   - Any production startup that needs DB ready before app boots
#
# Environment variables required:
#   DATABASE_URL           — Pooled Postgres connection (Supabase pgBouncer port 6543)
#   DIRECT_URL             — Direct Postgres connection (Supabase port 5432) for migrations
#   JWT_SECRET             — At least 32 random chars
#   CREDENTIAL_ENCRYPTION_KEY — 64 hex chars (AES-256 key)

set -e

echo "[startup] OrderHub API startup — $(date)"

# ── 1. Validate required environment ──────────────────────
if [ -z "$DATABASE_URL" ]; then
  echo "[startup] ERROR: DATABASE_URL is not set. Aborting."
  exit 1
fi
if [ -z "$DIRECT_URL" ]; then
  echo "[startup] ERROR: DIRECT_URL is not set. Aborting."
  echo "[startup] DIRECT_URL must be the direct (non-pooled) Supabase connection string."
  echo "[startup] Example: postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres"
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

# ── 2. Apply database migrations ─────────────────────────
# DIRECT_URL is used by Prisma for migrations (bypasses PgBouncer pooler).
# DATABASE_URL (pooled) is used for all runtime queries.
echo "[startup] Applying database migrations..."
npx prisma migrate deploy --schema=packages/database/prisma/schema.prisma
echo "[startup] Migrations complete."

# ── 3. Start the API ─────────────────────────────────────
echo "[startup] Starting OrderHub API..."
exec node dist/main
