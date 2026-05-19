# Deployment Runbook — OrderHub API

> Exact commands to deploy to production. Follow in order. Do not skip steps.

---

## Required Environment Variables

Set all of these before running any deploy command.

| Variable | Description | Example |
|---|---|---|
| `NODE_ENV` | Must be `production` | `production` |
| `DATABASE_URL` | Postgres connection string | `postgresql://user:pass@host:5432/orderhub` |
| `REDIS_URL` | Redis connection string | `redis://host:6379` |
| `CREDENTIAL_ENCRYPTION_KEY` | AES-256 key — 64 hex chars | `openssl rand -hex 32` |
| `JWT_SECRET` | At least 32 random chars | `openssl rand -base64 32` |
| `SOCKET_CORS_ORIGIN` | Frontend production domain | `https://app.orderhub.example.com` |

**Key rotation (if rotating — see below):**

| Variable | Description |
|---|---|
| `CREDENTIAL_ENCRYPTION_KEY_CURRENT` | New key (replaces `CREDENTIAL_ENCRYPTION_KEY`) |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | Old key — keep set until all credentials are rotated |
| `CREDENTIAL_ENCRYPTION_KEY_ID` | String label for current key, e.g. `v2` |

**Outbox tuning (optional):**

| Variable | Default | Description |
|---|---|---|
| `OUTBOX_PROCESSING_TIMEOUT_SECONDS` | `300` | Seconds before a stuck PROCESSING event is recovered |

---

## Step 1 — Apply Database Migration

Run from the monorepo root. Applies only pending migrations.

```bash
DATABASE_URL=<url> npx prisma migrate deploy \
  --schema=packages/database/prisma/schema.prisma
```

**Verify:** Check migration table for `20260518210000_phase_i`.

```bash
DATABASE_URL=<url> npx prisma migrate status \
  --schema=packages/database/prisma/schema.prisma
```

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

Encrypts any remaining plaintext credentials in the database.

```bash
# Dry run first — confirm count
DRY_RUN=true \
  CREDENTIAL_ENCRYPTION_KEY=<key> \
  DATABASE_URL=<url> \
  pnpm --filter @orderhub/api db:backfill-encryption

# Apply
CREDENTIAL_ENCRYPTION_KEY=<key> \
  DATABASE_URL=<url> \
  pnpm --filter @orderhub/api db:backfill-encryption
```

**Verify:** Release readiness page must show `plaintextCredentials: 0`.

---

## Step 4 — Build

```bash
pnpm --filter @orderhub/api build
pnpm --filter @orderhub/worker build
```

---

## Step 5 — Run Tests (pre-deploy gate)

```bash
pnpm --filter @orderhub/api test -- --no-coverage
```

All 9 suites must pass. If any fail, do not deploy.

---

## Step 6 — Start Worker

```bash
node apps/worker/dist/main.js
```

The worker processes Bull jobs from the outbox dispatcher.

---

## Step 7 — Start API

```bash
node apps/api/dist/main.js
```

---

## Step 8 — Verify Health

```bash
curl https://api.orderhub.example.com/api/v1/health/ready

# Expected:
# { "status": "ok", "checks": { "database": { "status": "ok" }, "redis": { "status": "ok" } } }
```

---

## Step 9 — Release Readiness Check

```bash
curl "https://api.orderhub.example.com/api/v1/health/release-readiness?tenantId=<tenantId>"
```

**Go-live gate — all of these must be satisfied:**

- `encryption.keySet: true`
- `credentialEncryption.plaintextCredentials: 0`
- `credentialEncryption.encryptedWithOldKey: 0` (if doing key rotation)
- `outbox.dead: 0`
- `outbox.stuckProcessing: 0`
- `readyScore >= 90`

---

## Step 10 — Smoke Test (Optional)

Run the smoke test script against the live URL before routing traffic:

```bash
CREDENTIAL_ENCRYPTION_KEY=<key> \
  DATABASE_URL=<url> \
  SMOKE_BASE_URL=https://api.orderhub.example.com \
  SMOKE_TENANT_ID=<tenantId> \
  npx ts-node -P apps/api/tsconfig.json apps/api/src/scripts/smoke-test.ts
```

Exit code 0 = all checks pass.

---

## Key Rotation

Run this when you need to replace `CREDENTIAL_ENCRYPTION_KEY` with a new value.

### Before you start

1. Generate new key: `openssl rand -hex 32`
2. Note your current key (this becomes `PREVIOUS`)

### Rotation steps

```bash
# 1. Set both keys in the environment
export CREDENTIAL_ENCRYPTION_KEY_CURRENT=<new-key>
export CREDENTIAL_ENCRYPTION_KEY_PREVIOUS=<old-key>
export CREDENTIAL_ENCRYPTION_KEY_ID=v2

# 2. Deploy the new build — the API now reads with both keys
#    (all existing ciphertext is still readable via the previous key)

# 3. Dry run the rotation script
DRY_RUN=true \
  CREDENTIAL_ENCRYPTION_KEY_CURRENT=<new-key> \
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS=<old-key> \
  CREDENTIAL_ENCRYPTION_KEY_ID=v2 \
  DATABASE_URL=<url> \
  pnpm --filter @orderhub/api db:rotate-keys

# 4. Apply rotation
CREDENTIAL_ENCRYPTION_KEY_CURRENT=<new-key> \
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS=<old-key> \
  CREDENTIAL_ENCRYPTION_KEY_ID=v2 \
  DATABASE_URL=<url> \
  pnpm --filter @orderhub/api db:rotate-keys

# 5. Verify: release readiness must show encryptedWithOldKey: 0

# 6. Remove CREDENTIAL_ENCRYPTION_KEY_PREVIOUS from the environment
# 7. Rename CREDENTIAL_ENCRYPTION_KEY_CURRENT → CREDENTIAL_ENCRYPTION_KEY
```

### Safety notes

- Never remove `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` before rotation is verified complete
- Never log key hex values — check scripts before running
- The API continues to serve requests during rotation (no downtime)
- The rotation script is idempotent — safe to re-run

---

## Rollback

If the deploy fails and you need to roll back:

1. Stop the API/worker processes
2. Restore the previous build artifact (`dist/`)
3. Point traffic back to the previous instance
4. Prisma migrations are additive and do not need to be rolled back (new columns have defaults)
5. If a migration must be reversed, use `prisma migrate resolve --rolled-back <migration-name>` and run a manual SQL rollback

---

## Post-Deploy Monitoring (First 30 Minutes)

- Watch `GET /api/v1/health/ready` — stays `{ "status": "ok" }`
- Watch `outbox.stuckProcessing` and `outbox.dead` in release readiness
- Watch Bull Board for queue failures
- Confirm first real order received and printer job created
- Confirm signature verification logs no `UnauthorizedException`
