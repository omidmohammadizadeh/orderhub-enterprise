# OrderHub Enterprise — Stabilization Report

**Audit date:** 2026-05-18  
**Branch:** claude/xenodochial-brahmagupta-5521f8  
**Auditor:** Claude Code (automated production-readiness audit)

---

## Executive Summary

OrderHub is a well-architected multi-tenant restaurant SaaS. The core ingest path (webhook → order → queue → processor) is sound and the most dangerous concurrency bug (TOCTOU in `ingestCanonical`) has already been fixed. Several subsystems are production-ready stubs or incomplete integrations. The findings below are graded by confirmed code evidence.

---

## 1. Findings by Category

### 1.1 Concurrency / Race Conditions

#### FIXED — TOCTOU in `ingestCanonical`
**File:** `apps/api/src/modules/orders/orders.service.ts:52–161`

The pre-check + create pattern was replaced with attempt-first + catch-P2002. The DB unique constraint on `(externalId, platform)` (schema line 624) plus the idempotency key `@unique` (schema line 600) are the authoritative deduplication mechanisms. Concurrent duplicate webhooks now resolve cleanly.

#### FIXED — Sync job ID race in `OrderProcessingProcessor`
**File:** `apps/worker/src/processors/order-processing.processor.ts:71–79`

Deterministic jobId `sync-${orderId}-${toStatus}` prevents duplicate sync-status queue entries on Redis restart or double-delivery. This is correct.

#### ACTIVE — `updateStatus` optimistic lock is correct but incomplete
**File:** `apps/api/src/modules/orders/orders.service.ts:230–263`

`updateMany` with `where: { id, updatedAt: order.updatedAt }` is a correct optimistic lock. However, the `ORDER_JOBS.STATUS_CHANGE` queue job is enqueued **outside** the transaction (line 267–274). If the process crashes between commit and enqueue, downstream print/sync jobs are silently dropped with no compensation. This is an at-most-once delivery gap.

#### ACTIVE — Stock deduction is not idempotent
**File:** `apps/api/src/modules/inventory/inventory.service.ts:359–446`

`deductStockForOrder` iterates per-item per-ingredient and runs individual transactions. If the worker crashes mid-loop (e.g. after deducting ingredient A but before ingredient B), re-running the job will double-deduct ingredient A. There is no guard against re-running this function for the same `orderId`.

#### ACTIVE — Webhook idempotency has a TOCTOU window
**File:** `apps/api/src/modules/webhooks/webhook-ingestion.service.ts:67–77`

`findUnique` check on `WebhookEvent` (line 67) followed by `create` (line 76) is a read-check-then-write pattern. Two simultaneous duplicate webhook deliveries can both pass the `findUnique` check. The `@@unique([platform, externalEventId])` constraint (schema line 699) will catch the second insert with a P2002, but the error is not caught here — it will propagate as a 500. The fix mirrors what `ingestCanonical` does: wrap in try/catch for P2002.

---

### 1.2 WebSocket / Real-Time Edge Cases

#### ACTIVE — No authentication on WebSocket room join
**File:** `apps/api/src/infrastructure/socket/gateways/orders.gateway.ts:52–60`

`handleJoinRoom` accepts a `locationId` string from the client and joins the socket to `location:{locationId}` without verifying that the authenticated user has access to that location. An authenticated user from Tenant A can join `location:{tenantBLocationId}` and receive live order events for another tenant.

**Severity: CRITICAL** — Cross-tenant data leakage over WebSocket.

#### ACTIVE — No authentication on KDS room join
**File:** `apps/api/src/infrastructure/socket/gateways/kds.gateway.ts:30–35`

Same pattern as the orders gateway. Any connected client can join any KDS location room.

#### ACTIVE — `kds:bump` broadcast is not authenticated
**File:** `apps/api/src/infrastructure/socket/gateways/kds.gateway.ts:38–55`

The `kds:bump` handler broadcasts to all clients in KDS rooms without validating that the emitting socket belongs to a legitimate KDS screen. The `orderId` and `kdsScreenId` fields in the emitted payload are empty strings (line 49–50), which means downstream consumers receive incomplete data.

#### ACTIVE — `SocketService` can silently drop events before init
**File:** `apps/api/src/infrastructure/socket/socket.service.ts:26–31`

`emitToLocation` logs a warning and returns if `this.server` is null, silently dropping the event. During the API startup window (before `afterInit` runs), any webhook-triggered orders will not receive a real-time broadcast. This is a known gap but not compensated by any fallback (e.g. re-emit from worker).

