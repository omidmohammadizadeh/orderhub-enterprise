# Operator Staging Checklist

> Last updated: Phase AA — First Staging Deployment (2026-05-19)
>
> Daily verification list for the staging environment.
> Run through this before any significant testing session or before deploying new code to staging.

---

## Daily Health Check (< 5 minutes)

```bash
export API=https://orderhub-api.onrender.com
export WEB=https://orderhub-web.onrender.com
```

### 1. API Liveness

```bash
curl -s $API/api/v1/health | jq .
```

Expected:
```json
{ "status": "ok" }
```

If not `ok`: check Render Logs → `orderhub-api` for startup errors.

### 2. API Readiness (DB + Redis)

```bash
curl -s $API/api/v1/health/ready | jq .
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

If `database` is down:
- Supabase may be paused (free tier) — visit [app.supabase.com](https://app.supabase.com) to wake it
- Verify `DATABASE_URL` on the API service is correct

If `redis` is down:
- Upstash instance may be suspended — visit [console.upstash.com](https://console.upstash.com)
- Verify `REDIS_URL` starts with `rediss://`

### 3. Frontend Reachable

```bash
curl -s -o /dev/null -w "%{http_code}" $WEB/
```

Expected: `200`

### 4. Worker Connected

Check Render Dashboard → `orderhub-worker` → status should be **Running** (not Failed/Crashed).

---

## Pre-Deploy Checklist

Before deploying new code to staging:

- [ ] All daily health checks pass
- [ ] `pnpm test` passes locally (327/327)
- [ ] `pnpm --filter @orderhub/api type-check` passes
- [ ] `pnpm --filter @orderhub/worker type-check` passes
- [ ] If schema change: new migration file exists in `packages/database/prisma/migrations/`
- [ ] If schema change: `prisma validate` passes locally
- [ ] No production secrets in the commit (`git diff HEAD | grep sk_live` should return nothing)
- [ ] No `localhost` references in production code (`grep -r "localhost" apps/api/src/modules` should return nothing meaningful)

---

## Post-Deploy Verification

After deploying new code to staging:

- [ ] API health → `{ "status": "ok" }`
- [ ] Readiness → `{ "database": "ok", "redis": "ok" }`
- [ ] Startup logs show `Migrations complete.` and `Starting OrderHub API...`
- [ ] No `STARTUP FAILED` in logs
- [ ] Worker logs show no errors after restart
- [ ] Login still works: `admin@demo.orderhub.io` / `Demo1234!`
- [ ] Bull Board reachable (if configured)

---

## Smoke Test (Full)

Run before any significant change or weekly:

```bash
SMOKE_BASE_URL=https://orderhub-api.onrender.com \
SMOKE_TENANT_ID=<demo-tenant-id> \
CREDENTIAL_ENCRYPTION_KEY=<staging-key> \
DATABASE_URL=<supabase-direct-url> \
npx ts-node -P apps/api/tsconfig.json apps/api/src/scripts/smoke-test.ts
```

Expected: all checks pass, exit code 0.

Smoke test checks:
1. Encryption key valid
2. Encryption roundtrip passes
3. Database connected
4. Phase K migration applied
5. Redis connected
6. No plaintext credentials
7. No dead outbox events
8. No stuck PROCESSING events
9. API liveness
10. API readiness
11. Release readiness score ≥ 80
12. Webhook endpoint reachable

---

## Release Readiness Check

```bash
curl -s "https://orderhub-api.onrender.com/api/v1/health/release-readiness?tenantId=<id>" \
  -H "Authorization: Bearer <token>" | jq '.'
```

**All gates must pass before any onboarding:**

| Check | Expected |
|---|---|
| `encryption.keySet` | `true` |
| `credentialEncryption.plaintextCredentials` | `0` |
| `credentialEncryption.encryptedWithOldKey` | `0` |
| `outbox.dead` | `0` |
| `outbox.stuckProcessing` | `0` |
| `readyScore` | `≥ 80` (staging target), `≥ 90` (production gate) |

---

## Order Flow Smoke Test (Manual)

