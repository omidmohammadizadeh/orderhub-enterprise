# Order Hub Driver app — state of play

Written 2026-09-20; updated the same day when OTA updates (§9) and the Google
Maps key move (§10) landed. Everything below was read off the repo, not from
memory. Baseline verified: `npm install` + `npm run type-check` in `apps/driver`
is **clean, zero errors**.

---

## 1. Where it lives

`apps/driver` — a standalone Expo app, **excluded from the pnpm workspace**
(`pnpm-workspace.yaml` has `!apps/driver`), so it uses its own `npm` lockfile.
That is why you run `npm install`, not `pnpm install`, inside it.

2,730 lines across 16 files under `src/`, plus a 538-line `App.tsx`:

| File | Lines | What it does |
|---|---|---|
| `App.tsx` | 538 | **The orchestrator.** Owns auth, polls, online state, the location watch, OTA reload timing, routing |
| `src/screens/JobScreen.tsx` | 539 | The job card: map, call, slide-to-confirm, multi-drop swipe |
| `src/services/auth.ts` | 342 | axios client, token refresh, every API call, all the types |
| `src/screens/HomeScreen.tsx` | 260 | Map + online toggle + resume banner (presentational only) |
| `src/services/notifications.ts` | 223 | Push registration, channels, job Accept/Reject actions |
| `src/screens/ChatScreen.tsx` | 190 | Reusable chat (operator + customer), 3s poll |
| `src/screens/OrdersScreen.tsx` | 181 | Active / Delivered / History tabs |
| `src/screens/ProfileScreen.tsx` | 167 | Change password, delete account |
| `src/components/Drawer.tsx` | 156 | Side menu |
| `src/screens/CashUpScreen.tsx` | 136 | Cash-up with date presets + earnings |
| `src/screens/LoginScreen.tsx` | 136 | Email + Google + Apple |
| `src/components/LocationDisclosure.tsx` | 94 | Play-policy disclosure, **platform-split** (see §6) |
| `src/components/SlideToConfirm.tsx` | 82 | The slider |
| `src/services/location.ts` | 71 | Background GPS TaskManager task |
| `src/services/updates.ts` | 82 | OTA check/download (throttled); `App` decides when to reload |
| `src/services/apple.ts` / `google.ts` | 39 / 32 | Native sign-in |

Backend lives in `apps/api/src/modules/driver-app/` (controller, service,
`expo-push.service.ts`, and a `@Global` `expo-push.module.ts`). Driver earnings
and cash-up logic is in `apps/api/src/modules/dispatch/driver-earnings.service.ts`.

## 2. Build and release settings

| Setting | Value |
|---|---|
| Expo name / slug | Order Hub Driver / `orderhub-driver` |
| URL scheme | `orderhubdriver` |
| Version | **1.0.3** (bumped from 1.0.2 when expo-updates landed — it is also the OTA `runtimeVersion`, see §9) |
| Bundle ID (both platforms) | `com.orderhubsolutions.driver` |
| EAS project ID | `b0f31947-3c20-48ef-8537-6e6988a26d7c` |
| EAS owner | `maclondas` |
| Apple Team ID | `ANR7VRQRYT` |
| App Store Connect app ID | `6785099386` |
| `appVersionSource` | `remote` — EAS owns build numbers, so the `buildNumber: "1"` / `versionCode: 1` in app.json are ignored |
| Expo SDK | **54** (`expo ~54.0.36`), React Native 0.81.5, React 19.1.0 |
| Android target | compileSdk **36**, targetSdk **36**, minSdk 24 |
| API base | `https://orderhub-api-0re6.onrender.com/api` (app.json `extra.apiUrl`) |
| OTA updates | `expo-updates` 29, `runtimeVersion` policy `appVersion`, EAS channel per profile (see §9) |

Config is split across two files: **`app.json` holds everything static** — read
it first — and **`app.config.js` is a thin dynamic layer whose only job is to
inject the two Google Maps keys from the environment** so they are not
committed. Expo hands app.json to app.config.js as `config`.

Build profiles in `eas.json`: `development` (dev client, channel
`development`), `preview` (internal APK, channel `preview` — this is the one to
use for testing fixes), `production` (app-bundle + autoIncrement, iOS image
`latest`, channel `production`).