#### ACTIVE — Redis pub/sub failures silently swallowed
**File:** `apps/worker/src/infrastructure/event-publisher.service.ts:40–44`

`publish` catches Redis errors and logs a warning, continuing without the socket event. While this is intentional (order state is correct), it means KDS and print status events can silently disappear with no alerting or retry.

---

### 1.3 Queue / Worker Deadlocks and Reliability

#### ACTIVE — Status-change queue enqueue is outside the DB transaction
**File:** `apps/api/src/modules/orders/orders.service.ts:267–274`

See section 1.1. The queue enqueue is after `prisma.$transaction` commit. A crash between these two steps leaves order status updated in DB but no downstream pipeline triggered.

#### ACTIVE — Print processor marks jobs PRINTED without actual hardware dispatch
**File:** `apps/worker/src/processors/printing.processor.ts:88–114` (IN-PROGRESS)

The processor sleeps 50 ms and marks every print job PRINTED regardless of actual hardware outcome. Operators see "PRINTED" in the dashboard when no physical paper was produced. Kitchen staff have no printout. **This is the highest operational risk for restaurant operations.**

All five hardware bridges (USB, LAN, Epson ePOS, Star CloudPRNT, Cloud relay) are unimplemented. The `BrowserBridge` stub (`apps/api/src/modules/printers/bridge/browser-bridge.ts:13–18`) also returns `success: false` always.

#### ACTIVE — Just Eat outbound status sync is a stub
**File:** `apps/worker/src/sync/platform-sync.factory.ts:117–128` (IN-PROGRESS)

`JustEatSyncClient.syncStatus` always returns `{ success: true }` without making any API call. When a restaurant accepts/cancels a Just Eat order, the platform is never notified, leading to order state divergence and potential re-delivery.

#### ACTIVE — No OAuth token refresh for any platform
**File:** `apps/worker/src/sync/platform-sync.factory.ts` and `apps/api/src/modules/integrations/integrations.service.ts` (IN-PROGRESS)

All platform sync clients read `credentials.accessToken` from the `Integration` record directly. There is no refresh-token rotation or expiry check. When Uber Eats / Deliveroo access tokens expire (typically 1–24 hours), sync calls will silently fail with 401s, and the integration will show no orders but no error until an operator notices.

#### ACTIVE — Bull queue has no Dead Letter Queue handler
**File:** `apps/worker/src/processors/order-sync.processor.ts:91–98`

After `maxAttempts` (5) the job enters Bull's failed set. There is a comment noting "use Bull Board or manual inspection" but no alerting, no retry policy, and no automated recovery. Failed sync jobs are invisible until manually inspected.

#### ACTIVE — `deductStockForOrder` runs per-item transactions in a loop
**File:** `apps/api/src/modules/inventory/inventory.service.ts:393–422`

Each ingredient deduction is a separate `$transaction`. Under high order volume this creates N×M small transactions (N items, M ingredients each). A failure mid-loop produces partial deduction without rollback.

---

### 1.4 Stale State Risks

#### ACTIVE — Printer `isOnline` field has no heartbeat mechanism
**File:** `apps/api/src/modules/printers/printers.service.ts:49–61` (IN-PROGRESS)

`setOnlineStatus` exists as a method but there is no scheduled task, hardware agent, or periodic ping that calls it. Once `isOnline: true` is set (e.g. during printer setup), it remains true indefinitely regardless of whether the printer is reachable. The print job selector in `order-processing.processor.ts:108–109` queries `isOnline: true`, so it will attempt to queue jobs for offline printers.

#### ACTIVE — JWT permissions are embedded in the token at login time
**File:** `apps/api/src/common/guards/roles.guard.ts:74–76`

The roles guard merges `ROLE_PERMISSIONS[user.role]` with `user.permissions` from the JWT payload. If an admin modifies a user's permissions or role after the user has an active JWT (15-minute TTL), the user retains their old permissions until token expiry. This is an acceptable design choice but creates a 15-minute window of stale access.

#### ACTIVE — `getOrderStatus` is unauthenticated and returns order data
**File:** `apps/api/src/modules/ordering/ordering.controller.ts:27–31` and `ordering.service.ts:135–154`

`GET /ordering/orders/:orderId/status` is `@Public()` and accepts any UUID. The response includes `cancelReason`, `estimatedReadyAt`, and timestamps. An attacker can enumerate order IDs (CUIDs are not guessable, but if IDs are exposed elsewhere) and poll status. This is an intentional design for customer tracking but the endpoint is not scoped to the originating customer.

