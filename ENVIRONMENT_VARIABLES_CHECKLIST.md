# Environment Variables Checklist

> Last updated: Phase AA — First Staging Deployment (2026-05-19)
>
> Tick off each variable as you set it in Render Dashboard.
> Never put actual values in this file.

---

## orderhub-api Service

### Auto-set by Render Blueprint (no action needed)

| Variable | Set by | Status |
|---|---|---|
| `NODE_ENV` | `render.yaml` value: `production` | ✅ Auto |
| `PORT` | `render.yaml` value: `4000` | ✅ Auto |
| `JWT_SECRET` | `generateValue: true` in `render.yaml` | ✅ Auto |
| `JWT_REFRESH_SECRET` | `generateValue: true` in `render.yaml` | ✅ Auto |
| `JWT_ACCESS_TTL` | `render.yaml` value: `15m` | ✅ Auto |
| `JWT_REFRESH_TTL` | `render.yaml` value: `7d` | ✅ Auto |
| `LOG_LEVEL` | `render.yaml` value: `info` | ✅ Auto |
| `APP_URL` | `fromService: orderhub-web` | ✅ Auto |
| `API_PUBLIC_URL` | `fromService: orderhub-api` | ✅ Auto |
| `SOCKET_CORS_ORIGIN` | `fromService: orderhub-web` | ✅ Auto |

### Must be set manually in Render Dashboard

| Variable | Description | Format | Set? |
|---|---|---|---|
| `DATABASE_URL` | Supabase pooled connection | `postgresql://postgres.REF:PASS@...pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1` | ☐ |
| `DIRECT_URL` | Supabase direct connection (for migrations) | `postgresql://postgres:PASS@db.REF.supabase.co:5432/postgres` | ☐ |
| `REDIS_URL` | Upstash TLS URL | `rediss://default:TOKEN@....upstash.io:PORT` | ☐ |
| `QUEUE_REDIS_URL` | Upstash TLS URL (can be same as REDIS_URL) | `rediss://default:TOKEN@....upstash.io:PORT` | ☐ |
| `CREDENTIAL_ENCRYPTION_KEY` | AES-256 key | Exactly 64 hex characters | ☐ |
| `STRIPE_SECRET_KEY` | Stripe test secret key | `sk_test_...` | ☐ |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | `whsec_...` | ☐ |
| `STRIPE_PUBLISHABLE_KEY` | Stripe test publishable key | `pk_test_...` | ☐ |

### Optional (provider credentials — set if integrating)

| Variable | Description | Set? |
|---|---|---|
| `UBER_EATS_CLIENT_ID` | Uber Eats sandbox client ID | ☐ |
| `UBER_EATS_CLIENT_SECRET` | Uber Eats sandbox client secret | ☐ |
| `DELIVEROO_CLIENT_ID` | Deliveroo sandbox client ID | ☐ |
| `DELIVEROO_CLIENT_SECRET` | Deliveroo sandbox client secret | ☐ |

---

## orderhub-worker Service

### Auto-set by Render Blueprint

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |

### Must be set manually

| Variable | Description | Must match API? | Set? |
|---|---|---|---|
| `DATABASE_URL` | Same Supabase pooled URL | Yes | ☐ |
| `DIRECT_URL` | Same Supabase direct URL | Yes | ☐ |
| `REDIS_URL` | Same Upstash TLS URL | Yes | ☐ |
| `QUEUE_REDIS_URL` | Same Upstash TLS URL | Yes | ☐ |
| `CREDENTIAL_ENCRYPTION_KEY` | **MUST be identical to API value** | Yes — must match exactly | ☐ |

### Optional

| Variable | Set? |
|---|---|
| `UBER_EATS_CLIENT_ID` | ☐ |
| `UBER_EATS_CLIENT_SECRET` | ☐ |
| `DELIVEROO_CLIENT_ID` | ☐ |
| `DELIVEROO_CLIENT_SECRET` | ☐ |

---

## orderhub-web Service

### Auto-set by Render Blueprint

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `NEXT_TELEMETRY_DISABLED` | `1` |
| `API_URL` | `fromService: orderhub-api` |
| `APP_URL` | `fromService: orderhub-web` |

### Must be set manually

| Variable | Description | Set? |
|---|---|---|
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_...` (same as API `STRIPE_PUBLISHABLE_KEY`) | ☐ |

---

## Pre-Deploy Validation

Before triggering first deploy, verify:

- [ ] All `DATABASE_URL` values end with `?pgbouncer=true&connection_limit=1`
- [ ] All `DIRECT_URL` values use port `5432` (not 6543)
- [ ] All `REDIS_URL` and `QUEUE_REDIS_URL` values start with `rediss://` (TLS)
- [ ] `CREDENTIAL_ENCRYPTION_KEY` is exactly 64 hex characters: `echo -n "$KEY" | wc -c` → should print `64`
- [ ] `CREDENTIAL_ENCRYPTION_KEY` on Worker matches API exactly
- [ ] No Stripe live keys (`sk_live_`) in staging — use `sk_test_` only
- [ ] `DATABASE_URL` does NOT appear in the browser network requests (check DevTools after deploy)

---

## Validation Commands

Run these after deployment to confirm vars are wired correctly:

```bash
export API=https://orderhub-api.onrender.com

# DB + Redis health
curl -s $API/api/v1/health/ready | jq .

# Encryption key wired (readiness check)
curl -s $API/api/v1/health/release-readiness?tenantId=<id> \
  -H "Authorization: Bearer <token>" | jq '.checks.encryption'

# Expected: { "keySet": true, "keyLength": 64, "testEncryptPassed": true }
```

---

## Rotating Secrets

If you need to change a secret after deployment:

1. Generate a new value
2. Go to Render Dashboard → Service → **Environment** → edit the variable
3. Click **Save Changes** — Render will restart the service automatically
4. If rotating `CREDENTIAL_ENCRYPTION_KEY`, follow `DEPLOYMENT_RUNBOOK.md` → Key Rotation section

---

## See Also

- `RENDER_SETUP.md` — step-by-step Render deploy guide
- `PRODUCTION_ENVIRONMENT_TEMPLATE.md` — full variable reference
- `STAGING_ENVIRONMENT.md` — staging setup overview
