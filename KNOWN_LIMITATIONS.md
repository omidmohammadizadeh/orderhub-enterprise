# Known Limitations

Phase-level scope notes — what's deliberately deferred. See each phase report for context.

## Phase AN (Locations + Brands)

- **No OAuth / API connection flow** for Just Eat, Uber Eats, Deliveroo, HubRise, Stuart, Uber Direct. `BrandPlatformConnection` rows are placeholders with manual status transitions.
- **No DNS verification** for `customDomain`. Column ships with `not_configured`; verification job is Phase AO.
- **No Stripe PaymentIntent wiring** for application fees. The math helpers are tested but no charge path uses them yet.
- **No platform push for busy-mode** state. Saved locally; future provider adapters consume it.
- **No timezone-aware open/closed calc**. `isOpenAt` uses server local time — fine while every tenant runs `Europe/London`.
- **No per-location RBAC**. Manager role can edit any location in the tenant; per-location scope ships with the wider RBAC overhaul.
- **Logo upload is URL-only**. Supabase Storage signed-upload path still pending (AL-2).

## Phase AM (POS operational upgrade)

- **No Mapbox / Google Places polygon fences** for delivery zones. Postcode-prefix matcher only.
- **Offline POS sync** is local-storage cart persistence + online/offline banner only. Real offline order queue + conflict resolution is a separate phase.
- **No real card-terminal integration**. Payment method dropdown captures the operator's selection; PaymentIntent ships with Stripe wiring.
- **No promo code combinatorics** (stacking rules). One promo at a time.
