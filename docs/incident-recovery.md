# Incident Recovery Guide

## Severity Levels

| Level | Description | Response time | Example |
|---|---|---|---|
| P1 | Complete outage; all orders blocked | 15 min | DB down, API unreachable |
| P2 | Partial outage; some locations affected | 30 min | Integration sync failing, print offline |
| P3 | Degraded; performance impact | 2 hours | High queue depth, slow API |
| P4 | Cosmetic / low impact | 24 hours | Dashboard UI issue, minor metric anomaly |

## Runbooks

---

### P1: API Not Responding

**Symptoms**: Health check returns non-200; alerts firing for all locations

```bash
# 1. Check container status
docker compose -f docker-compose.prod.yml ps

# 2. Check API logs (last 100 lines)
docker compose -f docker-compose.prod.yml logs --tail=100 api

# 3. Check DB connectivity
docker compose -f docker-compose.prod.yml exec api \
  wget -qO- http://localhost:4000/api/v1/health/ready

# 4. If DB is unreachable — check Postgres
docker compose -f docker-compose.prod.yml ps postgres
docker compose -f docker-compose.prod.yml logs --tail=50 postgres

# 5. Force restart API
docker compose -f docker-compose.prod.yml restart api

# 6. If container crashes on start — look for boot errors
docker compose -f docker-compose.prod.yml logs api 2>&1 | grep -i "error\|fatal"
```

**Common causes:**
- Environment variable validation failure → fix `.env.production` and restart
- DB connection exhaustion → check `DATABASE_POOL_MAX`, restart to release connections
- OOM kill → increase container memory limit in compose file

---

### P1: Database Unreachable

```bash
# Check Postgres container
docker compose -f docker-compose.prod.yml ps postgres
docker compose -f docker-compose.prod.yml logs --tail=50 postgres

# Check disk space (full disk will kill Postgres)
df -h

# Check Postgres process
docker compose -f docker-compose.prod.yml exec postgres pg_isready -U orderhub

# Restart Postgres (will cause brief outage — ensure backups exist first)
docker compose -f docker-compose.prod.yml restart postgres

# Monitor reconnection
docker compose -f docker-compose.prod.yml logs -f api | grep -i "database\|prisma\|connect"
```

**If data loss suspected**: Stop all writes immediately, take a snapshot, then investigate.

---

### P2: Queue Processing Stopped

**Symptoms**: Orders arriving but not being processed; queue depth growing

```bash
# Check queue stats via admin API
curl -H "Authorization: Bearer $TOKEN" \
  https://api.orderhub.io/api/v1/admin/queues

# Check worker logs
docker compose -f docker-compose.prod.yml logs --tail=100 worker

# Check Redis
docker compose -f docker-compose.prod.yml exec redis redis-cli ping
docker compose -f docker-compose.prod.yml exec redis redis-cli info memory

# Restart worker (safe — jobs are persisted in Redis)
docker compose -f docker-compose.prod.yml restart worker

# After restart, check failed jobs
curl -H "Authorization: Bearer $TOKEN" \
  https://api.orderhub.io/api/v1/admin/queues/ORDER_PROCESSING/failed
```

---

### P2: Platform Integration Sync Failing

**Symptoms**: Orders accepted in dashboard but status not updating on Uber Eats / Deliveroo

```bash
# Check integration health
curl -H "Authorization: Bearer $TOKEN" \
  https://api.orderhub.io/api/v1/admin/integrations/health

# Check failed sync jobs
curl -H "Authorization: Bearer $TOKEN" \
  https://api.orderhub.io/api/v1/admin/queues/ORDER_SYNC/failed

# Retry all failed sync jobs
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://api.orderhub.io/api/v1/admin/queues/ORDER_SYNC/failed/retry-all

# If platform API is down (check their status page):
# - Uber Eats: status.uber.com
# - Deliveroo: status.deliveroo.com
# Failed jobs will auto-retry with exponential backoff (max 5 attempts)
```

---

### P2: Webhook Events Not Processing

**Symptoms**: Platform orders not appearing in dashboard

```bash
# Check recent webhook events for errors
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.orderhub.io/api/v1/admin/webhooks?hasError=true&limit=20"

# Common causes:
# 1. Webhook secret mismatch — regenerate secret and update both platform and DB
# 2. Integration set to INACTIVE — update status in DB
# 3. Location ID mismatch — check platform config

# Replay a specific failed webhook event
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://api.orderhub.io/api/v1/admin/webhooks/{eventId}/replay
```

---

### P3: High Queue Depth

```bash
# Check queue stats
curl -H "Authorization: Bearer $TOKEN" \
  https://api.orderhub.io/api/v1/admin/queues

# Scale worker horizontally (add more worker instances)
docker compose -f docker-compose.prod.yml up -d --scale worker=3

# Check for stuck/slow jobs
curl -H "Authorization: Bearer $TOKEN" \
  https://api.orderhub.io/api/v1/admin/queues/ORDER_PROCESSING/active
```

---

### Emergency: Force Maintenance Mode

```bash
# Set maintenance mode via env (requires restart)
sed -i 's/ENABLE_MAINTENANCE_MODE=false/ENABLE_MAINTENANCE_MODE=true/' .env.production
docker compose -f docker-compose.prod.yml up -d --no-deps api
```

Or set it without restart by updating the feature flag in your remote config system (if configured).

### Emergency: Rollback to Previous Version

```bash
# Find the previous image tag from CI logs or Docker registry
PREVIOUS_TAG=staging-abc1234

# Deploy the previous image using rolling restart
IMAGE_TAG=$PREVIOUS_TAG docker compose -f docker-compose.prod.yml up -d --no-deps worker
sleep 15
IMAGE_TAG=$PREVIOUS_TAG docker compose -f docker-compose.prod.yml up -d --no-deps api
IMAGE_TAG=$PREVIOUS_TAG docker compose -f docker-compose.prod.yml up -d --no-deps web
```

**Note**: If the previous version has an incompatible schema, the rollback will fail. The forward-fix migration strategy in [migration-playbook.md](migration-playbook.md) prevents this by keeping schema changes backwards-compatible.

## Post-Incident Checklist

- [ ] Incident timeline documented
- [ ] Root cause identified
- [ ] Customer-facing impact assessed (orders lost? orders duplicated?)
- [ ] Affected order IDs identified and reconciled
- [ ] Fix deployed and verified
- [ ] Monitoring alert threshold adjusted if needed
- [ ] Post-mortem scheduled (within 48h for P1/P2)
