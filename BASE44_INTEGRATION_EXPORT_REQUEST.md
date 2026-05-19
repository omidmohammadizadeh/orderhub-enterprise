# Base44 Integration Export Request

> Phase Y — 2026-05-19  
> This document lists exactly what we need extracted from the old Base44 implementation  
> before building or validating any provider integration in OrderHub.
>
> **Important**: Do not build against guesses. Extract these first.

---

## Why We Need This

The Base44 system was our previous working implementation that processed real orders from Uber Eats, Deliveroo, Just Eat, and HubRise. It has proven, working flows with real provider credentials and real webhook exchanges. Before extending or modifying any provider integration in OrderHub, we must compare our implementation against what Base44 actually did.

---

## Section 1 — For Each Provider: Uber Eats, Deliveroo, Just Eat, HubRise

### 1.1 Webhook Endpoint Configuration

For each provider, export:
- [ ] The exact webhook URL format registered with the provider (e.g. `/api/webhooks/uber-eats/{restaurantId}`)
- [ ] The query string format and what the locationId/restaurantId parameter maps to
- [ ] The HTTP method (POST/GET)
- [ ] Any custom headers the provider requires on registration
- [ ] The signature header name (e.g. `x-uber-signature`)
- [ ] The signature algorithm and encoding (SHA256 hex vs base64, etc.)
- [ ] Whether the webhook URL included a static token or secret in the path

### 1.2 Authentication / Credentials

For each provider, export:
- [ ] What credential fields were stored per integration (exact field names)
- [ ] Whether OAuth2 was used and which grant type (client_credentials vs authorization_code)
- [ ] The OAuth2 token endpoint URL
- [ ] What scopes were requested
- [ ] How the access token was passed in provider API calls (Bearer header, API key header, etc.)
- [ ] Whether a refresh_token was used and stored
- [ ] Token expiry handling strategy
- [ ] Any provider-specific credential fields (e.g. restaurant_uuid, store_id, branch_id)

### 1.3 Order Receive — Webhook Payload Samples

For each provider, export at minimum:
- [ ] 3 real (anonymized) webhook payload samples for new order events
- [ ] 1 sample for an order update/cancel webhook (if received)
- [ ] The exact event type field and value that signals a new order
- [ ] Any events that should be IGNORED (and why)
- [ ] Samples showing both delivery and collection/pickup orders

### 1.4 Order Accept

For each provider, export:
- [ ] The exact API endpoint URL (with base URL)
- [ ] HTTP method
- [ ] Request headers required
- [ ] Request payload (full JSON example)
- [ ] Expected response on success
- [ ] Expected response on failure (e.g. 409 already accepted)
- [ ] Whether retry is safe (idempotent)

### 1.5 Order Reject / Cancel

For each provider, export:
- [ ] The exact API endpoint URL
- [ ] HTTP method
- [ ] Request headers
- [ ] Request payload with `reason` field values and accepted enum values
- [ ] Expected response

### 1.6 Status Updates (Ready, Preparing, Dispatched, Completed)