A build needs the maps keys in the environment — on EAS they are project
secrets, locally `apps/driver/.env` (copy `.env.example`):

```bash
cd apps/driver && eas build --profile preview --platform android
```

## 3. Permissions and native config

**Android permissions declared:** INTERNET, ACCESS_NETWORK_STATE, fine +
coarse + **background** location, FOREGROUND_SERVICE, FOREGROUND_SERVICE_LOCATION,
POST_NOTIFICATIONS, VIBRATE, WAKE_LOCK.

**iOS background modes:** `location`, `remote-notification`, `fetch`, with
`NSLocationWhenInUseUsageDescription` and
`NSLocationAlwaysAndWhenInUseUsageDescription` set.
`ITSAppUsesNonExemptEncryption: false`.

**Plugins:** expo-secure-store, expo-apple-authentication,
@react-native-google-signin (iOS URL scheme set), expo-location (background +
foreground service enabled), expo-notifications (bundles
`assets/sounds/new_order.wav`), expo-splash-screen, expo-build-properties.

**Push channels** (`src/services/notifications.ts`): jobs go to channel
`jobs-v2` with sound `new_order.wav` at MAX importance; chat goes to channel
`messages` at HIGH with the default sound. Android caches a channel's sound at
creation — **changing the job sound requires a new channel id**, which is why
it is already on `-v2`.

`google-services.json` is **committed on purpose** and explicitly un-ignored in
`.gitignore`, because EAS Build applies gitignore patterns even to tracked
files and the build fails without it. Do not "tidy" that away.

## 4. How the app is wired

`App.tsx` is the single source of truth. It:

- owns auth and routing, and derives `online` from `me.presence` — the server
  is authoritative, the app never implicitly changes status;
- polls `getMe` + `getMyDay` every **8 seconds**;
- keeps a **persistent foreground location watch** at the App level (not in a
  screen) so the driver's position survives screen changes, sending a throttled
  ping roughly every 10s;
- hands over to `JobScreen` when a stop is dispatched and keeps it up until
  delivered or skipped, then auto-advances to the next stop by sequence. Once
  PICKED_UP the card is locked (`canMinimize=false`, toggle disabled).

`HomeScreen` is presentational. Chat polls at 3s; the job deadline pill ticks
every 30s.

**Token handling is the subtle part.** Access tokens live 15 minutes; refresh
tokens are **single-use** (the server revokes the old one on rotation). The app
runs in *two* JS contexts — the foreground UI and the headless background
location task. A module flag `canRefresh` is set true **only** by `useAuth` in
the foreground, so only the foreground rotates tokens; the background task
never refreshes, and on a 401 it nulls its in-memory token so the next ping
re-reads SecureStore for whatever the foreground refreshed. Concurrent 401s
share one `refreshInFlight` promise. If you touch auth, keep this invariant or
you get the old "401 after 15 minutes / went offline by itself" bug back.

Note `POST /v1/auth/refresh` returns the token pair **unwrapped**
(`{accessToken, refreshToken, expiresIn}`), unlike login.

## 5. Backend endpoints the app calls

All on `apps/api/src/modules/driver-app/driver-app.controller.ts`:

```
GET  /v1/driver/me
GET  /v1/driver/my-day
GET  /v1/driver/cash-up          ?from&to
POST /v1/driver/online | offline | ping | push-token
GET  /v1/driver/chat  |  GET /v1/driver/chat/unread  |  POST /v1/driver/chat
GET  /v1/driver/orders/:orderId/chat   POST /v1/driver/orders/:orderId/chat
POST /v1/driver/jobs/:orderId/:action   (accept|start|arrived|delivered|skip|cancel)
```

Customer chat deliberately uses `orders/` not `jobs/`, to dodge the
`jobs/:orderId/:action` catch-all. Driver actions also push status to HubRise
and stamp `outForDeliveryAt` / `deliveredAt` on the order, which is what drives
the customer's live tracking page.

