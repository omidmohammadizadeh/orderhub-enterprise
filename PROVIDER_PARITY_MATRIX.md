# Provider Parity Matrix — OrderHub Enterprise

> Phase Y audit — 2026-05-19  
> Compares current OrderHub implementation against working provider flows.  
> Status key: ✅ Implemented & tested | ⚠️ Partial/untested | ❌ Not implemented | 🚫 Provider restriction | 📋 Pending approval | 🔴 NOT PRODUCTION-READY

---

## Summary Table

| Feature | Uber Eats | Deliveroo | Just Eat | HubRise | Direct/POS |
|---------|-----------|-----------|----------|---------|------------|
| **Production approved** | ✅ | ✅ | 🔴 | 🔴 | ✅ |
| Order receive (webhook) | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |
| Accept order | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reject/cancel order | ✅ | ✅ | ✅ | ✅ | ✅ |
| Ready for pickup | ✅ | ✅ | ✅ | ✅ | ✅ |
| Store open/close | ❌ | 📋 | ❌ | ❌ | ✅ |
| Pause/unpause store | ❌ | 📋 | ❌ | ❌ | ✅ |
| Item availability | ❌ | 📋 | ❌ | ❌ | ✅ |
| Menu import | ❌ | ❌ | ❌ | ❌ | ✅ |
| Menu publish | ❌ | 📋 | ❌ | ❌ | ✅ |
| Token/OAuth refresh | ✅ | ✅ | ✅ | ✅ | N/A |
| Webhook signature | ✅ | ✅ | ✅ | ✅ | N/A |
| Deduplication | ✅ | ✅ | ✅ | ✅ | ✅ |
| Credential encryption | ✅ | ✅ | ✅ | ✅ | N/A |
| Retry/backoff | ✅ | ✅ | ✅ | ✅ | ✅ |
| Error handling | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Uber Eats

**Production status: ✅ APPROVED — live at pilot shops**

| Feature | Status | Implementation | Notes |
|---------|--------|---------------|-------|
| Order receive (webhook) | ✅ | `uber-eats.adapter.ts` | event_type=`orders.notification` or `type=ORDER_CREATED` |
| Webhook signature | ✅ | HMAC-SHA256 | Header: `x-uber-signature`, hex encoded, timingSafeEqual |
| Event deduplication | ✅ | Outbox pattern | `(platform, externalEventId)` unique constraint P2002 |
| Webhook acknowledgement | ✅ | Always HTTP 200 | Prevents Uber retry storms |
| Accept order | ✅ | POST `/orders/:id/accept_pos_order` | ~200ms target |
| Reject order | ✅ | POST `/orders/:id/cancel` | Includes `reason_details` |
| Ready for pickup | ✅ | POST `/orders/:id/ready_for_pickup` | |
| PREPARING status | ✅ | No Uber API call | Silently skipped — Uber doesn't require this |
| DISPATCHED status | ✅ | No Uber API call | Silently skipped |
| COMPLETED status | ✅ | No Uber API call | Silently skipped |
| OAuth token refresh | ✅ | `client_credentials` | Via `TokenRefreshService`, refreshes 5 min before expiry |
| Token refresh credentials | ✅ | `UBER_EATS_CLIENT_ID` + `UBER_EATS_CLIENT_SECRET` | Env vars |
| Credential encryption | ✅ | AES-256-GCM | Encrypted at rest in `integrations.credentials` |
| Retry/backoff | ✅ | Bull exponential | 5 attempts, exponential backoff |
| Rate limit (429) | ⚠️ | Caught as error, Bull retries | Retry-After header not parsed |
| Tenant/location mapping | ✅ | Via `integrations.locationId` | One integration record per location per platform |
| Courier lifecycle events | ❌ | Not extracted | `courier_assigned`, `courier_arriving` arrive but are ignored |
| Store open/close | ❌ | Not implemented | Requires Uber Eats POS Partner status |
| Pause store | ❌ | Not implemented | Requires POS Partner status |
| Item availability | ❌ | Not implemented | Requires POS Partner status |
| Menu import from Uber | ❌ | Not implemented | Menu managed directly in Uber dashboard |
| Menu publish to Uber | ❌ | Not implemented | Requires POS Partner status |

