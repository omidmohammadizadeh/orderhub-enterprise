# OrderHub Solutions — Risk Matrix

_Generated: 2026-05-18 | Phase G Stabilization Audit_

---

## Severity Key

| Level | Definition |
|-------|-----------|
| CRITICAL | Data loss, security breach, complete feature failure, production blocker |
| HIGH | Major functionality broken, significant data corruption risk |
| MEDIUM | Degraded functionality, workarounds exist |
| LOW | Minor UX issues, cosmetic, easily mitigated |

---

## Risk Register

| # | Risk | Area | Severity | Likelihood | Impact | Status | Mitigation |
|---|------|------|----------|-----------|--------|--------|-----------|
| R01 | Print processor stub — no physical printing occurs | Operations | **CRITICAL** | Certain | Every kitchen ticket, receipt, label silently "printed" with no paper | IN-PROGRESS | Wire `printing.processor.ts` to hardware bridges (LAN TCP / Epson ePOS / Star) |
| R02 | OAuth tokens expire, platform sync fails permanently | Integration | **CRITICAL** | High (30-day token life) | All outbound order status syncs fail; restaurants see orders stuck; platforms re-dispatch | IN-PROGRESS | Implement `TokenRefreshService` with pre-expiry refresh for Uber Eats, HubRise, Deliveroo |
| R03 | WebSocket room join has no tenant isolation check | Security | **CRITICAL** | Medium (requires auth + known locationId) | Tenant A sees real-time order stream of Tenant B — data breach | OPEN | Validate `location.brand.tenantId === user.tenantId` in gateway `handleJoinRoom` |
| R04 | Just Eat outbound sync stub — platform never notified | Integration | **CRITICAL** | Certain | Restaurants cannot accept/reject Just Eat orders; platform re-dispatches or auto-cancels | IN-PROGRESS | Implement Just Eat Takeaway Partner API calls in `JustEatSyncClient` |
| R05 | Integration credentials stored as plaintext JSON in DB | Security | **CRITICAL** | Medium (requires DB access) | DB breach exposes all platform tokens for all tenants | OPEN | Encrypt credentials at rest using the already-defined `ENCRYPTION_KEY` env var |
| R06 | TOTP backup codes stored as plaintext | Security | HIGH | Medium (requires DB access) | Backup codes fully usable after DB read | FIXED* | Use bcrypt hash comparison (*timing-safe fix applied; plaintext storage still open) |
| R07 | Webhook deduplication TOCTOU (WebhookEvent P2002 not caught) | Reliability | HIGH | High (all platforms send duplicate webhooks) | Unhandled 500 causes platform retry loop; possible order flooding | OPEN | Wrap webhook deduplication create in try/catch for P2002, same pattern as `ingestCanonical` |
| R08 | Stock deduction not idempotent — worker crash causes double-deduction | Inventory | HIGH | Medium (Redis/worker restart) | Negative inventory, incorrect stock reporting | OPEN | Add `deductedAt` guard per orderId in StockMovement; check before deducting |
| R09 | Printer `isOnline` never updated by heartbeat | Operations | HIGH | Certain (no heartbeat exists) | Print jobs routed to offline printers; jobs fail silently; kitchen has no tickets | IN-PROGRESS | Implement 30-second TCP/HTTP heartbeat cron |
| R10 | `confirmPayment` TOCTOU — double ledger entries on Stripe at-least-once | Payments | HIGH | Low-Medium (Stripe sends duplicate webhooks) | Duplicate revenue entries in ledger, incorrect financial reporting | OPEN | Move idempotency check inside `$transaction` with FOR UPDATE semantics |
| R11 | Status-change queue enqueue outside DB transaction | Reliability | HIGH | Low (crash between commit and enqueue) | Order status updated but no print/sync/KDS triggered | OPEN | Transactional Outbox pattern, or deterministic job ID + idempotent re-enqueue on startup |
| R12 | TOTP MFA timing attack (now fixed) | Security | MEDIUM | Very Low | Attacker can reduce TOTP search space via timing | **FIXED** | `timingSafeEqual` applied in `security.service.ts` |
| R13 | Login throttle used wrong throttler name | Security | HIGH | Certain (configuration bug) | Brute force protection on `/auth/login` was inactive | **FIXED** | `@Throttle({ login: ... })` applied in `auth.controller.ts` |
| R14 | No store open/close sync to platforms | Integration | MEDIUM | High (operational need) | Restaurant closed in OrderHub but platforms still accept orders | OPEN | `PlatformAvailabilityService` pushing store status to UberEats/Deliveroo/JustEat |
| R15 | `DailySalesSnapshot` never populated | Analytics | MEDIUM | Certain | Analytics dashboards return empty/zero data instead of real metrics | OPEN | Add analytics snapshot cron job in worker |
| R16 | `findLiveOrders` has no pagination limit | Scalability | MEDIUM | High volume locations | Full table scan returns thousands of rows on every dashboard load | OPEN | Add `take: 200` limit and date filter to `findLiveOrders` |
| R17 | Single Redis for Bull queues AND pub/sub | Scalability | MEDIUM | High traffic | Pub/sub starved by Bull polling under high order volume | OPEN | Separate `QUEUE_REDIS_URL` from `REDIS_URL` in production config |
| R18 | No Socket.IO Redis adapter for horizontal scaling | Scalability | MEDIUM | Multi-pod deploy | WebSocket events lost when API pods > 1 | OPEN | Add `@socket.io/redis-adapter` with existing Redis connection |
| R19 | React Query cache not invalidated on socket events | Frontend | MEDIUM | High | Stale order states overwritten by background refetch | OPEN | Call `queryClient.setQueryData` on `order:updated` event |
| R20 | `upsertRecipe` deletes then re-creates outside transaction | Inventory | MEDIUM | Crash scenario | Recipe left with no ingredients on partial failure | OPEN | Wrap delete+create in `prisma.$transaction` |
| R21 | `receivePurchaseOrder` per-line transactions | Inventory | MEDIUM | Crash scenario | Partial PO receipt with no rollback | OPEN | Single `$transaction` wrapping all line updates |
| R22 | CORS locked to single `APP_URL` | Multi-tenant | MEDIUM | White-label tenants | Custom domain tenants cannot connect to API | OPEN | Dynamic CORS origin validation using `TenantBranding.customDomains` |
| R23 | Maintenance mode blocks webhook endpoints | Integration | MEDIUM | Maintenance windows | Platform orders lost during maintenance if retry window exceeded | OPEN | Add webhook paths to `ALLOWED_PATHS` in `MaintenanceMiddleware` |
| R24 | KDS `kds:bump` emits empty orderId and screenId | Realtime | MEDIUM | KDS usage | KDS clients receive incomplete bump events | OPEN | Populate orderId and screenId from the bump handler payload |
| R25 | `x-request-id` header reflected without sanitization | Security | LOW | Low | Log injection if attacker controls request ID | OPEN | Validate request ID format (UUID) before reflecting |
| R26 | `getOrderStatus` returns data for any UUID | Privacy | LOW | Enumeration risk | Public order tracking returns internal details | OPEN | Scope to customer's own orders via customer token or short-lived tracking token |
| R27 | Worker has no Bull concurrency config | Scalability | LOW | High volume | Default concurrency=1 per queue; single-threaded processing | OPEN | Set `@Process({ concurrency: 4 })` on order processing and sync handlers |
| R28 | `syncMenuItemAvailability` O(N×M) DB queries | Performance | LOW | Large menu | Hundreds of sequential queries blocking worker thread | OPEN | Batch ingredient lookups using `findMany` with `in` filter |
| R29 | JWT permissions stale for 15-min token lifetime | Security | LOW | Role change scenario | Revoked role takes 15 min to take effect | OPEN | Accept as design choice, document in security notes |
| R30 | Socket service silently drops events if server not yet initialized | Reliability | LOW | Startup race | First orders after deploy miss real-time broadcast | OPEN | Queue events during init, flush on `afterInit` |

