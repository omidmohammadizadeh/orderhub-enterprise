# Backup and Disaster Recovery

## Recovery Objectives

| Objective | Target |
|---|---|
| RPO (Recovery Point Objective) | ≤ 1 hour |
| RTO (Recovery Time Objective) | ≤ 4 hours |
| Data retention (hot) | 90 days |
| Data retention (cold archive) | 7 years (regulatory) |

## PostgreSQL Backup Strategy

### Automated Backups (recommended)

For cloud deployments, use the provider's managed backup:
- **AWS RDS**: automated daily snapshots + point-in-time recovery (PITR) with transaction logs
- **Google Cloud SQL**: automated backups with PITR
- **Neon / Supabase**: built-in PITR

Enable PITR to achieve RPO < 1 hour.

### Self-hosted Backup

If running Postgres on your own server:

```bash
# Daily full backup (run via cron)
pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner \
  "$DATABASE_URL" \
  > "/backups/orderhub_$(date +%Y%m%d_%H%M%S).dump"

# Upload to S3
aws s3 cp "/backups/orderhub_$(date +%Y%m%d).dump" \
  "s3://orderhub-backups/postgres/"

# Verify backup is readable
pg_restore --list "/backups/orderhub_$(date +%Y%m%d).dump" > /dev/null

# Clean up local files older than 7 days
find /backups -name "*.dump" -mtime +7 -delete
```

Set `wal_level = replica` and `archive_mode = on` in `postgresql.conf` for WAL archiving (enables PITR).

### Backup Verification Schedule

| Frequency | Test |
|---|---|
| Weekly | Restore to a test instance and run `prisma migrate status` |
| Monthly | Full recovery drill: restore → apply migrations → run smoke tests |
| On-demand | After any schema migration to confirm backup is pre-migration |

## Redis Persistence Strategy

Redis holds:
1. **BullMQ job queues** — losing these means losing queued/in-flight jobs
2. **Cache** — safe to lose; will be rebuilt on next request

### Configuration

The production `docker-compose.prod.yml` configures Redis with:
- `appendonly yes` — every write persisted to AOF log
- `appendfsync everysec` — flush to disk every second (RPO ≤ 1s for Redis)
- `save 900 1 / save 300 10 / save 60 10000` — RDB snapshots as backup

### What Happens If Redis Is Lost

- **Cache layer**: no user impact; cache misses are handled gracefully
- **Queue data**: jobs in `waiting` state will be lost. In-flight jobs may be reprocessed (Bull jobs are designed for at-least-once delivery via idempotency checks)
- **Recovery**: restart Redis with the AOF file mounted; Bull queues will resume from last persisted state

For production, consider Redis Sentinel (HA) or Redis Cluster to eliminate Redis as a single point of failure.

## Restore Procedure

### Full Database Restore

```bash
# 1. Stop the API and Worker (prevent writes during restore)
docker compose -f docker-compose.prod.yml stop api worker

# 2. Drop and recreate the database
psql "$DATABASE_URL" -c "DROP DATABASE orderhub_prod;"
psql "$DATABASE_URL" -c "CREATE DATABASE orderhub_prod;"

# 3. Restore from backup
pg_restore \
  --format=custom \
  --no-owner \
  --dbname="$DATABASE_URL" \
  "/backups/orderhub_20240115_120000.dump"

# 4. Apply any migrations that were run after the backup
DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy

# 5. Restart services
docker compose -f docker-compose.prod.yml up -d api worker

# 6. Verify
curl http://localhost:4000/api/v1/health/ready
```

### Point-in-time Recovery (AWS RDS)

```bash
# Restore to a specific timestamp
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier orderhub-prod \
  --target-db-instance-identifier orderhub-prod-restore \
  --restore-time 2024-01-15T12:00:00Z

# Update DATABASE_URL to point to the restored instance
# Then apply any missing migrations
```

## Log Retention

| Log type | Hot retention | Archive |
|---|---|---|
| Application logs (Winston) | 30 days in CloudWatch/Datadog | 1 year in S3 Glacier |
| Access logs (Nginx) | 30 days | 1 year |
| Audit logs (DB `audit_logs` table) | Permanent in DB | Export to S3 after 12 months |
| Webhook events (DB) | Permanent in DB | Export to S3 after 12 months |

## Archival Preparation

The `Order`, `WebhookEvent`, `AuditLog`, and `OrderStatusHistory` tables will grow indefinitely. When volume requires it:

1. Export rows older than N months to S3 as Parquet via a scheduled job
2. Delete from the primary table in batches (never bulk-delete — use `DELETE WHERE id IN (SELECT id ... LIMIT 1000)`)
3. Maintain an `orders_archive` S3 prefix queryable via Athena

The `sourceMetadata` and `metadata` JSON fields are designed for CDC (Change Data Capture) extraction to a column store for analytics without burdening the OLTP database.
