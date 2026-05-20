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
# Use the project-installed Prisma binary — NOT `npx prisma` which downloads the
# latest CLI (currently 7.x) and rejects schema features valid in Prisma 5.x
# (previewFeatures=["metrics"], datasource url= property, etc.).

# If a previous deployment crashed mid-migration, Prisma records the migration as
# "failed" (P3009) and blocks all future deploys. Resolve any such records first:
# --rolled-back tells Prisma the migration did not apply (safe because Prisma runs
# migrations inside a Postgres transaction — a process crash rolls the DDL back).
# The command is a no-op if the migration is not in a failed state, so it is safe
# to run on every startup.
echo "[startup] Resolving any previously-failed migration records..."
./packages/database/node_modules/.bin/prisma migrate resolve \
  --rolled-back 20260518120000_phase_e \
  --schema=packages/database/prisma/schema.prisma 2>/dev/null || true

./packages/database/node_modules/.bin/prisma migrate deploy --schema=packages/database/prisma/schema.prisma
echo "[startup] Migrations complete."

# ── 3. Start the API ─────────────────────────────────────
echo "[startup] Starting OrderHub API..."
exec node apps/api/dist/main