---

## Risk Summary by Category

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|---------|------|--------|-----|-------|
| Operations | 1 | 1 | 0 | 0 | 2 |
| Integration | 2 | 1 | 1 | 0 | 4 |
| Security | 2 | 1 | 1 | 2 | 6 |
| Reliability | 0 | 2 | 1 | 1 | 4 |
| Payments | 0 | 1 | 0 | 0 | 1 |
| Inventory | 0 | 1 | 2 | 0 | 3 |
| Scalability | 0 | 0 | 3 | 2 | 5 |
| Frontend | 0 | 0 | 1 | 0 | 1 |
| Multi-tenant | 0 | 0 | 1 | 0 | 1 |
| Analytics | 0 | 0 | 1 | 0 | 1 |
| Privacy | 0 | 0 | 0 | 1 | 1 |
| **Total** | **5** | **7** | **11** | **6** | **29** |

---

## Fixed in Phase G

| Risk | Fix |
|------|-----|
| R12 — TOTP timing attack | `timingSafeEqual` in `security.service.ts` |
| R13 — Login throttle misconfiguration | `@Throttle({ login: ... })` in `auth.controller.ts` |
| TOCTOU in `ingestCanonical` | P2002 catch + retry in `orders.service.ts` |
| Sync job ID non-determinism | Deterministic `sync-${orderId}-${toStatus}` |

## Production Blockers (must fix before go-live)

R01, R02, R03, R04, R05 are CRITICAL and must be resolved before accepting real restaurant customers.
