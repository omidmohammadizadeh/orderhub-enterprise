# Integration Compatibility Matrix

> Last updated: Phase H — Production Validation
> Status key: ✅ Implemented & tested in code | ⚠️ Implemented, not E2E tested | ❌ Not implemented | 🚫 Not supported by provider | 📋 Needs credentials/approval

## Uber Eats

| Action | Status | Notes |
|--------|--------|-------|
| Order received via webhook | ✅ | HMAC-SHA256 signature verified, event_type=orders.notification |
| Webhook signature verification | ✅ | timingSafeEqual, x-uber-signature |
| Webhook deduplication | ✅ | P2002 idempotency on (platform, externalEventId) |
| Accept order | ✅ | POST /orders/:id/accept_pos_order |
| Reject/cancel order | ✅ | POST /orders/:id/cancel with reason |
| Ready for pickup | ✅ | POST /orders/:id/ready_for_pickup |
| PREPARING status sync | ✅ | No Uber API call — silently skipped, returns success |
| DISPATCHED status sync | ✅ | No Uber API call — silently skipped |
| COMPLETED status sync | ✅ | No Uber API call — silently skipped |
| Courier assigned webhook | ❌ | Webhook arrives but event_type != orders.notification so it's skipped |
| Courier arriving webhook | ❌ | Same — not extracted as lifecycle event |
| Courier picked up webhook | ❌ | Same |
| Order completed webhook | ❌ | Status update comes from webhook, not currently handled as lifecycle |
| Restaurant delivery flow | ⚠️ | fulfillmentType=MERCHANT_DELIVERY mapped, no special sync |
| Uber delivery flow | ⚠️ | fulfillmentType=PLATFORM_COURIER mapped |
| OAuth token refresh | ✅ | TokenRefreshService refreshes client_credentials 5min before expiry |
| Retry queue | ✅ | Bull exponential backoff, 5 attempts |
| Rate limit handling | ⚠️ | Axios catches 429 as error, job retries — no explicit header parsing |
| Webhook acknowledgement | ✅ | Always returns HTTP 200 to prevent retries |

**Limitation**: Courier lifecycle webhooks (assigned, arriving, picked up) arrive as separate event types that the current adapter ignores. These are display-only — no action required from the restaurant side.

---

## Deliveroo

| Action | Status | Notes |
|--------|--------|-------|
| Order received via webhook | ✅ | event.type=order.created, deliveroo-signature HMAC |
| Webhook signature verification | ✅ | sha256= prefix format, timingSafeEqual |
| Webhook deduplication | ✅ | P2002 idempotency |
| Accept order | ✅ | PUT /orders/:id with status=accepted |
| Reject order | ✅ | PUT /orders/:id with status=rejected + reject_reason |
| Mark ready | ✅ | PUT /orders/:id with status=ready |
| Store open/close | ❌ | Not implemented — no Deliveroo store availability endpoint called |
| Pause/unpause store | ❌ | Not implemented |
| Item availability sync | ❌ | Not implemented |
| Menu publish | ❌ | Not implemented via Deliveroo direct API |
| Webhook acknowledgement | ✅ | Always 200 |
| PREPARING/DISPATCHED/COMPLETED | ✅ | No Deliveroo API call — silently skipped |
| OAuth token refresh | ✅ | client_credentials flow via TokenRefreshService |
| Retry safety | ✅ | Bull retry with exponential backoff |

**Limitation**: Deliveroo's menu management and store availability APIs require Deliveroo POS Partner approval. Store open/close and item pause are pending provider approval.

---

## Just Eat / Takeaway

| Action | Status | Notes |
|--------|--------|-------|
| Order received via webhook | ✅ | x-je-signature HMAC, standard webhook flow |
| Webhook signature verification | ✅ | timingSafeEqual |
| Webhook deduplication | ✅ | P2002 idempotency |
| Accept order | ✅ | PUT /orders/:id/accept with dueDate (+30min) |
| Reject order | ✅ | PUT /orders/:id/reject with reason |
| Mark ready | ✅ | PUT /orders/:id/ready |
| Store open/close | ❌ | Not implemented |
| Item availability | ❌ | Not implemented |
| PREPARING/DISPATCHED/COMPLETED | ✅ | No JE API call — silently skipped |
| OAuth token refresh | ✅ | client_credentials + x-je-application-id |
| Retry safety | ✅ | Bull retry |

---

## HubRise

| Action | Status | Notes |
|--------|--------|-------|
| Order received via webhook | ✅ | resource_type=order, x-hubrise-signature HMAC |
| Webhook signature verification | ✅ | timingSafeEqual |
| Webhook deduplication | ✅ | P2002 idempotency |
| viaHubrise flag set | ✅ | All HubRise orders set viaHubrise=true |
| Status sync (all states) | ✅ | ACCEPTED→accepted, PREPARING→in_preparation, READY→ready_for_pickup, DISPATCHED→in_delivery, COMPLETED→completed, CANCELLED→cancelled, REJECTED→rejected |
| Status sync routing | ✅ | order.viaHubrise=true routes to HubRise sync client regardless of original platform |
| Origin platform detection | ✅ | Channel name parsed for uber_eats/deliveroo/just_eat |
| Menu import from HubRise | ❌ | Not implemented |
| Menu publish to HubRise | ❌ | Not implemented |
| Item availability sync | ❌ | Not implemented |
| Customer mapping | ⚠️ | Customer data mapped from HubRise customer field |
| Location mapping | ⚠️ | Mapped via integration.locationId |
| OAuth token refresh | ✅ | refresh_token flow via TokenRefreshService |
| Retry safety | ✅ | Bull retry |

---

## Website / POS / Direct

| Action | Status | Notes |
|--------|--------|-------|
| Manual order creation | ✅ | POST /v1/orders, DIRECT platform |
| Collection order | ✅ | fulfillmentType=COLLECTION/PICKUP |
| Delivery order | ✅ | fulfillmentType=DELIVERY or MERCHANT_DELIVERY |
| Cash payment state | ⚠️ | paymentMethod field sent but not stored in Order schema |
| Card payment state | ⚠️ | Same |
| Printer job generation | ✅ | RECEIPT + KITCHEN_TICKET auto-created on ingest |
| Kitchen Display visibility | ✅ | KDS tickets created for all active screens |
| Dispatch visibility | ✅ | Order appears in READY status filter |
| Cashier visibility | ✅ | Order appears in READY status filter |
| Status update flow | ✅ | State machine enforced, all transitions valid |
| Real-time UI update | ✅ | Socket events emitted on status change |
| No marketplace sync | ✅ | DIRECT/POS/ONLINE platforms skip sync queue |
