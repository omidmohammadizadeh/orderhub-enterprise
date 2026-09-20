# Order Hub Driver app — state of play

Written 2026-09-20. Everything below was read off the repo, not from memory.
Baseline verified: `npm install` + `npm run type-check` in `apps/driver` is
**clean, zero errors**.

---

## 1. Where it lives

`apps/driver` — a standalone Expo app, **excluded from the pnpm workspace**
(`pnpm-workspace.yaml` has `!apps/driver`), so it uses its own `npm` lockfile.
That is why you run `npm install`, not `pnpm install`, inside it.

2,648 lines across 17 source files, plus a 499-line `App.tsx`:

| File | Lines | What it does |
|---|---|---|
| `App.tsx` | 499 | **The orchestrator.** Owns auth, polls, online state, the location watch, routing |
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
| `src/services/apple.ts` / `google.ts` | 39 / 32 | Native sign-in |

Backend lives in `apps/api/src/modules/driver-app/` (controller, service,
`expo-push.service.ts`, and a `@Global` `expo-push.module.ts`). Driver earnings
and cash-up logic is in `apps/api/src/modules/dispatch/driver-earnings.service.ts`.

## 2. Build and release settings

| Setting | Value |
|---|---|
| Expo name / slug | Order Hub Driver / `orderhub-driver` |
| URL scheme | `orderhubdriver` |
| Version | **1.0.2** |
| Bundle ID (both platforms) | `com.orderhubsolutions.driver` |
| EAS project ID | `b0f31947-3c20-48ef-8537-6e6988a26d7c` |
| EAS owner | `maclondas` |
| Apple Team ID | `ANR7VRQRYT` |
| App Store Connect app ID | `6785099386` |
| `appVersionSource` | `remote` — EAS owns build numbers, so the `buildNumber: "1"` / `versionCode: 1` in app.json are ignored |
| Expo SDK | **54** (`expo ~54.0.36`), React Native 0.81.5, React 19.1.0 |
| Android target | compileSdk **36**, targetSdk **36**, minSdk 24 |
| API base | `https://orderhub-api-0re6.onrender.com/api` (app.json `extra.apiUrl`) |

Build profiles in `eas.json`: `development` (dev client), `preview` (internal
APK — this is the one to use for testing fixes), `production` (app-bundle +
autoIncrement, iOS image `latest`).

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

## 6. Landmines — read before changing anything

1. **`eas build` packages your LOCAL working directory, not the pushed
   branch.** This has already burned a full Apple review cycle: a build was cut
   from a stale worktree and Apple re-reviewed the *old* UI. Before every build,
   confirm the commit the Expo build page reports is the one you expect.
2. **No OTA updates are configured** — `expo-updates` is not installed and
   there is no `updates`/`runtimeVersion`/`channel` config anywhere. Every
   single JS fix therefore needs a full native rebuild and a store round-trip.
   See §7.
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

## 7. Things I would put on the agenda

These are my findings, not your bug list — decide what you care about.

- **No OTA updates.** For an app you have just told me has many bugs, this is
  the single biggest lever: each fix currently costs a native build and a
  review. Adding `expo-updates` with an EAS channel would let JS-only fixes
  ship in minutes. Worth doing *first*, before the bug-fixing run, so the fixes
  can actually reach drivers.
- **The Google Maps API key is hardcoded in `app.json`** (`AIzaSy…6OnY0`) for
  both iOS and Android. Per the project's own notes that is the **unrestricted
  server key** — the one with Geocoding, also used by the API and worker. It is
  extractable from any APK. It should be a separate, mobile-restricted key
  (Android: package + SHA-1; iOS: bundle ID), and the server key should be
  rotated once it is out of the binary.
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
```

If the session also touches the API:

```bash
pnpm install
pnpm --filter @orderhub/database build
pnpm --filter @orderhub/shared build
cd apps/api && pnpm type-check && pnpm test -- --testPathPattern "driver|dispatch"
```

Last commit touching the app: `966e2382` (2026-09-02, "Allow all permissions"
in the side panel). Deploy branch is `claude/xenodochial-brahmagupta-5521f8`.