**Credential format stored in DB (encrypted):**
```json
{
  "accessToken": "Bearer ...",
  "expiresAt": "2026-05-19T12:00:00Z",
  "webhookSecret": "shared-hmac-secret"
}
```

**Known webhook payload fields used:**
- `event_type`, `order.id`, `order.display_id`, `order.cart.items`, `order.delivery_information`, `order.eater`, `order.payment.charges`, `order.scheduled_at`

---

## Deliveroo

**Production status: ✅ APPROVED — live at pilot shops**

| Feature | Status | Implementation | Notes |
|---------|--------|---------------|-------|
| Order receive (webhook) | ✅ | `deliveroo.adapter.ts` | `event.type=order.created` or bare `order` object |
| Webhook signature | ✅ | HMAC-SHA256 | Header: `deliveroo-signature`, `sha256=` prefix |
| Event deduplication | ✅ | Outbox P2002 | |
| Webhook acknowledgement | ✅ | Always HTTP 200 | |
| Accept order | ✅ | `PUT /orders/:id` `status=accepted` | Deliveroo REST API v2 |
| Reject order | ✅ | `PUT /orders/:id` `status=rejected` | Includes `reject_reason` |
| Mark ready | ✅ | `PUT /orders/:id` `status=ready` | |
| PREPARING/DISPATCHED/COMPLETED | ✅ | No Deliveroo API call | Silently skipped |
| OAuth token refresh | ✅ | `client_credentials` | Via `TokenRefreshService` |
| Token refresh credentials | ✅ | `DELIVEROO_CLIENT_ID` + `DELIVEROO_CLIENT_SECRET` | Env vars |
| Credential encryption | ✅ | AES-256-GCM | |
| Retry/backoff | ✅ | Bull exponential | |
| Rate limit (429) | ⚠️ | Caught as error, Bull retries | No Retry-After parsing |
| Money parsing | ✅ | Both string and integer pence | `parseMoney()` handles both formats |
| Delivery address v1+v2 | ✅ | Both layouts handled | `order.delivery.address` + `order.fulfillment.delivery.address` |
| Store open/close | 📋 | **Not implemented** | Requires Deliveroo POS Partner approval |
| Item pause/unpause | 📋 | **Not implemented** | Requires POS Partner approval |
| Menu publish | 📋 | **Not implemented** | Requires POS Partner approval |
| Tenant/location mapping | ✅ | `integrations.locationId` | |

**Credential format stored in DB (encrypted):**
```json
{
  "accessToken": "Bearer ...",
  "expiresAt": "2026-05-19T12:00:00Z",
  "webhookSecret": "shared-hmac-secret"
}
```

**Known webhook payload fields used:**
- `event.type`, `event.id`, `order.id`, `order.display_reference`, `order.items`, `order.customer`, `order.delivery`, `order.fulfillment`, `order.total`, `order.subtotal_including_tax`

---

## Just Eat / Takeaway

**Production status: 🔴 NOT PRODUCTION-READY**  
**Restriction: Do NOT set any Integration.status = ACTIVE for Just Eat until production validation is complete**

| Feature | Status | Implementation | Notes |
|---------|--------|---------------|-------|
| Order receive (webhook) | ⚠️ | `just-eat.adapter.ts` | Code exists, NOT E2E tested in production |
| Webhook signature | ⚠️ | HMAC-SHA256 base64 | Header: `x-je-signature`, base64 encoded — not live-tested |
| Event deduplication | ✅ | Outbox P2002 | |
| Webhook acknowledgement | ✅ | Always HTTP 200 | |
| Accept order | ⚠️ | `PUT /orders/:id/accept` | dueDate hardcoded to `now + 30min` |
| Reject order | ⚠️ | `PUT /orders/:id/reject` | Code exists, not live-tested |
| Mark ready | ⚠️ | `PUT /orders/:id/ready` | Code exists, not live-tested |
| dueDate calculation | ⚠️ | `now + 30min` | Not configurable per-location — known limitation |
| OAuth token refresh | ⚠️ | `client_credentials` + `x-je-application-id` | Code exists, untested |
| Token refresh credentials | ⚠️ | `JUST_EAT_CLIENT_ID` + `JUST_EAT_CLIENT_SECRET` + `JUST_EAT_APPLICATION_ID` | Env vars |
| Credential encryption | ✅ | AES-256-GCM | |
| Retry/backoff | ✅ | Bull exponential | |
| Store open/close | ❌ | Not implemented | |
| Item availability | ❌ | Not implemented | |
| Tenant/location mapping | ✅ | `integrations.locationId` | |

