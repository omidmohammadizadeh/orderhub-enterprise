# Deployment Runbook — OrderHub API

> Exact commands to deploy to production. Follow in order. Do not skip steps.
> For the first pilot deploy, also follow `PILOT_LAUNCH_RUNBOOK.md`.

---

## Required Environment Variables

See `PRODUCTION_ENVIRONMENT.md` for the full reference.

Critical variables (startup will fail without these in production):

| Variable | Description | Generate with |
|---|---|---|
| `NODE_ENV` | Must be `production` | — |
| `DATABASE_URL` | Postgres connection string | — |
| `REDIS_URL` | Redis connection string | — |
| `QUEUE_REDIS_URL` | Bull queue Redis | — |
| `CREDENTIAL_ENCRYPTION_KEY` | AES-256 key — 64 hex chars | `openssl rand -hex 32` |
| `JWT_SECRET` | At least 32 random chars | `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET` | At least 32 random chars | `openssl rand -base64 48` |
| `APP_URL` | Production frontend URL | — |
| `SOCKET_CORS_ORIGIN` | Production frontend domain | — |

**Key rotation (if rotating):**

| Variable | Description |
|---|---|
| `CREDENTIAL_ENCRYPTION_KEY_CURRENT` | New key (replaces `CREDENTIAL_ENCRYPTION_KEY`) |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | Old key — keep set until all credentials re-encrypted |
| `CREDENTIAL_ENCRYPTION_KEY_ID` | String label for current key, e.g. `v2` |

---

## Pre-Deploy Checklist

- [ ] Branch/commit confirmed and reviewed
- [ ] `pnpm test` passes (all suites)
- [ ] `pnpm build` succeeds
- [ ] All required env vars set in deployment target
- [ ] Database backup taken (see Step 0)
- [ ] Migration reviewed — is it additive? Any data transformation needed?
- [ ] On-call engineer available

---

## Step 0 — Database Backup

Always back up before migrating or deploying.

```bash
PGPASSWORD="$DB_PASS" pg_dump \
  --host="$DB_HOST" --port="${DB_PORT:-5432}" \
  --username="$DB_USER" --dbname="$DB_NAME" \
  --format=custom \
  --file="backup-$(date +%Y%m%d-%H%M%S).dump"

# Verify backup
ls -lh backup-*.dump
pg_restore --list backup-*.dump | head -20

# Upload to backup storage
aws s3 cp backup-*.dump s3://orderhub-backups/pre-deploy/
```

---

## Step 1 — Apply Database Migrations

Run from the monorepo root.

```bash
DATABASE_URL=<url> npx prisma migrate deploy \
  --schema=packages/database/prisma/schema.prisma
```

Verify all migrations applied:
```bash
DATABASE_URL=<url> npx prisma migrate status \
  --schema=packages/database/prisma/schema.prisma
```

Expected: `20260519000000_phase_k` is the most recent applied migration.

---

## Step 2 — Generate Prisma Client

Must run after any schema or migration change.

```bash
DATABASE_URL=<url> npx prisma generate \
  --schema=packages/database/prisma/schema.prisma
```

Or via npm script from `apps/api`:
```bash
pnpm --filter @orderhub/api db:generate
```

---

## Step 3 — Credential Encryption Backfill

Encrypts any remaining plaintext credentials. Safe to run even if all credentials are already encrypted (idempotent).

```bash
# Dry run — confirm count
DRY_RUN=true \
  CREDENTIAL_ENCRYPTION_KEY=<key> \
  DATABASE_URL=<url> \
  pnpm --filter @orderhub/api db:backfill-encryption

# Apply
CREDENTIAL_ENCRYPTION_KEY=<key> \
  DATABASE_URL=<url> \
  pnpm --filter @orderhub/api db:backfill-encryption
```

**Verify:** Readiness must show `plaintextCredentials: 0`.

---

## Step 4 — Build

```bash
pnpm --filter @orderhub/api build
pnpm --filter @orderhub/worker build
```

---

## Step 5 — Run Tests

All suites must pass before deploying.

```bash
pnpm --filter @orderhub/api test -- --no-coverage
```

Expected: 327 tests passing, 23 suites. Do not deploy if any test fails.

---

## Step 6 — Optional: Enable Maintenance Mode

If using maintenance mode to prevent orders during deploy window:
```bash
# Set env var and restart API
ENABLE_MAINTENANCE_MODE=true MAINTENANCE_MESSAGE="System update in progress — back shortly" \
  node apps/api/dist/main.js
```

---

## Step 7 — Start/Restart Worker

```bash
systemctl restart orderhub-worker
# Or for Docker: docker restart orderhub-worker
```

---

## Step 8 — Start/Restart API

```bash
systemctl restart orderhub-api
# Or for Docker: docker restart orderhub-api
```

Watch startup logs for:
```
[ProductionStartupService] Production startup validation passed.
[Bootstrap] API running on port 4000 [production]
```

If you see `STARTUP FAILED`, check logs for the specific failing check before proceeding.

---

## Step 9 — Verify Health

```bash
curl https://api.orderhub.io/api/v1/health/ready
```

Expected:
```json
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok" },
    "redis": { "status": "ok" }
  }
}
```

---

## Step 10 — Run Smoke Test

