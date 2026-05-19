# Render Setup Guide — OrderHub Staging

> Last updated: Phase AA — First Staging Deployment (2026-05-19)
>
> Exact steps to deploy OrderHub to Render using the `render.yaml` Blueprint.
> Follow in order. Takes ~20 minutes end-to-end.

---

## Prerequisites

Before starting:

| Item | Where to get it |
|---|---|
| Render account (paid, to avoid sleep) | [render.com](https://render.com) |
| GitHub repo with `render.yaml` in root | This repo — branch `claude/xenodochial-brahmagupta-5521f8` |
| Supabase project | [supabase.com](https://supabase.com) |
| Upstash Redis | [upstash.com](https://upstash.com) |
| Stripe test keys | [dashboard.stripe.com](https://dashboard.stripe.com) |

---

## Step 1 — Supabase Setup

### 1.1 Create Project

1. Go to [app.supabase.com](https://app.supabase.com) → **New Project**
2. Organisation: your org
3. Name: `orderhub-staging`
4. Region: **Frankfurt (eu-central-1)** — matches Render region
5. Database password: generate a strong one and save it

### 1.2 Get Connection Strings

Go to **Settings → Database → Connection string**:

**Pooled connection** (for `DATABASE_URL`):
- Click **URI** tab
- Select **Transaction** mode
- Copy the connection string — it looks like:
  ```
  postgresql://postgres.PROJECTREF:PASSWORD@aws-0-eu-central-1.pooler.supabase.com:6543/postgres
  ```
- Append `?pgbouncer=true&connection_limit=1` to the end

**Direct connection** (for `DIRECT_URL`):
- Click **URI** tab
- Select **Session** mode (or use the "Connection string" without pooler)
- Copy the connection string — it looks like:
  ```
  postgresql://postgres:PASSWORD@db.PROJECTREF.supabase.co:5432/postgres
  ```

Save both strings — you'll need them in Step 4.

### 1.3 Allow Render IPs

Render uses dynamic IPs. For staging, set **Network → Add Network Restriction** to allow all:
- Go to **Settings → Database → Network Restrictions**
- Add `0.0.0.0/0` (allow all) — acceptable for staging, restrict for production

---

## Step 2 — Upstash Redis Setup

1. Go to [console.upstash.com](https://console.upstash.com) → **Create Database**
2. Name: `orderhub-staging`
3. Type: **Regional**
4. Region: **EU-West-1** (Frankfurt)
5. Enable **TLS** (required)
6. Click **Create**

After creation:
- Copy the **TLS URL** — looks like:
  ```
  rediss://default:TOKEN@YOUR-ID.upstash.io:PORT
  ```
- Use this same URL for both `REDIS_URL` and `QUEUE_REDIS_URL`

---

## Step 3 — Generate Secrets

Run locally and save to a password manager (1Password, Bitwarden, etc.):

```bash
# JWT secrets (must be different)
JWT_SECRET=$(openssl rand -base64 48)
JWT_REFRESH_SECRET=$(openssl rand -base64 48)

# Credential encryption key (64 hex chars)
CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32)

echo "JWT_SECRET=$JWT_SECRET"
echo "JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET"
echo "CREDENTIAL_ENCRYPTION_KEY=$CREDENTIAL_ENCRYPTION_KEY"
```

> These are staging secrets. Never reuse them in production.

---

## Step 4 — Deploy via Render Blueprint

### 4.1 Connect Repository

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Click **New** → **Blueprint**
3. Click **Connect a repository** (if not already connected)
4. Authorise Render to access your GitHub account/org
5. Select the `orderhub-enterprise` repository
6. Click **Connect**

### 4.2 Select Branch

In the Blueprint setup:
- **Branch**: `claude/xenodochial-brahmagupta-5521f8`
- Render will scan for `render.yaml` at the root

### 4.3 Review Services

Render will show three services from `render.yaml`:
- `orderhub-api` (Web Service)
- `orderhub-worker` (Background Worker)
- `orderhub-web` (Web Service)

Click **Apply** to create the services.

> Note: Services will fail their first deploy because required secrets aren't set yet. That's expected. Continue to Step 5.

---

## Step 5 — Set Environment Variables

For each service, go to Render Dashboard → Service → **Environment** tab.

### orderhub-api — Add these manually

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Supabase pooled URL (Step 1.2) | port 6543, `?pgbouncer=true&connection_limit=1` |
| `DIRECT_URL` | Supabase direct URL (Step 1.2) | port 5432, no pooler params |
| `REDIS_URL` | Upstash TLS URL (Step 2) | `rediss://...` |
| `QUEUE_REDIS_URL` | Upstash TLS URL (same as REDIS_URL) | `rediss://...` |
| `CREDENTIAL_ENCRYPTION_KEY` | 64 hex chars (Step 3) | |
| `STRIPE_SECRET_KEY` | `sk_test_...` | From Stripe Dashboard |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | From Stripe Dashboard |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_...` | From Stripe Dashboard |

> `JWT_SECRET` and `JWT_REFRESH_SECRET` are **auto-generated** by Render (`generateValue: true` in render.yaml). No action needed.

> `APP_URL`, `API_PUBLIC_URL`, `SOCKET_CORS_ORIGIN` are **auto-populated** from other service URLs. No action needed.

### orderhub-worker — Add these manually

| Variable | Value |
|---|---|
| `DATABASE_URL` | Same Supabase pooled URL |
| `DIRECT_URL` | Same Supabase direct URL |
| `REDIS_URL` | Same Upstash TLS URL |
| `QUEUE_REDIS_URL` | Same Upstash TLS URL |
| `CREDENTIAL_ENCRYPTION_KEY` | **Same key as API** — must match exactly |

### orderhub-web — Add these manually

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_...` |

---

## Step 6 — Trigger First Deploy

After setting all env vars for `orderhub-api`:

1. Go to `orderhub-api` → **Deploys** tab
2. Click **Manual Deploy** → **Deploy latest commit**
3. Watch the logs — you should see:

```
[startup] OrderHub API startup — ...
[startup] Environment validation passed.
[startup] Applying database migrations...
[startup] Migrations complete.
[startup] Starting OrderHub API...
[Bootstrap] API running on port 4000 [production]
[ProductionStartupService] Production startup validation passed.
```

If startup fails:
- `ERROR: DIRECT_URL is not set` → set DIRECT_URL in Render Dashboard
- `ERROR: DATABASE_URL is not set` → set DATABASE_URL
- `P1001: Can't reach database server` → check Supabase IP allowlist (Step 1.3)
- `P3009: migrate found failed migrations` → check Supabase logs for SQL errors

Then deploy `orderhub-worker`:
- Watch logs for `[NestFactory] Starting Nest application...`
- Worker has no HTTP port — it will show as "Connected" without a URL

Then deploy `orderhub-web`:
- Watch logs for `Ready - started server on 0.0.0.0:3000`

---

## Step 7 — Verify Health

```bash
# Substitute your actual Render URL
export API_URL=https://orderhub-api.onrender.com

# Liveness
curl $API_URL/api/v1/health
# Expected: { "status": "ok" }

# Readiness (DB + Redis)
curl $API_URL/api/v1/health/ready
# Expected: { "status": "ok", "checks": { "database": { "status": "ok" }, "redis": { "status": "ok" } } }
```

---

## Step 8 — Seed the Database

Run from your local machine with the Supabase direct URL:

```bash
# Use the direct URL (port 5432) for seeding — not the pooled URL
DATABASE_URL="postgresql://postgres:PASSWORD@db.PROJECTREF.supabase.co:5432/postgres" \
DIRECT_URL="postgresql://postgres:PASSWORD@db.PROJECTREF.supabase.co:5432/postgres" \
pnpm --filter @orderhub/database db:seed
```

This creates:
- Tenant: `Demo Restaurant Group`
- User: `admin@demo.orderhub.io` / `Demo1234!`
- Brand: `Burger Co`
- Location: `Burger Co — London Bridge`

Verify in dashboard: open `https://orderhub-web.onrender.com/login` and log in.

---

## Step 9 — Custom Domains (Optional)

To use `staging.orderhubsolutions.com` instead of `orderhub-web.onrender.com`:

1. Render Dashboard → `orderhub-web` → **Custom Domains** → **Add Custom Domain**
2. Enter `staging.orderhubsolutions.com`
3. Render shows a CNAME record — add it in your DNS provider
4. Wait for DNS propagation (5–30 minutes)
5. Render auto-provisions SSL

Repeat for `orderhub-api` with `api-staging.orderhubsolutions.com`.

Update the env vars after custom domain is live:
- `APP_URL` on the API service → `https://staging.orderhubsolutions.com`
- `SOCKET_CORS_ORIGIN` on the API service → `https://staging.orderhubsolutions.com`

---

## Troubleshooting

### "P1001: Can't reach database server"

- Supabase free tier may be paused. Go to Supabase Dashboard → project → wake it up.
- Check `DATABASE_URL` is the pooled URL (port **6543**) not direct.
- Check Supabase Network → add `0.0.0.0/0` for staging.

### "P3018: A migration failed to apply"

- The direct URL (`DIRECT_URL`) is wrong or unreachable.
- `DIRECT_URL` must be port **5432** (direct, not pooled).
- Test connectivity: `psql "postgresql://postgres:PASSWORD@db.PROJECTREF.supabase.co:5432/postgres"`

### "CORS error on WebSocket"

- `SOCKET_CORS_ORIGIN` on API service must match the Web service URL exactly.
- Render auto-sets this from `fromService` but verify it matches the actual URL.
- No trailing slash.

### "Worker not processing jobs"

- Check `QUEUE_REDIS_URL` uses `rediss://` (TLS), not `redis://`.
- Both API and Worker must point to the same Upstash instance.
- Check Upstash console → **Data Browser** — you should see Bull keys after first job.

### First deploy takes 10+ minutes

- Normal for Docker builds on Render starter plan.
- Subsequent deploys are faster due to layer caching.
- Build logs show progress.

---

## Service URLs After Deployment

| Service | Render URL | Custom Domain |
|---|---|---|
| Web dashboard | `https://orderhub-web.onrender.com` | `https://staging.orderhubsolutions.com` |
| API | `https://orderhub-api.onrender.com` | `https://api-staging.orderhubsolutions.com` |
| Health | `https://orderhub-api.onrender.com/api/v1/health` | — |
| Uber Eats webhook | `https://orderhub-api.onrender.com/api/v1/webhooks/uber-eats` | — |
| Deliveroo webhook | `https://orderhub-api.onrender.com/api/v1/webhooks/deliveroo` | — |
| Stripe webhook | `https://orderhub-api.onrender.com/api/v1/webhooks/stripe` | — |
| Printer polling | `https://orderhub-api.onrender.com/api/v1/print-jobs/pending/:shopCode` | — |