**What's needed before production approval:**
1. ☐ Live webhook exchange test with Just Eat test environment
2. ☐ Validate `x-je-signature` format against real Just Eat webhook
3. ☐ Confirm `PUT /orders/:id/accept` endpoint and payload format with Just Eat API docs
4. ☐ Configurable `dueDate` per-location prep time setting
5. ☐ End-to-end order flow: webhook received → accepted → ready (with Just Eat test restaurant)
6. ☐ Formal sign-off in `FIRST_REAL_PAID_CUSTOMER_SIGNOFF.md` for first Just Eat shop

**Credential format stored in DB (encrypted):**
```json
{
  "accessToken": "Bearer ...",
  "expiresAt": "2026-05-19T12:00:00Z",
  "webhookSecret": "shared-hmac-secret",
  "applicationId": "app-id-from-je"
}
```

---

## HubRise

**Production status: 🔴 NOT PRODUCTION-READY**  
**Restriction: Do NOT activate paid customers on HubRise as primary provider without close monitoring**

| Feature | Status | Implementation | Notes |
|---------|--------|---------------|-------|
| Order receive (webhook) | ⚠️ | `hubrise.adapter.ts` | `resource_type=order`, code exists, NOT E2E in production |
| Webhook signature | ⚠️ | HMAC-SHA256 hex | Header: `x-hubrise-signature` — not live-tested |
| Event deduplication | ✅ | Outbox P2002 | |
| Webhook acknowledgement | ✅ | Always HTTP 200 | |
| viaHubrise flag | ✅ | `order.viaHubrise = true` | All HubRise orders set this flag |
| Status sync — ACCEPTED | ✅ | `PUT /orders/:id status=accepted` | Via HubRise API |
| Status sync — PREPARING | ✅ | `status=in_preparation` | |
| Status sync — READY | ✅ | `status=ready_for_pickup` | |
| Status sync — DISPATCHED | ✅ | `status=in_delivery` | |
| Status sync — COMPLETED | ✅ | `status=completed` | |
| Status sync — CANCELLED | ✅ | `status=cancelled` | |
| Status sync — REJECTED | ✅ | `status=rejected` | |
| Status routing | ✅ | `viaHubrise=true` routes to HubRise sync | Regardless of original platform |
| Origin platform detection | ✅ | Channel name parsing | `uber_eats`, `deliveroo`, `just_eat` extracted from channel name |
| OAuth token refresh | ⚠️ | `refresh_token` flow | Code exists, untested in production |
| Token refresh credentials | ⚠️ | `HUBRISE_CLIENT_ID` + `HUBRISE_CLIENT_SECRET` | Env vars |
| Credential encryption | ✅ | AES-256-GCM | |
| Retry/backoff | ✅ | Bull exponential | |
| Menu import from HubRise | ❌ | Not implemented | |
| Menu publish to HubRise | ❌ | Not implemented | |
| Item availability sync | ❌ | Not implemented | |
| Customer deduplication | ⚠️ | Mapped but not deduplicated | Against existing CustomerProfile |
| Location mapping | ✅ | Via `integrations.locationId` | |

**What's needed before production approval:**
1. ☐ Live webhook exchange test with HubRise sandbox
2. ☐ Validate `x-hubrise-signature` format
3. ☐ Validate all status mappings against HubRise order lifecycle docs
4. ☐ Test `refresh_token` flow with real HubRise account
5. ☐ First HubRise shop treated as sub-pilot with manual monitoring
6. ☐ Validate `resource_type=order` is the only event type we need to handle

