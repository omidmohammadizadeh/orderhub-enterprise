# Monitoring and Alerts

> Operational runbook for OrderHub production monitoring.
> This document defines what to monitor, alert thresholds, investigation steps, and resolution paths.

---

## Health Endpoints

| Endpoint | Purpose | Authentication |
|---|---|---|
| `GET /api/v1/health` | Liveness — is the process alive? | None |
| `GET /api/v1/health/live` | Kubernetes liveness probe | None |
| `GET /api/v1/health/ready` | Readiness — DB and Redis connected? | None |
| `GET /api/v1/health/release-readiness?tenantId=<id>` | Full release readiness for a tenant | Bearer token |

The readiness endpoint is the primary health dashboard. Monitor `readyScore`, `outbox`, `credentialEncryption`, and `webhooks` sections.

---

## Critical Alerts

### 1. API Down

**Condition:** `GET /api/v1/health` returns non-200 or times out for > 30s  
**Severity:** P0 — immediate  
**Investigate:**
- Check process logs: `journalctl -u orderhub-api -n 200`
- Check for OOM kill: `dmesg | grep oom`
- Check database/Redis connectivity
- Check disk space: `df -h`

**Resolve:**
- Restart API: `systemctl restart orderhub-api`
- If database is down, bring database up first
- If OOM: increase container memory limit and restart

---

### 2. Worker Down

**Condition:** No Bull queue activity for > 5 minutes during active order period  
**Severity:** P1  
**Investigate:**
- Check worker process logs
- Check Bull Board at `/bull-board` (admin only)
- Check queue depths with `GET /api/v1/health/ready`

**Resolve:**
- Restart worker: `systemctl restart orderhub-worker`
- If queue is backed up, check for stuck jobs in Bull Board

---

### 3. Database Unreachable

**Condition:** `GET /api/v1/health/ready` returns `checks.database.status !== "ok"` for > 30s  
**Severity:** P0  
**Investigate:**
- Check database server/managed service status
- Check network connectivity from API to database
- Check connection pool exhaustion (increase `DATABASE_POOL_MAX` if needed)
- Check for long-running queries: `SELECT * FROM pg_stat_activity WHERE state = 'active'`

**Resolve:**
- If connection pool exhausted: restart API to recycle connections
- If DB server down: bring DB up, then verify with `prisma migrate status`
- If long queries blocking: terminate with `SELECT pg_terminate_backend(pid)`

---

### 4. Redis Unreachable

**Condition:** `GET /api/v1/health/ready` returns `checks.redis.status !== "ok"` for > 30s  
**Severity:** P1  
**Investigate:**
- Check Redis server/managed service status
- Check network connectivity
- Check Redis memory usage: `redis-cli INFO memory`

**Resolve:**
- Restart Redis if necessary
- If memory full: check for key accumulation; adjust `maxmemory-policy`
- API continues operating in degraded mode — queued jobs will retry when Redis recovers

---

### 5. Dead Outbox Events

**Condition:** `outbox.dead > 0` in release readiness  
**Severity:** P1  
**Investigate:**
- Query dead events: `SELECT id, eventType, locationId, lastError FROM outbox_events WHERE status = 'DEAD' LIMIT 20`
- Check `lastError` for root cause
- Check provider status (Uber Eats, Deliveroo) — provider may be down
- Check webhook signature failures in logs

**Resolve:**
1. Fix root cause (provider outage, credential issue, etc.)
2. Reset dead events to PENDING:
   ```sql
   UPDATE outbox_events SET status = 'PENDING', attempts = 0, "lastError" = NULL 
   WHERE status = 'DEAD' AND id IN (<list>);
   ```
3. Confirm `outbox.dead` drops to 0 in next readiness check

---

### 6. Stuck PROCESSING Events

**Condition:** `outbox.stuckProcessing > 0` for > threshold (default 300s)  
**Severity:** P1  
**Investigate:**
- Check outbox dispatcher logs for crashes
- Check if worker process is running
- Check if database is healthy

**Resolve:**
- The `OutboxDispatcherCron` auto-recovers stuck events at the start of each batch (Phase J)
- If not auto-recovering: restart worker process
- If database is slow: events will recover once DB returns to normal latency

---

### 7. Webhook Failures Increasing

**Condition:** `webhooks.<platform>.failedLast24h` increases by > 10 in 1 hour  
**Severity:** P1  
**Investigate:**
- Check `webhookEvent` table: `SELECT platform, processingError, COUNT(*) FROM webhook_events WHERE "processingError" IS NOT NULL AND "createdAt" > NOW() - INTERVAL '1 hour' GROUP BY platform, "processingError"`
- Check provider status page
- Check credential encryption (signature verification may be failing)
- Check for IP whitelist changes at provider

**Resolve:**
- If credential issue: re-enter credentials and re-run backfill
- If provider signing key changed: update `webhookSecret` in Integration record
- If provider is down: events will be replayed when provider recovers

---

### 8. Printer Failed Jobs Increasing

**Condition:** `printJob.status = 'FAILED'` count increases by > 5 in 30 minutes for a location  
**Severity:** P2  
**Investigate:**
- Check printer heartbeat in diagnostics page
- Check Flutter Android app is running and polling
- Check `shopCode` mapping: `SELECT id, name, "shopCode" FROM locations WHERE "shopCode" = '<code>'`
- Check print job records: `SELECT * FROM print_jobs WHERE status = 'FAILED' ORDER BY "createdAt" DESC LIMIT 10`