**An order can finish without the driver**, and the app has to cope: the
operator completes it on the board, a marketplace webhook closes it, or the 5am
rollover sweeps it up overnight. The API now settles the `DriverAssignment`
whenever the order goes terminal (`DispatchSettlementService`), so `my-day` stops
returning it and the job card disappears on the next 8s poll — before this, last
night's stop was still on screen the next morning, locked if it had reached
PICKED_UP. `jobs/:orderId/:action` also refuses accept/start/arrived on a closed
order with a **400** (tapping one used to push the finished order back to
OUT_FOR_DELIVERY). delivered/skip/cancel still succeed so a stale card can always
be cleared. If you touch `JobScreen`'s action handling, show that 400's message
rather than a generic "Try again" — it tells the driver to refresh.

## 6. Landmines — read before changing anything

1. **`eas build` packages your LOCAL working directory, not the pushed
   branch.** This has already burned a full Apple review cycle: a build was cut
   from a stale worktree and Apple re-reviewed the *old* UI. Before every build,
   confirm the commit the Expo build page reports is the one you expect.
2. **A native change needs a `version` bump in app.json.** `runtimeVersion`
   policy is `appVersion`, so the version string is what pairs a JS bundle with
   a binary. Add/upgrade/remove a native dependency, or change anything under
   `plugins`/`infoPlist`/`permissions`, and you must bump `version` — otherwise
   an OTA built against the new native code can load on the old binary and
   crash on a missing native module. JS-only changes keep the same version;
   that is the whole point.
3. **iOS permission priming:** Apple rejected this app twice under 5.1.1(iv).
   iOS now shows **no** pre-permission message at all — straight to the system
   dialog, explanation carried by the purpose strings. Android keeps the
   declinable disclosure because Google Play requires it. `LocationDisclosure`
   is platform-split for exactly this reason. Any new pre-permission UI must
   follow the same rule.
4. **Never auto-online at launch.** Going online is always a driver tap;
   auto-resume once fired location dialogs uninvited on a fresh install.
5. Changing an Android notification sound needs a **new channel id**.
6. `apps/driver` is outside the pnpm workspace — `npm install` in that
   directory, and the API needs `pnpm --filter @orderhub/database build` and
   `@orderhub/shared build` before its own `tsc` resolves.