**Credential format stored in DB (encrypted):**
```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "expiresAt": "2026-05-19T12:00:00Z",
  "webhookSecret": "shared-hmac-secret"
}
```

---

## Website / POS / Direct Orders

**Production status: ✅ FULLY OPERATIONAL**

| Feature | Status | Implementation | Notes |
|---------|--------|---------------|-------|
| Manual order creation | ✅ | `POST /v1/orders` | Any authenticated staff/tenant |
| Platform: DIRECT | ✅ | `platform: "DIRECT"` | In canonical order |
| Collection (PICKUP) | ✅ | `fulfillmentType: PICKUP` | |
| Delivery | ✅ | `fulfillmentType: DELIVERY` | |
| Dine-in | ✅ | `fulfillmentType: DINE_IN` | |
| Order pricing | ✅ | Subtotal, tax, deliveryFee, discount, total | All fields accepted |
| Printer job generation | ✅ | Auto on ingest | RECEIPT + KITCHEN_TICKET created |
| KDS ticket creation | ✅ | Dispatched to all active screens | |
| Real-time socket event | ✅ | `order:new` emitted to location room | |
| Status machine enforcement | ✅ | Valid transitions only | |
| Status audit trail | ✅ | `order.statusHistory` JSON | |
| paymentMethod | ⚠️ | Not persisted | UI state only — not stored in Order schema |
| Scheduled orders | ✅ | `scheduledFor` field | |
| Idempotency | ✅ | `idempotencyKey` field | |
| DIRECT orders skip sync | ✅ | No marketplace sync queue job | |
| Tenant isolation | ✅ | All queries scoped to `tenantId` | |

---

## Webhook Ingestion — Common Infrastructure

Applies to all marketplace providers:

| Component | Status | Notes |
|-----------|--------|-------|
| Raw body preservation | ✅ | `NestJS rawBody: true` option enabled |
| Signature verification | ✅ | Per-adapter, all use `timingSafeEqual` |
| Deduplication table | ✅ | `webhook_events` table, P2002 on `(platform, externalEventId)` |
| Outbox pattern | ✅ | Order ingest + outbox event in same transaction |
| `@BillingExempt()` on webhooks | ✅ | Webhooks never blocked by billing state |
| `@Public()` on webhook endpoints | ✅ | No JWT required |
| Throttling | ✅ | 300 webhooks/min per provider slug |
| Unknown platform handling | ✅ | Returns 400 with message |
| No-integration 200 | ✅ | Returns 200 so platform stops retrying |
| Webhook URL format | ✅ | `/api/v1/webhooks/:platform/:locationId` |

---

## Pending Provider Approvals

| Provider | Action | Current Status | Next Step |
|----------|--------|---------------|-----------|
| Deliveroo | Store availability API | Pending POS Partner approval | Apply via Deliveroo Developer Portal |
| Deliveroo | Menu management API | Pending POS Partner approval | Apply via Deliveroo Developer Portal |
| Just Eat | Webhook/API production access | Not requested | Request via Just Eat API team |
| Uber Eats | Menu management (POS Partner) | Not requested | Apply when ready to scale menu sync |

---

## Missing Endpoints by Priority

### P0 — Required for full operational coverage

| Provider | Feature | Why Needed |
|----------|---------|------------|
| Just Eat | Production validation | Cannot safely onboard Just Eat shops |
| HubRise | Production validation | Cannot safely onboard HubRise shops |
| All | Retry-After header parsing | Correct rate limit compliance |

### P1 — High value, needs provider approval

| Provider | Feature | Blocker |
|----------|---------|---------|
| Deliveroo | Store open/close | POS Partner approval |
| Deliveroo | Item pause/unpause | POS Partner approval |
| Uber Eats | Store open/close | POS Partner approval |
| All | Menu publish | Provider-specific API + approval |

### P2 — Future work

| Feature | Notes |
|---------|-------|
| HubRise menu import | Pull menu from HubRise to populate OrderHub |
| HubRise item availability | Sync availability changes to HubRise |
| Just Eat configurable dueDate | Per-location prep time instead of hardcoded +30min |
| Courier lifecycle events (Uber) | Display in dispatch view |
| Customer profile deduplication | Especially for HubRise |
