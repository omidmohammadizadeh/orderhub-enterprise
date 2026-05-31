# Release checklist

Run before promoting a build to production. Phase-relevant items only.

## Always

- [ ] `pnpm exec tsc --noEmit` clean in `apps/api`, `apps/web`
- [ ] `pnpm jest` clean across the API workspace
- [ ] `prisma migrate deploy` finishes without errors against the target DB
- [ ] No new env vars without a doc entry + Render setting

## Phase AN — Locations

- [ ] `20260601000000_phase_an_locations` migration applied; structured address columns backfilled from JSON
- [ ] `/dashboard/locations` page loads with at least one location card
- [ ] Create a location through the modal — General fields persist
- [ ] Generate a slug — `GET /v1/locations/:id/online-url` returns the public URL
- [ ] Set opening hours, save, refresh — values persist
- [ ] Apply hours to another location — target updates
- [ ] Toggle busy mode — chip shows on the card
- [ ] Add a brand at a location — appears in Brands tab + drawer
- [ ] Click Connect on a platform — status goes to "Pending"
- [ ] Stripe fee fields persist; helper text matches the chosen mode

## Phase AM — POS operational upgrade

- [ ] Delivery Fee modal saves zones; cart picks up the fee from postcode
- [ ] Promo modal creates a promo; cart Discounts section shows it
- [ ] POS-created order gets a sequential `#N` number
- [ ] Order card payment chip renders correctly for Cash / Paid

## Smoke checks

- [ ] Place a POS test order — PrintJob fires
- [ ] Marketplace test webhook (Just Eat / Uber Eats sandbox) — order appears on board