```bash
CREDENTIAL_ENCRYPTION_KEY=<key> \
  DATABASE_URL=<url> \
  SMOKE_BASE_URL=https://api.orderhub.io \
  SMOKE_TENANT_ID=<tenantId> \
  npx ts-node -P apps/api/tsconfig.json apps/api/src/scripts/smoke-test.ts
```

All checks must pass (exit code 0) before removing maintenance mode or routing traffic.

Checks include:
- Encryption key valid
- Encryption roundtrip passes
- Database connected
- Phase K migration applied
- Redis connected
- No plaintext credentials
- No dead outbox events
- No stuck PROCESSING events
- API liveness and readiness
- Release readiness score ≥ 80
- Webhook endpoint reachable

---

## Step 11 — Release Readiness Check

```bash
curl "https://api.orderhub.io/api/v1/health/release-readiness?tenantId=<tenantId>" \
  -H "Authorization: Bearer <token>" | jq '.'
```

**Gate — all of these must pass:**
- `encryption.keySet: true`
- `credentialEncryption.plaintextCredentials: 0`
- `credentialEncryption.encryptedWithOldKey: 0` (unless rotation is explicitly in progress)
- `outbox.dead: 0`
- `outbox.stuckProcessing: 0`
- `readyScore >= 90`

---

## Step 12 — Disable Maintenance Mode

```bash
# Remove ENABLE_MAINTENANCE_MODE from env (or set to false) and restart
systemctl restart orderhub-api
```

---

## Post-Deploy Monitoring (First 30 Minutes)

- [ ] `GET /api/v1/health/ready` stays green
- [ ] Bull Board shows no queue failures
- [ ] First real order received and printed
- [ ] First real order status synced back to provider
- [ ] No `STARTUP FAILED` in logs
- [ ] No `UnauthorizedException` in webhook logs
- [ ] Outbox `dead: 0` and `stuckProcessing: 0`

---

## Key Rotation

Run when you need to replace the credential encryption key without downtime.

```bash
# 1. Generate new key
NEW_KEY=$(openssl rand -hex 32)

# 2. Dry run with both keys
DRY_RUN=true \
  CREDENTIAL_ENCRYPTION_KEY_CURRENT=$NEW_KEY \
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS=$OLD_KEY \
  CREDENTIAL_ENCRYPTION_KEY_ID=v2 \
  DATABASE_URL=<url> \
  pnpm --filter @orderhub/api db:rotate-keys

# 3. Deploy with both keys set in env

# 4. Apply rotation
CREDENTIAL_ENCRYPTION_KEY_CURRENT=$NEW_KEY \
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS=$OLD_KEY \
  CREDENTIAL_ENCRYPTION_KEY_ID=v2 \
  DATABASE_URL=<url> \
  pnpm --filter @orderhub/api db:rotate-keys

# 5. Verify: encryptedWithOldKey must be 0
curl "https://api.orderhub.io/api/v1/health/release-readiness?tenantId=<id>" | \
  jq '.checks.credentialEncryption'

# 6. Remove CREDENTIAL_ENCRYPTION_KEY_PREVIOUS from env
# 7. Rename CREDENTIAL_ENCRYPTION_KEY_CURRENT → CREDENTIAL_ENCRYPTION_KEY
# 8. Redeploy
```

---

## Rollback

### App version rollback

```bash
# Redeploy previous build artifact
systemctl stop orderhub-api orderhub-worker
# Swap dist/ to previous version
systemctl start orderhub-api orderhub-worker
```

### Migration rollback

Migrations are additive (new columns with defaults) and generally do not need reverting. If a migration must be rolled back:

```bash
# Mark migration as rolled back in prisma migrations table
DATABASE_URL=<url> npx prisma migrate resolve \
  --rolled-back 20260519000000_phase_k \
  --schema=packages/database/prisma/schema.prisma

# Apply the corresponding manual SQL rollback
DATABASE_URL=<url> psql "$DATABASE_URL" <<SQL
ALTER TABLE locations DROP COLUMN IF EXISTS "goLiveStatus";
ALTER TABLE locations DROP COLUMN IF EXISTS "lastTestOrderAt";
ALTER TABLE locations DROP COLUMN IF EXISTS "lastTestPrintAt";
DROP TYPE IF EXISTS "LocationGoLiveStatus";
SQL
```

### Pause a provider during rollback

```bash
# Set integration status to INACTIVE to stop receiving orders from a platform
UPDATE integrations SET status = 'INACTIVE' WHERE platform = 'UBER_EATS' AND "locationId" = '<id>';
```

### Stop workers safely

```bash
# SIGTERM lets Bull finish in-flight jobs before shutting down
kill -TERM $(cat /var/run/orderhub-worker.pid)
# Or: systemctl stop orderhub-worker
```

Do NOT use `kill -9` — it will interrupt in-flight jobs and may cause duplicate dispatches.

### Prevent duplicate printing during rollback

Print jobs use `UNIQUE` constraints on the outbox event ID. If the API restarts mid-job:
1. The outbox dispatcher will retry the event
2. The printer service deduplicates by `printJobId` before creating a new print job
3. The Flutter app deduplicates by polling — already-printed jobs are not resent

No special action needed during rollback.