#### ACTIVE — `DailySalesSnapshot` is never populated
**File:** `packages/database/prisma/schema.prisma:1430–1449`

The schema defines `DailySalesSnapshot` and `ItemPerformanceSnapshot` tables but no worker processor or cron job exists to populate them. Analytics dashboards that depend on these tables will return empty data.

---

### 1.5 DB Transaction Risks

#### ACTIVE — `confirmPayment` has a TOCTOU check-then-write
**File:** `apps/api/src/modules/payments/payments.service.ts:233–303`

`confirmPayment` reads `payment.status` outside a transaction (line 239), then updates and inserts ledger entries in a `$transaction` (line 252). A concurrent webhook delivery (Stripe `payment_intent.succeeded` is at-least-once) could call `confirmPayment` twice simultaneously, both passing the idempotency check at line 239 and producing duplicate ledger entries. The idempotent guard (`if (payment.status === SUCCEEDED) return payment`) is not inside a serializable transaction.

#### ACTIVE — `upsertRecipe` deletes then re-creates outside a single atomic operation
**File:** `apps/api/src/modules/inventory/inventory.service.ts:315–338`

`recipeIngredient.deleteMany` followed by `recipe.update` with nested `create` are two separate Prisma calls (not wrapped in `$transaction`). A failure between the delete and the re-create leaves the recipe with no ingredients.

#### ACTIVE — `receivePurchaseOrder` runs per-line transactions
**File:** `apps/api/src/modules/inventory/inventory.service.ts:536–578`

Each purchase order line is processed in its own `$transaction`. Partial failure leaves some lines received and others not, with no rollback of the whole PO.

---

### 1.6 Tenant Isolation Risks

#### ACTIVE — WebSocket room join has no tenant isolation check
**File:** `apps/api/src/infrastructure/socket/gateways/orders.gateway.ts:52–60`

Critical finding documented in section 1.2. Any authenticated user can join any location room by sending the room ID. Since `tenantId` is not validated on join, a Tenant A user can receive Tenant B's real-time order stream.

#### ACTIVE — Integration credentials stored in plaintext JSON
**File:** `apps/api/src/modules/integrations/integrations.service.ts:71, 85, 98`

The `credentials` column (type `Json`) stores platform `accessToken`, `refreshToken`, and API keys as plaintext. The `ENCRYPTION_KEY` env var is defined in `env.validation.ts` and `app.config.ts` but is not used anywhere in the integrations service. A DB breach exposes all platform credentials for all tenants.

#### ACTIVE — TOTP secrets stored in plaintext in `mfa_configs`
**File:** `packages/database/prisma/schema.prisma:1379` comment says "AES-256 encrypted at rest" but `apps/api/src/modules/security/security.service.ts:149, 162–176` shows the secret is stored and retrieved as a plain string without any encrypt/decrypt call. `ENCRYPTION_KEY` is never used here.

#### ACTIVE — Backup codes stored as plaintext strings
**File:** `apps/api/src/modules/security/security.service.ts:108–112, 204–210`

The schema comment says backup codes are "bcrypt-hashed" but the code generates and stores them as plain hex strings and compares them with direct equality (`code === normalizedToken`, line 208). A DB breach exposes all one-time backup codes.

---

### 1.7 Scaling Bottlenecks

#### ACTIVE — Single Redis instance shared for Bull queues and pub/sub
**File:** `docker-compose.prod.yml:52–73`, `env.validation.ts:20–21`

`REDIS_URL` and `QUEUE_REDIS_URL` default to the same Redis instance. Bull queue operations, real-time pub/sub event publishing, and (if added) session caching all share one Redis. Under high order volume the pub/sub channel can be starved by Bull's internal polling.

#### ACTIVE — `findLiveOrders` has no limit
**File:** `apps/api/src/modules/orders/orders.service.ts:360–370`

`findLiveOrders` fetches all PENDING/ACCEPTED/PREPARING/READY/DISPATCHED orders for a tenant with no pagination. A high-volume location with many concurrent orders could return thousands of rows with full item/history includes on every WebSocket reconnect.

#### ACTIVE — Single worker process (no horizontal scale config)
**File:** `docker-compose.prod.yml:109–131`

The production compose file deploys a single worker container with no replica count and no Bull concurrency config. There is no `concurrency` option set in processor decorators, meaning Bull defaults to 1 concurrent job per queue. This creates a bottleneck under peak order volume.

#### ACTIVE — `syncMenuItemAvailability` is O(N×M) with no batching
**File:** `apps/api/src/modules/inventory/inventory.service.ts:607–657`