1. Log in at `https://orderhub-web.onrender.com/login`
2. Dashboard → **Orders** → visible with no errors
3. Use sandbox order generator (if available) to create a test order
4. Order appears in Orders page
5. Accept the order → status moves to ACCEPTED
6. Check Bull Board → ORDER_SYNC job ran (if provider integration active)
7. Check outbox → no dead events

---

## Printer Polling Test

From a device with the Flutter printer app (or via curl):

```bash
# Polling endpoint
curl https://orderhub-api.onrender.com/api/v1/print-jobs/pending/SHOP01

# Expected: JSON array (empty if no pending jobs)
# Expected status: 200
# NOT expected: 404 (would indicate routing broken), 500 (would indicate DB error)
```

---

## Webhook Reachability Test

```bash
export API=https://orderhub-api.onrender.com

# Uber Eats webhook — should return 400 (invalid signature), not 404/502
curl -s -o /dev/null -w "%{http_code}" \
  -X POST $API/api/v1/webhooks/uber-eats \
  -H "Content-Type: application/json" \
  -d '{"test": true}'

# Deliveroo webhook — should return 400, not 404/502
curl -s -o /dev/null -w "%{http_code}" \
  -X POST $API/api/v1/webhooks/deliveroo \
  -H "Content-Type: application/json" \
  -d '{"test": true}'

# Stripe webhook — should return 400, not 404/502
curl -s -o /dev/null -w "%{http_code}" \
  -X POST $API/api/v1/webhooks/stripe \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

All three should return `400` (bad request due to missing/invalid signature). A `404` means routing is broken. A `502` means the API is down.

---

## Logs Access

### Via Render Dashboard

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Select `orderhub-api` or `orderhub-worker`
3. Click **Logs** tab
4. Logs stream in real-time

### Filtering Useful Log Patterns

In Render Logs, search for:

| Pattern | Meaning |
|---|---|
| `STARTUP FAILED` | Production startup validation failed |
| `ERROR` | Application errors |
| `Migrations complete` | Startup migration ran successfully |
| `Outbox: claimed` | Outbox dispatcher is running |
| `ORDER_SYNC` | Worker processing order sync job |
| `RATE_LIMITED` | Provider rate limit hit |
| `UnauthorizedException` | Webhook signature verification failed |
| `P1001` | Cannot reach database |
| `P3009` | Migration failed |

---

## Common Fixes

### Supabase paused (free tier)

- Go to [app.supabase.com](https://app.supabase.com) → your project
- Click **Restore project** if paused
- Wait ~2 minutes for restoration
- Re-check health endpoint

### Worker crashed

1. Check Render → `orderhub-worker` → Logs
2. Look for the error in the last 50 lines
3. Common causes:
   - `QUEUE_REDIS_URL not set` → add env var
   - `CREDENTIAL_ENCRYPTION_KEY mismatch` → ensure same key as API
   - Redis TLS error → ensure `rediss://` not `redis://`
4. Fix env var in Render Dashboard → service restarts automatically

### Migrations failed at startup

1. Check `orderhub-api` logs for `P3009` or `P3018`
2. Verify `DIRECT_URL` is the Supabase direct connection (port 5432)
3. Verify Supabase project is not paused
4. In Supabase Dashboard → SQL Editor → run:
   ```sql
   SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 5;
   ```
5. If a migration shows `rolled_back: true`, see `DEPLOYMENT_RUNBOOK.md` → Rollback section

### "Cannot find module" at startup

- Docker image may have stale build
- Trigger a fresh deploy: Render Dashboard → Service → **Manual Deploy** → **Clear build cache and deploy**

---

## Scheduled Checks

| Frequency | Check |
|---|---|
| Daily | API health, readiness, worker status |
| Before each staging test session | Full pre-deploy checklist |
| Weekly | Full smoke test |
| Before any production deploy | All items in RELEASE_CHECKLIST.md Section 10o |
| After each code push to staging | Post-deploy verification |

---

## Escalation

If staging is down and cannot be recovered in 30 minutes:

1. Check [render.statuspage.io](https://render.statuspage.io) for platform incidents
2. Check [status.supabase.com](https://status.supabase.com) for database incidents
3. Check [status.upstash.com](https://status.upstash.com) for Redis incidents
4. If all external services are up: rollback to previous Render deploy
   - Render Dashboard → Service → **Deploys** → click previous deploy → **Redeploy**
