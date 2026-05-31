# Phase AN — Locations + Brands foundation

Deliverect-style Location management. Builds the operational `/dashboard/locations` page, the tabbed Location editor (General / Opening Hours / Brands), a standalone Opening Hours drawer, a Busy Mode drawer, and the placeholder Brand × Platform connection grid for Just Eat, Uber Eats, Deliveroo, HubRise, Stuart, Uber Direct.

## What ships

### API

- **Migration `20260601000000_phase_an_locations`** — adds Location columns (`about`, `logoUrl`, `customDomain`, `customDomainStatus`, `onlineOrderingSlug`, `stripeConnectedAccountId`, `applicationFeeFixedAmount`, `applicationFeePercentage`, `applicationFeeMode`, structured `addressLine1/2/city/postcode/country`, `status`, `busyModeJson`), Brand columns (`description`, `cuisine`, `isSuspended`, `primaryLocationId`), and the new `brand_platform_connections` table. Idempotent.
- **`LocationsService` extensions** — `generateUniqueSlug`, `setSlug`, `getOpeningHours`, `setOpeningHours`, `copyHoursToLocations`, `setBusyMode`. Pure helpers: `slugifyName`, `buildOnlineOrderingUrl`, `emptyOpeningHours`, `copyDayToDays`, `isOpenAt`, plus the Stripe-fee math trio `customerTotalWithFee`, `applicationFeeAmount`, `merchantPayout`.
- **`LocationsController` extensions** — `GET /v1/locations/:id/online-url`, `POST /v1/locations/:id/generate-slug`, `GET/PATCH /v1/locations/:id/opening-hours`, `POST /v1/locations/:id/opening-hours/apply-to`, `PATCH /v1/locations/:id/busy-mode`.
- **`BrandsService`** — extended with description/cuisine/logoUrl/isSuspended/primaryLocationId, plus `findAll(tenantId, locationId)` returning brands attached to or shared with a location.
- **`BrandConnectionsModule` (new)** — `GET /v1/brand-connections?brandId=…|locationId=…`, `POST /v1/brand-connections` (upsert), `PATCH /v1/brand-connections/:id/disconnect`. Always returns one card per supported platform in the brand listing — missing rows are returned as placeholders.

### Web

- **`/dashboard/locations` page (rewritten)** — list with search, status filter, expandable cards, action chips (POS settings / Opening hours / Brands / Busy mode / More), and per-card detail row when expanded.
- **`LocationEditModal`** — tabbed General / Opening Hours / Brands editor. General tab covers every Phase AN field including slug-generate button with live URL preview, Stripe Connect account, and the four application-fee modes with helper text.
- **`OpeningHoursEditor`** — day rows with toggle + slots, add/remove second slot, copy-to-all-days. Used both inside the modal and the standalone drawer.
- **`OpeningHoursDrawer`** — right-side slide-over wrapping the editor plus apply-to-other-locations multi-select.
- **`BusyModeDrawer`** — toggle, reason, until-time, affected platforms. Saved locally only.
- **`LocationBrandsDrawer`** — list of brands at the location with embedded `BrandPlatformGrid`.
- **`BrandPlatformGrid`** — 6 platform rows per brand, Connect / Edit / Disconnect actions, status chip, store-ID input. Wired to `/v1/brand-connections`.

### Tests

`apps/api/src/modules/locations/__tests__/locations.spec.ts` — 16 cases covering slug normalisation, URL builder, opening-hours helpers (including past-midnight slot wrap), and the Stripe-fee math against the Phase AN spec examples. All passing.

## Stripe application fee — payment rules

Phase AN distinguishes two billing models. Both are honoured by the math helpers.

| Mode | Customer pays | Application fee | Merchant payout |
|------|---------------|-----------------|-----------------|
| `fixed_only` (£0.50 on £10 basket) | £10.50 | £0.50 | £10.00 |
| `percentage_only` (5% on £10 basket) | £10.00 | £0.50 | £9.50 |
| `fixed_and_percentage` (£0.50 + 5%) | £10.50 | £1.00 | £9.50 |
| `none` | £10.00 | £0.00 | £10.00 |

Fixed = added to the customer's bill, forwarded to OrderHub.
Percentage = deducted from the merchant's Stripe payout.

These values feed the future `PaymentIntent.application_fee_amount` split; no PaymentIntent code ships in this phase.

## What's explicitly NOT done yet

- Real OAuth / API connection flows for any of the 6 delivery platforms — `BrandPlatformConnection` rows are placeholders with manual status transitions.
- DNS verification for `customDomain` — column ships with the `not_configured` default and a comment explaining the next-phase verification job.
- Stripe `PaymentIntent.application_fee_amount` write path.
- Pushing busy-mode state to external platforms.
- Logo upload UX — the General tab accepts a logo URL but the actual Supabase Storage signed upload path is still pending (Phase AL-2).
- RBAC — services still use the existing `MANAGER / TENANT_OWNER / PLATFORM_ADMIN` `@Roles()` decorators; per-location manager scoping ships when RBAC lands.

## Files touched

```
packages/database/prisma/migrations/20260601000000_phase_an_locations/migration.sql
packages/database/prisma/schema.prisma
apps/api/src/modules/locations/locations.service.ts
apps/api/src/modules/locations/locations.controller.ts
apps/api/src/modules/locations/__tests__/locations.spec.ts
apps/api/src/modules/brands/brands.service.ts
apps/api/src/modules/brands/brands.controller.ts
apps/api/src/modules/brand-connections/{service,controller,module}.ts
apps/api/src/app.module.ts
apps/web/src/lib/api/locations.client.ts
apps/web/src/app/(dashboard)/dashboard/locations/page.tsx
apps/web/src/components/locations/{location-edit-modal,opening-hours-editor,opening-hours-drawer,busy-mode-drawer,location-brands-drawer,brand-platform-grid}.tsx
apps/web/src/components/ui/platform-logo.tsx
```
