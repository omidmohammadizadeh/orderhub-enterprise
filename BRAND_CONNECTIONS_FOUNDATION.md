# Brand × Platform connection foundation

Each brand can have a connection per supported delivery platform per location.

## Supported platforms

`JUST_EAT · UBER_EATS · DELIVEROO · HUBRISE · STUART · UBER_DIRECT`

## Data model

`brand_platform_connections` — unique on `(brandId, locationId, platform)`.

| Column | Purpose |
|---|---|
| `status` | `not_connected` · `pending` · `connected` · `suspended` · `error` |
| `externalStoreId` | Platform's store/restaurant ID (e.g. Just Eat shop code) |
| `externalBrandId` | Platform's brand/parent ID where applicable |
| `integrationId` | FK to the existing `integrations` row that holds credentials (filled by the future OAuth flow) |
| `lastSyncAt` / `lastWebhookAt` / `lastError` | Health observability for the connection |

## UI

`BrandPlatformGrid` (web) renders all 6 platforms per brand even when no row exists in the DB — missing rows are merged in-memory as placeholders so the operator always sees the same card layout.

## What's deliberately deferred

- **OAuth / credentials flow** — `Connect` button captures only the external store ID and writes `status = pending`. Real OAuth + credential refresh per platform lands in the next phase.
- **Webhook routing** — `lastWebhookAt` updates wait on the per-platform adapter work.
- **Auto-sync** — no scheduled menu/order sync triggered from these rows yet.
- **Disconnect** clears `status` + IDs but does NOT call the platform to revoke. The future OAuth flow owns that.