**Resolve:**
- If printer offline: check network, power, restart printer
- If Flutter app crashed: restart app on tablet
- If `shopCode` mismatch: correct the shopCode in Location record
- Mark failed jobs for retry manually if needed

---

### 9. Credential Decrypt Failures

**Condition:** Any `CREDENTIAL_DECRYPT_FAILED` error in logs  
**Severity:** P1  
**Investigate:**
- Check if `CREDENTIAL_ENCRYPTION_KEY` has changed without running rotation
- Check if `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` is set if rotation is in progress
- Check `kid` field in stored credentials vs. `CREDENTIAL_ENCRYPTION_KEY_ID`

**Resolve:**
- If key was accidentally rotated without migration: restore previous key as `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`
- If credentials are corrupted: re-enter and re-encrypt via integration settings
- See `CREDENTIAL_ENCRYPTION.md` for rotation procedure

---

### 10. Queue Backlog Too High

**Condition:** Bull queue depth > 500 pending jobs  
**Severity:** P2  
**Investigate:**
- Check Bull Board at `/bull-board`
- Check worker process health
- Check for rate limiting or backoff from providers

**Resolve:**
- Scale up workers if infrastructure allows
- Check for jobs stuck in `waiting` state with repeated failures
- Clear permanently-failed jobs from Bull dashboard if safe

---

## Warning Alerts

### 11. Printer Offline

**Condition:** `printer.isOnline = false` for > 5 minutes during operating hours  
**Severity:** P3 (warning)  
**Investigate:**
- Check printer power and network
- Check heartbeat logs
- Check if Flutter app is polling

**Resolve:**
- Restart printer
- Check tablet has network connectivity
- Restart Flutter app on tablet

---

### 12. Provider Last Sync Stale

**Condition:** `integration.lastSyncAt` older than 2 hours for an ACTIVE integration  
**Severity:** P3  
**Investigate:**
- Check provider status page
- Check token refresh logs (token may have expired)
- Check outbox for failed sync events

**Resolve:**
- If token expired: manually trigger token refresh or re-authorise
- If provider down: monitor and wait

---

### 13. Old Encrypted Credentials

**Condition:** `credentialEncryption.encryptedWithOldKey > 0` after rotation window ends  
**Severity:** P3  
**Investigate:**
- Rotation may not have completed
- Check rotation script output

**Resolve:**
- Re-run rotation script: see `CREDENTIAL_ENCRYPTION.md`
- Do not remove `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` until count reaches 0

---

### 14. Location Readiness Score Drops

**Condition:** A LIVE location's readiness score drops below 70  
**Severity:** P2  
**Investigate:**
- Run readiness check: `GET /api/v1/onboarding/locations/<id>/readiness`
- Check blockers and warnings in response
- Common causes: printer offline, dead outbox events, credential issue

**Resolve:**
- Address each blocker in order of criticality
- If location needs immediate pause: use Go-Live Wizard to set status to PAUSED

---

### 15. No Webhook Received From Connected Provider

**Condition:** A LIVE integration has `webhooks.<platform>.lastSuccessAt` older than expected order-delivery window  
**Severity:** P2  
**Investigate:**
- Confirm webhook URL is still registered at provider portal
- Check provider account status
- Check for IP filtering at network level

**Resolve:**
- Re-register webhook URL at provider portal
- Test webhook delivery from provider's testing tool

---

## Pausing a Location

If a LIVE location has a critical issue:

1. Go to `/dashboard/admin/go-live`
2. Select the location
3. Click **PAUSED**
4. Confirm in audit log

Or via API:
```bash
curl -X POST "https://api.orderhub.io/api/v1/onboarding/locations/<id>/transition?tenantId=<tid>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"targetStatus": "PAUSED", "reason": "Critical issue — pausing for investigation"}'
```

When PAUSED, the location's orders continue to be received but the team is alerted that something requires attention. To fully disable a provider, set its Integration status to INACTIVE.

---

## Log Structure

All logs are structured JSON with these fields:

| Field | Notes |
|---|---|
| `timestamp` | ISO 8601 |
| `level` | error / warn / info / debug |
| `context` | NestJS module/service name |
| `message` | Human-readable description |
| `requestId` | Per-request correlation ID |
| `tenantId` | Set when request is tenant-scoped |
| `locationId` | Set for location-specific events |
| `orderId` | Set for order events |

**Fields that must never appear in logs:**
- `JWT_SECRET`
- `CREDENTIAL_ENCRYPTION_KEY` (any variant)
- `credentials` object contents
- `webhookSecret`
- Client secrets
- Access tokens / refresh tokens

The `LoggingInterceptor` strips these before writing structured logs.

---

## Monitoring Recommended Stack

| Concern | Recommended Tool |
|---|---|
| Log aggregation | Datadog Logs / AWS CloudWatch |
| Error tracking | Sentry |
| APM / tracing | Datadog APM / OpenTelemetry |
| Uptime monitoring | Better Uptime / Checkly |
| Queue monitoring | Bull Board (built-in) |
| Database monitoring | PgHero / Datadog Postgres integration |
| Alerting | PagerDuty / Opsgenie |
