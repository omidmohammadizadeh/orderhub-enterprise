# Staging Deployment Status

> Last updated: Phase AA — First Staging Deployment (2026-05-19)
> Branch: `claude/xenodochial-brahmagupta-5521f8`

---

## Deployment Readiness

| Item | Status |
|---|---|
| `render.yaml` Blueprint | ✅ Ready |
| Dockerfile.api | ✅ Ready (startup script wired) |
| Dockerfile.worker | ✅ Ready (startup script wired) |
| Dockerfile.web | ✅ Ready (`output: standalone`) |
| `scripts/start-api.sh` | ✅ Ready (validates env, runs migrations) |
| `scripts/start-worker.sh` | ✅ Ready |
| Prisma schema (`directUrl`) | ✅ Fixed (shadowDatabaseUrl removed) |
| TypeScript errors | ✅ 0 errors |
| Test suite | ✅ 327/327 passing |
| CI workflow (`claude/**` trigger) | ✅ Enabled |
| `DIRECT_URL` in schema | ✅ Added |

---

## Services

| Service | URL | Status |
|---|---|---|
| orderhub-api | TBD — set after first deploy | ⏳ Pending first deploy |
| orderhub-worker | N/A (no HTTP) | ⏳ Pending first deploy |
| orderhub-web | TBD — set after first deploy | ⏳ Pending first deploy |

> Update this file with actual Render URLs after deployment.

---

## External Services

| Service | Provider | Status |
|---|---|---|
| Postgres database | Supabase | ⏳ Credentials collected |
| Redis | Upstash | ⏳ Credentials collected |
| Stripe | Stripe test mode | ⏳ Test keys ready |

---

## Environment Variables

| Service | Variables Set | Status |
|---|---|---|
| orderhub-api | DATABASE_URL, DIRECT_URL, REDIS_URL, QUEUE_REDIS_URL, CREDENTIAL_ENCRYPTION_KEY, STRIPE_* | ⏳ To be set in Render Dashboard |
| orderhub-worker | DATABASE_URL, DIRECT_URL, REDIS_URL, QUEUE_REDIS_URL, CREDENTIAL_ENCRYPTION_KEY | ⏳ To be set in Render Dashboard |
| orderhub-web | NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY | ⏳ To be set in Render Dashboard |

See `ENVIRONMENT_VARIABLES_CHECKLIST.md` for the full checklist.

---

## Verification Checklist

### Infrastructure
- [ ] Supabase project created (Frankfurt region)
- [ ] Upstash Redis created (TLS enabled, Frankfurt region)
- [ ] Render Blueprint deployed from `render.yaml`
- [ ] All env vars set in Render Dashboard
- [ ] First deploy triggered on all 3 services

### API Service
- [ ] Build succeeds (Docker build logs clean)
- [ ] Startup logs: `Migrations complete.`
- [ ] Startup logs: `Starting OrderHub API...`
- [ ] Startup logs: `Production startup validation passed.`
- [ ] `GET /api/v1/health` → `{ "status": "ok" }`
- [ ] `GET /api/v1/health/ready` → database: ok, redis: ok
- [ ] No `STARTUP FAILED` in logs

### Worker Service
- [ ] Build succeeds
- [ ] Worker logs: `Starting Nest application...`
- [ ] No `ERROR: QUEUE_REDIS_URL / REDIS_URL not set`
- [ ] No Redis connection errors in worker logs
- [ ] Worker status: Running (Render Dashboard)

### Web Service
- [ ] Build succeeds
- [ ] `GET /` → 200
- [ ] Login page loads at `/login`
- [ ] No `localhost` references in compiled JS
- [ ] No CORS errors in browser console

### Database
- [ ] All migrations applied (startup logs confirm)
- [ ] Tables verified in Supabase Table Editor:
  - [ ] `tenants`
  - [ ] `orders`
  - [ ] `integrations`
  - [ ] `outbox_events`
  - [ ] `tenant_subscriptions`
  - [ ] `audit_logs`
  - [ ] `print_jobs`
- [ ] Seed data loaded (demo tenant + user)

### End-to-End
- [ ] Login works: `admin@demo.orderhub.io` / `Demo1234!`
- [ ] Dashboard renders without errors
- [ ] Orders page loads
- [ ] KDS page loads
- [ ] Billing page loads
- [ ] Health admin page loads

### Security
- [ ] `DATABASE_URL` not visible in browser network requests
- [ ] `JWT_SECRET` not in any response headers or body
- [ ] `CREDENTIAL_ENCRYPTION_KEY` not in any response
- [ ] `/api/v1/admin/*` endpoints require auth (return 401 without token)

---

## Staging URLs (Fill After Deploy)

```
Web Dashboard:  https://___________________________
API:            https://___________________________
Health:         https://___________________________/api/v1/health
Webhook Uber:   https://___________________________/api/v1/webhooks/uber-eats
Webhook Deliveroo: https://________________________/api/v1/webhooks/deliveroo
Webhook Stripe: https://___________________________/api/v1/webhooks/stripe
Printer Poll:   https://___________________________/api/v1/print-jobs/pending/:shopCode
```

---

## Demo Credentials

| Item | Value |
|---|---|
| Login URL | `https://<staging-web-url>/login` |
| Email | `admin@demo.orderhub.io` |
| Password | `Demo1234!` |
| Tenant | `Demo Restaurant Group` |
| Location | `Burger Co — London Bridge` |
| Shop Code | `loc_demo_001` |

---

## Deployment Log

| Date | Action | Result | Notes |
|---|---|---|---|
| 2026-05-19 | Phase AA prep committed | ✅ | Code fixes, docs created |
| — | First Render deploy | ⏳ | Pending |
| — | Env vars wired | ⏳ | Pending |
| — | Migrations verified | ⏳ | Pending |
| — | Smoke test passed | ⏳ | Pending |

> Update this table as deployment steps are completed.

---

## Known Issues at This Phase

- Staging deployment not yet executed — URLs TBD
- Worker integration tests pending (require live Redis + Bull)
- Provider webhooks not yet registered with Uber Eats / Deliveroo sandboxes
- Stripe webhook endpoint not yet registered in Stripe Dashboard

See `KNOWN_LIMITATIONS.md` for full list.
