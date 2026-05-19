# Backup and Recovery

> Process for backing up, restoring, and verifying the OrderHub production database.

---

## What Must Be Backed Up

| Data | Table(s) | Criticality | Notes |
|---|---|---|---|
| Tenants | `tenants` | Critical | Platform cannot operate without tenants |
| Locations | `locations` | Critical | Including `goLiveStatus`, `shopCode` |
| Brands | `brands` | Critical | Links locations to tenants |
| Users | `users`, `user_sessions` | Critical | Staff cannot log in without this |
| Integrations | `integrations` | Critical | **Contains encrypted credentials** |
| Orders | `orders`, `order_items`, `order_modifiers` | Critical | Revenue records |
| Outbox events | `outbox_events` | High | In-flight delivery events |
| Print jobs | `print_jobs` | Medium | Recoverable from order data |
| Menus | `menus`, `menu_categories`, `menu_items`, `menu_modifiers` | High | |
| Audit logs | `audit_logs` | High | Compliance and forensics |
| Webhook events | `webhook_events` | Medium | Diagnostic history |
| Printer config | `printers` | High | Flutter app requires shopCode/printer mapping |
| Customers | `customers` | Medium | |

---

## Backup Schedule

| Frequency | Method | Retention |
|---|---|---|
| Continuous (WAL streaming) | Postgres streaming replication | Until replica diverges |
| Hourly | pg_dump snapshot | 48 hours |
| Daily | pg_dump snapshot | 30 days |
| Weekly | pg_dump snapshot | 90 days |
| Pre-deploy | Manual pg_dump before every migration | 30 days |

Recommended: Use managed Postgres (RDS, Supabase, Neon, Cloud SQL) with automated backup enabled. All of the above can be automated by the provider.

---

## Manual Backup (Before Deploy)

Run this before every migration or significant deploy:

```bash
PGPASSWORD="$DB_PASS" pg_dump \
  --host="$DB_HOST" \
  --port="${DB_PORT:-5432}" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --format=custom \
  --no-password \
  --file="backup-$(date +%Y%m%d-%H%M%S).dump"
```

Verify the backup file is non-empty:
```bash
ls -lh backup-*.dump
pg_restore --list backup-*.dump | head -20
```

Store to S3 or equivalent:
```bash
aws s3 cp backup-*.dump s3://orderhub-backups/pre-deploy/
```

---

## Restore Procedure

### 1. Pre-restore checklist

- [ ] Confirm you have the `CREDENTIAL_ENCRYPTION_KEY` that was active when the backup was taken
- [ ] Confirm the API will NOT start before restore is verified (take it offline or set `ENABLE_MAINTENANCE_MODE=true`)
- [ ] Confirm the target database is empty or you are restoring to a new DB

### 2. Stop the API and worker

```bash
systemctl stop orderhub-api
systemctl stop orderhub-worker
```

### 3. Restore

```bash
PGPASSWORD="$DB_PASS" pg_restore \
  --host="$DB_HOST" \
  --port="${DB_PORT:-5432}" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --no-password \
  --clean \
  --if-exists \
  backup-YYYYMMDD-HHMMSS.dump
```

### 4. Re-apply any migrations that ran after the backup

```bash
DATABASE_URL=<url> npx prisma migrate deploy \
  --schema=packages/database/prisma/schema.prisma
```

Only needed if the backup was taken before a migration that has since been applied.

### 5. Verify restore

```bash
# Count key tables
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" <<SQL
SELECT 'tenants' AS tbl, COUNT(*) FROM tenants
UNION ALL SELECT 'locations', COUNT(*) FROM locations
UNION ALL SELECT 'integrations', COUNT(*) FROM integrations
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'users', COUNT(*) FROM users;
SQL
```

Confirm counts match expectations from before the incident.

### 6. Verify credential encryption is intact

```bash
# Should return 0 plaintext
curl -s "https://api.orderhub.io/api/v1/health/release-readiness?tenantId=<id>" \
  -H "Authorization: Bearer <token>" | jq '.checks.credentialEncryption.plaintextCredentials'
```

**CRITICAL:** If restoring a backup from before a credential encryption migration:
- You must have the original `CREDENTIAL_ENCRYPTION_KEY` from when the backup was taken
- Re-run the backfill script if any credentials were plaintext at backup time

### 7. Start the API and worker

```bash
systemctl start orderhub-api
systemctl start orderhub-worker
```

### 8. Smoke test

```bash
CREDENTIAL_ENCRYPTION_KEY=<key> \
  DATABASE_URL=<url> \
  SMOKE_BASE_URL=https://api.orderhub.io \
  SMOKE_TENANT_ID=<id> \
  npx ts-node -P apps/api/tsconfig.json apps/api/src/scripts/smoke-test.ts
```

---

## Encryption Key During Restore

This is the most critical recovery dependency. Without the correct encryption key, integration credentials are unreadable.

**Before every restore, confirm:**
1. You have a copy of `CREDENTIAL_ENCRYPTION_KEY` that was active when the backup was taken
2. If a rotation was in progress: you have both `_CURRENT` and `_PREVIOUS` from that time

**If the key is lost:**
- Integration credentials are unrecoverable from the database
- You must re-enter credentials for every Integration record
- Use the `backfill-credential-encryption.ts` script after re-entry

**Prevent key loss:**
- Store encryption keys in a dedicated secrets manager (AWS SSM Parameter Store, HashiCorp Vault, Doppler)
- Enable versioning in the secrets manager to recover old key values
- Never store encryption keys only in `.env` files or deployment logs

---

## Recovery RTO / RPO Targets (Pilot Phase)

| Target | Value | Notes |
|---|---|---|
| RTO (Recovery Time Objective) | 2 hours | Time to get the system operational after incident |
| RPO (Recovery Point Objective) | 1 hour | Maximum data loss window |

Achieve with:
- Hourly backups retained for 48 hours
- Streaming replication to a hot standby
- Runbook bookmarked by on-call engineer

---

## Post-Recovery Checklist

- [ ] Smoke test passes (exit code 0)
- [ ] Health endpoint returns `status: ok`
- [ ] Release readiness score ≥ 70
- [ ] `plaintextCredentials: 0`
- [ ] `outbox.dead: 0`
- [ ] At least one active integration per location
- [ ] Test order received and printed successfully
- [ ] Audit log confirms recovery event recorded
