# Eat For Less — customer app

Native React Native (Expo SDK 54, RN 0.81, React 19.1) app for the Eat For Less
marketplace. Design: the approved canvas at
https://claude.ai/artifact/6FvgKmXYEaqEe1R2X3AcHc ("App design" + "Security").

Like `apps/driver`, this app is **outside the pnpm workspace**
(`pnpm-workspace.yaml` has `!apps/eatforless`) and has its own npm lockfile, so
turbo never sees it and it has no `build` script — the Render
`pnpm run build` for api/web/worker cannot pick it up. Use `npm`, not `pnpm`,
in here.

## Run it

```bash
cd apps/eatforless
npm ci
npx expo run:ios            # first time: builds the dev client (~15 min)
npm run start:mock          # sample data, every screen works with no listings
npm start                   # live API (EXPO_PUBLIC_EFL_API_URL)
```

If port 8081 is busy (another Expo app), add `--port 8090` and open
`eatforless://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8090`.

`.env.example` lists every variable. `EXPO_PUBLIC_EFL_MOCK=1` is **dev only**:
`config.ts` ignores it in release builds.

## Layout

| Path | What |
|---|---|
| `App.tsx` | fonts, session hydrate, Stripe, React Query, navigator, animated splash |
| `src/navigation` | native stack + bottom tabs with the custom floating bar |
| `src/api` | `client.ts` (fetch + token + errors), `efl.ts` (every endpoint), `hooks.ts` (React Query), `mock/` (dev sample data) |
| `src/auth` | session store (token in SecureStore), Apple/Google native sign-in |
| `src/state` | basket (one shop, 12 h expiry), addresses, favourites — zustand + AsyncStorage |
| `src/lib` | menu reading, money, Stripe payment, route geometry for the car, motion presets |
| `src/screens` | Splash, Welcome, EmailAuth, Phone (S1), Home, Search, Shop, ItemSheet, Checkout, Address, Tracking, Call (S2 stub), Orders, Account |

Pricing and the nested-modifier tree are **imported from `packages/shared`**
(`@shared/menu-pricing`, `@shared/nested-modifiers`, `@shared/display-price`)
so the app prices a line exactly as the web storefront and the server's
re-pricing do. Metro watches only that folder.

## API gaps (needed from apps/api — not changed here)

1. **Stripe publishable key** — checkout returns `clientSecret` +
   `stripeAccountId` but not the platform publishable key. Add
   `publishableKey` to the `POST efl/shops/:id/checkout` response (or a public
   `GET efl/config`) so it isn't baked into the binary per environment.
2. **Phone-verified flag** — `GET customer-auth/me` doesn't return
   `phoneVerifiedAt` or `eflMarketingOptIn`. The app remembers verification
   per device and falls back to the checkout error. Add both to `me` (or a
   `GET efl/me` returning `{ phoneVerified, phone, marketingOptIn }`).
3. **Driver phone in order status** — `GET efl/me/orders/:id` spreads
   `getOrderStatus`, which includes `driver.phone`. For private calling the EFL
   response should strip it and add `driver.vehicle` / `driver.reg` and a
   masked-call endpoint (Phase 4): `POST efl/me/orders/:id/call → { dialNumber }`.
4. **Route + ETA** — status has `shop`, `destination`, driver `lat/lng` but no
   route polyline or driver ETA. The app draws straight legs. Add
   `route: [{lat,lng}]` (or encoded polyline) and `driverEtaMinutes`.
5. **Shops list extras** — `GET efl/shops` has no delivery-time estimate, rating,
   headline offer, or minimum order. The app approximates time from distance and
   hides rating/offer. Add `etaMinutes`, `rating {value,count}`, `deal`, `minOrder`.
6. **Sponsored placements / ads** — Featured, Deals and Top brands currently reuse
   `GET efl/shops` (marked PLACEHOLDER in `HomeScreen.tsx`). Needs
   `GET efl/placements?lat&lng → { featured[], deals[], brands[] }`.
7. **Search across menus** — Search matches shop names/cuisines only. Dish
   search needs `GET efl/search?q&lat&lng`.
8. **Saved addresses & favourites** — the account holds one address and no
   favourites, so both live on the device. Add `efl/me/addresses` and
   `efl/me/favourites` CRUD.
9. **Sign-up email link** — `customer-auth/signup` sends a storefront verify
   link; EFL needs a universal link (`eatforless://verify?token=`) or a code.
10. **Push** — `customer-push/register-device` requires `brandId`; EFL customers
    belong to no brand. Needs an EFL variant keyed on the customer account.
11. **"You save £x vs other apps"** (design) needs a comparison price per item.

## Not done yet / next steps

- **Store accounts (Omid):** Apple Developer + App Store Connect app, Google Play
  app, under Eat For Less Ltd. Bundle id/package `com.eatforless.app` is a
  placeholder — change in `app.json` if needed.
- **EAS:** `eas init` (new project, no owner set yet), `eas.json` profiles like
  `apps/driver`, channels for OTA, env vars from `.env.example`.
- **Apple Pay:** create merchant id `merchant.com.eatforless.app`, register the
  domain/cert in Stripe for each connected account flow.
- **Google sign-in:** OAuth clients for the new bundle/package + SHA-1, then set
  `EXPO_PUBLIC_GOOGLE_*`; add client ids to `CUSTOMER_APP_GOOGLE_CLIENT_IDS` and
  `com.eatforless.app` to `CUSTOMER_APP_APPLE_BUNDLE_IDS` on Render.
- **Maps keys** for Android (`GOOGLE_MAPS_API_KEY_ANDROID`); iOS uses Apple Maps.
- **Phase 4:** private calls/messages (S2 is a stub screen), driver PIN in the
  driver app (S3).
- Android build not run yet (disk/RAM); test with `npx expo run:android`.
