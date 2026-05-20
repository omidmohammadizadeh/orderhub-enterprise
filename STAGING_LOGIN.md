# OrderHub — Staging Login Guide

## Service URLs

| Service | URL |
|---------|-----|
| Web Dashboard | https://orderhub-web.onrender.com |
| API (REST + WebSocket) | https://orderhub-api-0re6.onrender.com |
| API Health | https://orderhub-api-0re6.onrender.com/api/v1/health |
| Swagger Docs | N/A (disabled in production) |

---

## Default Credentials

> ⚠️ **These are staging defaults. Rotate all passwords before handling real data.**

### Platform Admin (`PLATFORM_ADMIN`)

Has unrestricted access to all tenants, users, and platform settings.

| Field    | Value                     |
|----------|---------------------------|
| Email    | `admin@orderhub.io`       |
| Password | `Admin!OrderHub2026`      |
| Role     | `PLATFORM_ADMIN`          |
| Tenant   | `orderhub-platform`       |

### Demo Tenant Owner (`TENANT_OWNER`)

Scoped to the "Demo Restaurant Group" tenant with full access to that tenant's data.

| Field    | Value                        |
|----------|------------------------------|
| Email    | `admin@demo.orderhub.io`     |
| Password | `Demo1234!`                  |
| Role     | `TENANT_OWNER`               |
| Tenant   | `demo-restaurant-group`      |

---

## Seeding the Database

### Option A — Full seed (admin + demo data)

```bash
# From repo root — requires DATABASE_URL in your environment
DATABASE_URL="<your-supabase-pooled-url>" pnpm db:seed
```

This runs `packages/database/prisma/seed.ts` which creates:
- System platform tenant (`orderhub-platform`)
- `PLATFORM_ADMIN` user (`admin@orderhub.io`)
- Demo tenant (`demo-restaurant-group`)
- Demo `TENANT_OWNER` (`admin@demo.orderhub.io`)
- Demo brand, location, and menu

All operations are **idempotent** (upsert) — safe to re-run.

### Option B — Bootstrap admin only

Use this when you only need to create/verify the platform admin without touching demo data:

```bash
# From repo root
DATABASE_URL="<your-supabase-pooled-url>" pnpm seed:admin

# Override credentials via env vars
ADMIN_EMAIL=myemail@example.com ADMIN_PASSWORD=MySecurePass123! \
  DATABASE_URL="<url>" pnpm seed:admin
```

### Option C — Render Shell

Open the Render dashboard → **orderhub-api** service → **Shell** tab.

The production runtime image contains `node` only (no pnpm, npx, or tsx).
The bootstrap script is compiled by `nest build` and ships in the image as compiled JS:

```bash
# DATABASE_URL is already injected by Render — just run:
node apps/api/dist/scripts/bootstrap-admin.js

# Override credentials if needed:
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=MyPass123! \
  node apps/api/dist/scripts/bootstrap-admin.js
```

---

## Password Rotation

After first login, change passwords immediately:

1. Log in at https://orderhub-web.onrender.com/login
2. Navigate to **Settings → Account → Security**
3. Update the password
4. Revoke all existing refresh tokens (Settings → Security → Active Sessions → Revoke All)

For environment secrets (JWT_SECRET, CREDENTIAL_ENCRYPTION_KEY), update them in the **Render dashboard** → service → **Environment** tab and trigger a manual redeploy.

---

## Auth Flow Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/auth/login` | POST | Email + password → JWT pair |
| `/api/v1/auth/refresh` | POST | Rotate access + refresh tokens |
| `/api/v1/auth/me` | GET | Current user (requires `Authorization: Bearer <token>`) |
| `/api/v1/auth/logout` | POST | Revoke refresh token |

**Token storage**: Zustand store persisted to `localStorage` under key `orderhub-auth`.  
**Access token TTL**: 15 minutes.  
**Refresh token TTL**: 7 days.

---

## Smoke Test

After seeding, verify the full auth flow:

```bash
# From repo root — test login endpoint directly
curl -s -X POST https://orderhub-api-0re6.onrender.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@orderhub.io","password":"Admin!OrderHub2026"}' | jq .

# Expected: { "accessToken": "...", "refreshToken": "...", "user": { "role": "PLATFORM_ADMIN", ... } }
```

Or run the full infrastructure smoke test:

```bash
SMOKE_BASE_URL=https://orderhub-api-0re6.onrender.com \
SMOKE_WEB_URL=https://orderhub-web.onrender.com \
DATABASE_URL="<url>" \
  npx tsx apps/api/src/scripts/smoke-test.ts
```
