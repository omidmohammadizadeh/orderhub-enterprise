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

## API the app uses (all `/api/v1`)

Public: `GET efl/config` (Stripe publishable key), `GET efl/shops` (rating,
delivery fee / min order / ETA window, collection ready time),
`GET efl/shops/:id/menu`.

Customer: `POST efl/shops/:id/checkout`, `GET efl/me` (phone verified,
marketing opt-in), `PATCH efl/me/marketing`, `POST efl/me/phone/start|verify`,
`GET efl/me/orders`, `GET efl/me/orders/:id` (status, PIN, `driverEtaMinutes`;
no driver phone), `GET|POST efl/me/addresses`, `PATCH|DELETE efl/me/addresses/:id`,
`GET efl/me/favourites`, `PUT|DELETE efl/me/favourites/:id`,
`POST efl/me/push`, `POST efl/me/push/unregister`, plus `customer-auth/*`
(sign-in, `me`, delete account).

Signed out, addresses and favourites live on the device; at sign-in they are
copied to the account (addresses only when the account has none), and the
account's lists take over. Push registers on sign-in (asking permission then)
and on each launch when permission was already given; it is skipped until an
EAS project id exists (`extra.eas.projectId` or `EXPO_PUBLIC_EAS_PROJECT_ID`).
Tapping an order update (`data.app === "eatforless"`) opens that order.

## API gaps still open

1. **Sponsored placements / ads** — Featured, Deals and Top brands reuse
   `GET efl/shops` (marked PLACEHOLDER in `HomeScreen.tsx`). Needs
   `GET efl/placements?lat&lng → { featured[], deals[], brands[] }`; headline
   offers (`deal`) appear only in sample data.
2. **Dish search** — Search matches shop names, areas and cuisines only.
   Needs `GET efl/search?q&lat&lng`.
3. **Sign-up email link** — `customer-auth/signup` sends a storefront verify
   link; the app needs a universal link (`eatforless://verify?token=`) or a code.
4. **"You save £x vs other apps"** (design) needs a comparison price per item.
5. **Route polyline** — tracking draws straight legs shop → door; a real route
   (`route: [{lat,lng}]`) would let the car follow streets.
6. **Private calls / messages** (Phase 4) — the Call screen is a stub; needs a
   masked-call endpoint, e.g. `POST efl/me/orders/:id/call → { dialNumber }`.

## Not done yet / next steps

- **Store accounts (Omid):** Apple Developer + App Store Connect app, Google Play
  app, under Eat For Less Ltd. Bundle id/package `com.eatforless.app` is a
  placeholder — change in `app.json` if needed.
- **EAS:** `eas init` (new project, no owner set yet), `eas.json` profiles like
  `apps/driver`, channels for OTA, env vars from `.env.example`. Push tokens need
  the EAS project id, and an APNs key / FCM credentials on that project.
- **Apple Pay:** create merchant id `merchant.com.eatforless.app`, register the
  domain/cert in Stripe for each connected account flow.
- **Google sign-in:** OAuth clients for the new bundle/package + SHA-1, then set
  `EXPO_PUBLIC_GOOGLE_*`; add client ids to `CUSTOMER_APP_GOOGLE_CLIENT_IDS` and
  `com.eatforless.app` to `CUSTOMER_APP_APPLE_BUNDLE_IDS` on Render.
- **Maps keys** for Android (`GOOGLE_MAPS_API_KEY_ANDROID`); iOS uses Apple Maps.
- **Phase 4:** private calls/messages (S2 is a stub screen), driver PIN in the
  driver app (S3).
- Android build not run yet (disk/RAM); test with `npx expo run:android`.
