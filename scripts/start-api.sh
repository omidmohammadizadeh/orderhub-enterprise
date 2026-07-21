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

# ── 1b. Regenerate the Prisma client ─────────────────────
# Turbo's build task only caches `dist/**`, NOT the generated Prisma client
# (packages/database/generated). On a cache-hit deploy `prisma generate` is
# skipped, so a schema change (new column) can ship with a STALE runtime client
# that rejects the new field as an "Unknown argument" even though the DB column
# exists. Regenerating here — at boot, which turbo never caches — guarantees the
# runtime client always matches the committed schema. Does not touch the DB.
echo "[startup] Regenerating Prisma client from schema..."
./packages/database/node_modules/.bin/prisma generate --schema=packages/database/prisma/schema.prisma
echo "[startup] Prisma client regenerated."

# ── 2. Apply database migrations ─────────────────────────
# DIRECT_URL is used by Prisma for migrations (bypasses PgBouncer pooler).
# DATABASE_URL (pooled) is used for all runtime queries.
echo "[startup] Applying database migrations..."
# Use the project-installed Prisma binary — NOT `npx prisma` which downloads the
# latest CLI (currently 7.x) and rejects schema features valid in Prisma 5.x
# (previewFeatures=["metrics"], datasource url= property, etc.).

# HISTORY: this script previously ran
#   prisma migrate resolve --rolled-back 20260518130000_phase_e_supplement
#   prisma migrate resolve --rolled-back 20260518180000_phase_f
# on every startup as a hack to unblock a one-off P3009 failure. The hack
# caused chronic schema drift — those two migrations contain non-idempotent
# statements (CREATE TYPE without guards, ALTER TABLE ADD COLUMN without
# IF NOT EXISTS), so re-applying them aborts on the first conflict and
# rolls back the entire transaction, leaving the orders table missing
# columns the schema declares (most visibly: orders.tenantId).
#
# The fix is the dedicated 20260520230000_phase_aj_reconcile_orders_schema
# migration which idempotently re-adds every column / enum / FK the schema
# expects on `orders`. With that in place we can stop fighting Prisma:
# leave the migration history alone and let `migrate deploy` apply new
# work normally.
#
# If a future migration legitimately fails mid-deploy, the right answer is
# an operator running `prisma migrate resolve` manually after diagnosing —
# not silently retrying on every container restart.

./packages/database/node_modules/.bin/prisma migrate deploy --schema=packages/database/prisma/schema.prisma
echo "[startup] Migrations complete."

# ── 3. Start the API ─────────────────────────────────────
echo "[startup] Starting OrderHub API..."
exec node apps/api/dist/main