For each provider, export:
- [ ] Which status transitions are supported by the provider API
- [ ] Which transitions require an API call vs can be silently skipped
- [ ] Exact endpoint, method, payload for each supported transition
- [ ] Any timing constraints (e.g. can't mark ready before accepting)

### 1.7 Store Open / Close / Pause

For each provider, export:
- [ ] Whether Base44 implemented store open/close via the provider API
- [ ] If yes: endpoint URL, method, payload, response
- [ ] Any approval or partnership tier required
- [ ] Whether "pause" is a separate operation from "close"

### 1.8 Item Availability

For each provider, export:
- [ ] Whether Base44 implemented item pause/unpause via provider API
- [ ] If yes: endpoint URL, method, payload (item ID format)
- [ ] How the provider item ID maps to our menu item ID

### 1.9 Menu Sync

For each provider, export:
- [ ] Whether Base44 implemented menu import or publish
- [ ] If yes: direction (pull from provider / push to provider)
- [ ] Endpoint URLs
- [ ] Menu structure format (category → item → modifier group)
- [ ] How menu item IDs are mapped between systems
- [ ] How pricing is represented (pence, pounds, currency)
- [ ] Any rate limits or batch constraints

### 1.10 Error Handling Logs

For each provider, export:
- [ ] The 5 most common error codes/messages received from provider APIs
- [ ] How Base44 handled 429 (rate limit) responses
- [ ] How Base44 handled 401/403 (auth failure) responses
- [ ] How Base44 handled 422/400 (invalid request) responses
- [ ] Any provider-specific error codes that needed special handling

---

## Section 2 — Uber Eats Specific

- [ ] Exact base URL for Uber Eats Orders API (v1 vs v2 vs v3)
- [ ] The `restaurant_id` or `store_id` format used in API calls
- [ ] Whether the JWT-based auth (`client_credentials`) or per-restaurant tokens were used
- [ ] The `x-uber-request-uuid` header — how it was used for deduplication
- [ ] Courier lifecycle webhook event types and whether any required acknowledgement
- [ ] Sample of courier_assigned webhook payload
- [ ] Whether `eats.order` scope was sufficient or additional scopes were required

---

## Section 3 — Deliveroo Specific

- [ ] Exact base URL for Deliveroo Partner API (consumer-api.deliveroo.com vs developer API)
- [ ] The `restaurant_id` or `site_id` format used in API calls
- [ ] How `deliveroo-signature` was verified — exact HMAC key source
- [ ] v1 vs v2 webhook payload format — which was in use
- [ ] Whether the `sha256=` prefix was included in the signature comparison
- [ ] Any `X-Deliveroo-*` headers used in API calls
- [ ] Whether store availability API was attempted (and error received if not approved)

---

## Section 4 — Just Eat Specific

- [ ] Exact base URL (uk.api.just-eat.io vs uk-api.just-eat.io vs api.just-eat.io)
- [ ] The restaurant identifier format (restaurant ID vs slug)
- [ ] The `x-je-application-id` value and where it comes from
- [ ] How dueDate was calculated — was it configurable or hardcoded?
- [ ] Whether Just Eat sent `event=order_placed` in the webhook body or just the order object
- [ ] The `x-je-signature` encoding — was it base64 or hex?
- [ ] Any Just Eat-specific order status webhook events received after order was accepted
- [ ] Any required Just Eat test environment setup (sandbox credentials, test restaurant IDs)

---

## Section 5 — HubRise Specific

- [ ] The HubRise account ID and location ID format
- [ ] Webhook registration endpoint and how the webhook was created in HubRise
- [ ] The `resource_type` values received (not just `order` — any others?)
- [ ] HubRise order `status` values received and what triggered each
- [ ] How `channel.name` was used to detect origin platform
- [ ] The OAuth2 `authorization_code` flow — was it used or `client_credentials`?
- [ ] The `refresh_token` — was it ever used / rotated?
- [ ] HubRise API base URL (`api.hubrise.com` vs `manager.hubrise.com`)
- [ ] Whether any HubRise menu import was implemented (even partially)
- [ ] The HubRise order status values for our `PREPARING` equivalent (in_preparation?)

---

## Section 6 — Working Flows Known to Work in Base44

Please confirm which of these flows were tested and working in production:

| Flow | Working in Base44? | Notes |
|------|-------------------|-------|
| Uber Eats order receive → accept → ready | | |
| Uber Eats order reject | | |
| Uber Eats token refresh (auto) | | |
| Deliveroo order receive → accept → ready | | |
| Deliveroo order reject | | |
| Deliveroo token refresh | | |
| Just Eat order receive → accept | | |
| Just Eat order reject | | |
| HubRise order receive → all status syncs | | |
| HubRise token refresh | | |
| Uber Eats + HubRise (order comes via HubRise, origin=Uber) | | |

---

## Section 7 — Known Failed or Broken Flows

Please document any flows that were attempted but failed in Base44:

| Flow | What Happened | Root Cause (if known) |
|------|--------------|----------------------|
| | | |

---

## Section 8 — Code Exports Needed

From the Base44 codebase, export (as text/code):

- [ ] The webhook handler function(s) for each provider
- [ ] The order normalization/mapping logic for each provider
- [ ] The API call functions (accept, reject, ready, cancel) for each provider
- [ ] The token refresh logic
- [ ] The credential storage schema/model
- [ ] Any retry/backoff logic
- [ ] Any provider-specific error handling middleware
- [ ] Environment variable names and descriptions

---

## Section 9 — Provider Logs Needed

From Base44 production/staging logs, export:

- [ ] 5 successful order webhook payloads per provider (with PII removed)
- [ ] 5 failed webhook payloads (if any) per provider with error messages
- [ ] Sample API response from provider accept endpoint
- [ ] Sample API error responses (especially 4xx errors)
- [ ] Any 429 response samples with Retry-After header
- [ ] Any token expiry / refresh events in logs

---

## Delivery Format

Please provide exports as:

1. **Code files**: Original source files or excerpts (any language)
2. **Payload samples**: JSON files with PII stripped (replace customer name with "Test Customer", phone with "+447000000000", address with "1 Test Street, London, SW1A 1AA")
3. **Environment variables**: List of variable names only (not values) — we will source values separately
4. **Confirmation table**: Fill in Section 6 and 7 above

Send to: [engineering team contact]  
Priority: HIGH — blocks Just Eat and HubRise production activation

---

## What We Are NOT Asking For

- Real customer PII
- Real payment data
- Real API credentials or secrets
- Database dumps with real orders
- Access to Base44 production environment

All we need is the implementation logic and sanitized payload examples.