The sync function iterates over all tracked menu items, then for each item iterates over all recipe ingredients, issuing a `findUnique` DB query per ingredient (N×M queries). Under a large menu this can produce hundreds of sequential queries and block the worker thread.

---

### 1.8 Security

#### ACTIVE — No MFA enforcement on sensitive operations
**File:** `apps/api/src/modules/security/security.service.ts:196–218`

`verifyMfaToken` exists but there is no guard or middleware that enforces MFA before sensitive actions (password reset, role changes, billing operations). MFA is optional and not enforced anywhere in the request pipeline.

#### ACTIVE — TOTP `verifyTotp` uses string equality, not timing-safe comparison
**File:** `apps/api/src/modules/security/security.service.ts:100–106`

`computeTotp(secret, counter + i) === token` (line 103) uses JavaScript string equality, which is not constant-time. An attacker with network-level timing measurement could potentially reduce the TOTP search space. The window is small (6 digits) but the correct fix is `crypto.timingSafeEqual`.

#### ACTIVE — `x-request-id` header is reflected from client
**File:** `apps/api/src/common/middleware/request-id.middleware.ts:12–13`

The client-supplied `x-request-id` is accepted and reflected into the response header without sanitization. This is a minor header injection vector — a client can control what appears in server logs for correlation purposes, potentially injecting log-forging strings.

#### ACTIVE — CORS is a single origin, not validated per-tenant
**File:** `apps/api/src/main.ts:39–44`

`origin: process.env.APP_URL ?? "http://localhost:3000"` is a single string. White-label tenants with custom domains cannot connect from their own domains without changing this env var, which affects all tenants. Custom domain CORS support is not implemented.

#### ACTIVE — Maintenance mode does not protect webhook endpoints
**File:** `apps/api/src/common/middleware/maintenance.middleware.ts:6–10`

`ALLOWED_PATHS` only includes health check paths. During maintenance, platform webhooks (Uber Eats, Deliveroo) will receive 503 responses, causing the platforms to retry and potentially drop orders when maintenance ends if their retry windows are exceeded.

---

## 2. Known Issues Status

| Issue | Status | Evidence |
|-------|--------|----------|
| TOCTOU race in `ingestCanonical` (P2002 catch) | **FIXED** | `orders.service.ts:62, 142–159` |
| Deterministic sync jobId race | **FIXED** | `order-processing.processor.ts:71–79` |
| Printing processor stub (no hardware) | **IN-PROGRESS** | `printing.processor.ts:88–96` |
| Just Eat sync stub | **IN-PROGRESS** | `platform-sync.factory.ts:117–128` |
| OAuth token refresh | **IN-PROGRESS** | No refresh logic in any sync client |
| Printer heartbeat / `isOnline` stale state | **IN-PROGRESS** | `printers.service.ts:49–61` (method exists, not called) |

---

## 3. File Reference Index

| File | Key Issues |
|------|-----------|
| `apps/api/src/modules/orders/orders.service.ts` | Status-change enqueue outside transaction (L267) |
| `apps/worker/src/processors/printing.processor.ts` | Hardware stub (L88–96) |
| `apps/worker/src/processors/order-processing.processor.ts` | Correct, P2002-safe |
| `apps/api/src/infrastructure/socket/gateways/orders.gateway.ts` | No room-join auth (L52–60) |
| `apps/api/src/infrastructure/socket/gateways/kds.gateway.ts` | No room-join auth, empty bump payload (L38–55) |
| `apps/worker/src/sync/platform-sync.factory.ts` | Just Eat stub (L117–128), no OAuth refresh |
| `apps/api/src/modules/printers/printers.service.ts` | No heartbeat caller |
| `apps/api/src/modules/security/security.service.ts` | TOTP timing (L103), plaintext secrets (L162), plaintext backup codes (L108) |
| `apps/api/src/modules/payments/payments.service.ts` | `confirmPayment` TOCTOU (L233–239) |
| `apps/api/src/modules/inventory/inventory.service.ts` | Non-idempotent deduction (L359), upsertRecipe race (L315), `prisma as any` |
| `apps/api/src/modules/integrations/integrations.service.ts` | Plaintext credentials (L71, 85, 98) |
| `apps/api/src/modules/webhooks/webhook-ingestion.service.ts` | Webhook P2002 not caught (L67–77) |
| `packages/database/prisma/schema.prisma` | `mfa_configs.secret` comment vs reality (L1379) |
| `apps/api/src/common/middleware/maintenance.middleware.ts` | Webhooks blocked in maintenance (L6–10) |