7. **The Google Maps keys come from the environment, and a build without them
   fails.** `app.config.js` throws on EAS Build when
   `GOOGLE_MAPS_API_KEY_ANDROID` / `GOOGLE_MAPS_API_KEY_IOS` are missing — a
   deliberate loud failure, because the alternative is shipping a driver a blank
   grey map on the job card. Locally it only warns (running `eas build`
   evaluates the config on your machine too, where the secrets aren't present),
   so **a local `expo run:` / `expo start` shows a blank map until you create
   `apps/driver/.env`**. Never put the server key (the one with Geocoding) in
   either variable: these ship inside the binary.

## 7. Things I would put on the agenda

These are my findings, not your bug list — decide what you care about.

- ~~No OTA updates.~~ **Done** — `expo-updates` + EAS channels, see §9.
- ~~Google Maps key hardcoded in app.json.~~ **Out of the repo** — both keys now
  come from the environment via `app.config.js`. Two operator actions are still
  outstanding and nobody but you can do them: create the two mobile-restricted
  keys and register them as EAS secrets (§10), and **rotate the old server key
  `AIzaSy…6OnY0`** — it shipped inside every APK and TestFlight build released
  so far, so it must be treated as public regardless of what this repo now says.
  It is also still in this repo's git history.
- **Essentially no test coverage.** One spec touches dispatch (`courier-pins`).
  `driver-earnings.service.ts` computes driver pay — start-up fee plus
  longest-prefix postcode matching — with pure, trivially testable helpers
  (`normalizePostcode`, `matchPostcodeFee`, `coercePostcodeFees`) and **no
  tests at all**. That is real money.
- **Polling, not sockets.** 8s for state, 3s for chat, ~10s pings. Fine, but
  it is why "it took a few seconds to show" reports happen, and it costs
  battery.
- `buildNumber`/`versionCode` in app.json are dead values given
  `appVersionSource: remote` — harmless, but misleading when you read the file.

## 8. Clean-start checklist for the next session

```bash
cd ~/orderhub-enterprise/.claude/worktrees/<new-worktree>
git fetch origin && git merge --ff-only origin/claude/xenodochial-brahmagupta-5521f8
cd apps/driver && npm install && npm run type-check    # must be clean before you start
cp .env.example .env    # then paste the two Maps keys, or the map renders blank
```

If the session also touches the API:

```bash
pnpm install
pnpm --filter @orderhub/database build
pnpm --filter @orderhub/shared build
cd apps/api && pnpm type-check && pnpm test -- --testPathPattern "driver|dispatch"
```

Deploy branch is `claude/xenodochial-brahmagupta-5521f8`.

## 9. Shipping a fix: OTA vs a native build

`expo-updates` is configured in app.json (`updates.url` →
`https://u.expo.dev/<projectId>`, `checkAutomatically: ON_LOAD`,
`fallbackToCacheTimeout: 0`) with `runtimeVersion` policy `appVersion`, and
each `eas.json` profile declares a channel of its own name.

**JS-only fix** (screens, logic, styles, anything under `src/` or `App.tsx`):

```bash
cd apps/driver && npx eas update --branch preview      # or: npm run ota:preview
# once it's good on a test device:
npx eas update --branch production                     # or: npm run ota:production
```

An update only reaches installs whose `runtimeVersion` matches, i.e. builds of
the same app.json `version`. **Anything native still needs `eas build`** — and a
`version` bump with it (landmine §6.2).

**The first build carrying expo-updates has to go out through the stores
before any of this works.** Everything already installed on a driver's phone is
1.0.2, which has no updates client and will never poll. So: cut and ship a
1.0.3 build, and from then on JS fixes are minutes, not a review cycle.

How it behaves on the phone (`src/services/updates.ts` + the two effects in
`App.tsx`):

- expo-updates checks at cold launch and never blocks the splash
  (`fallbackToCacheTimeout: 0`) — what it downloads runs at the *next* launch.
- Because a driver keeps the app open all shift, we also re-check on every
  foreground, throttled to one check per 5 minutes, and short-circuit once a
  bundle is staged (`checkForUpdateAsync` keeps saying "available" after a
  fetch, so without that it would re-download on every foreground).
- A staged bundle is applied by `Updates.reloadAsync()` **only when nothing is
  in flight** — no dispatched stop, no job/chat/orders screen open, no request
  running — after a 1.5s settle. From the home screen that reload is a blink:
  tokens are in SecureStore and presence is server-side, so the driver stays
  signed in and stays online. It deliberately never fires mid-delivery.
- Dev builds and Expo Go are no-ops (`__DEV__ || !Updates.isEnabled`), so you
  will not see any of this while developing.
- To verify an update actually landed on a device, `updateInfo()` in that
  service returns the channel, runtime version and update id.

## 10. Google Maps keys — the operator steps left

The keys are out of the repo, but the restricted keys themselves have to be
created in Google Cloud and registered with EAS. Until that is done an EAS
build **fails** with the message from `app.config.js`.

1. Google Cloud console → Credentials → create **two** API keys, each with
   *API restrictions* set to one API only:
   - Android key: Maps SDK for Android; *Application restriction* "Android
     apps" → package `com.orderhubsolutions.driver` + the release signing
     SHA-1. Get the SHA-1 from `cd apps/driver && eas credentials` → Android →
     production → Keystore.
   - iOS key: Maps SDK for iOS; *Application restriction* "iOS apps" → bundle
     ID `com.orderhubsolutions.driver`.
   Do **not** enable Geocoding/Places/Directions on either — those stay on the
   server key.
2. Register them with EAS (these are read at build time, not runtime):

```bash
cd apps/driver
eas secret:create --scope project --name GOOGLE_MAPS_API_KEY_ANDROID --value <android key>
eas secret:create --scope project --name GOOGLE_MAPS_API_KEY_IOS --value <ios key>
eas secret:list
```

3. For local `expo start` / `expo run:`, copy `.env.example` to
   `apps/driver/.env` and paste the same two keys. `.env` is gitignored.
4. **Rotate the old server key** `AIzaSy…6OnY0` in Google Cloud and update
   wherever the API/worker reads it. It shipped inside every build released so
   far and is in this repo's git history — removing it from app.json does not
   un-publish it.
5. First build after this: check the map renders on the job card. A blank grey
   map with the Google logo in the corner means the key is wrong or the
   restriction does not match the signing certificate.
