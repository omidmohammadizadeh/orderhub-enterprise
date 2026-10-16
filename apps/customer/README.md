# @orderhub/customer — white-label ordering apps

One Expo / React Native codebase that builds a **separate store app per
restaurant brand** (the Foodhub model). Each brand gets its own name, icon,
splash, colour, bundle id and EAS project. Everything that differs between
two restaurants' apps lives in `brands/<slug>.json` plus `brands/<slug>/` for
the artwork. The future dashboard "Mobile app" onboarding page can write
those files and run the same `npm run brand` commands a person does.

Like `apps/mobile`, this app is **outside the pnpm workspace** and uses
**npm** (`!apps/customer` in `pnpm-workspace.yaml`). It has its own
`node_modules`, and its Metro config never looks above this folder.

## What's in the app

Apple rejects a bare website in a wrapper (guideline 4.2), so the shell is
native, and the storefront is embedded only for menu and checkout (phase 1):

| Tab | What it is |
|---|---|
| **Home** | Native. Banner, logo, open/closed + today's hours, the running offer, Collection/Delivery times, a live card for the order in progress, "Popular right now", call/directions, and the offers opt-in |
| **Order** | The brand's storefront in a WebView (menu, basket, checkout, Stripe). It has a native top bar, back/reload, Android back handling and an offline screen |
| **My orders** | Native list of orders placed or opened on this phone, each with live status. Links to the account's full history |
| **Settings** | Order-update permission state, an **Offers & news** toggle, and links to the account and rewards |
| *Order status* | Native tracker. It polls `GET /v1/ordering/orders/:id/status` every 10 s while it is open and the order is still moving: steps, ETA, driver + call button, items, total |

### Push (expo-notifications)

* **Every launch:** ask permission → Expo push token →
  `POST /v1/customer-push/register-device {expoToken, brandId, locationId?, platform, appId, marketingOptIn}`.
  The app is the source of truth for `marketingOptIn`, so it sends its current choice every time.
* **Offers are off until the customer says yes.** Home asks once ("Get our offers first?") and Settings has the toggle,
  which calls `POST /v1/customer-push/preferences {endpoint: token, marketingOptIn}`.
  Apple 4.5.4 wants explicit opt-in for marketing pushes. Order updates don't need it.
* **Following an order:** `POST /v1/customer-push/subscribe {orderId, expoToken, platform, appId, trackPath}`
  is sent when the storefront places an order or an order page is opened.
* **Tapping a notification** opens `data.url`, a relative storefront path. An order page opens the native tracker;
  anything else opens in the Order tab. This works from a cold start too.

### How the app notices an order (`src/storefront-bridge.ts`)

The storefront doesn't know it is inside an app. A script injected before
the page loads reports two things:

1. **URL changes**, including client-side `pushState`. Orders are recognised on all three storefront shapes:
   `/order/<slug>/status/<id>`, `/order/<slug>/confirmation?orderId=<id>` (back from Stripe) and
   `/order/<slug>?confirmedOrderId=<id>`.
2. **The storefront's own `POST …/checkout` response.** A cash order confirms *in place* without the URL changing,
   so the URL alone would miss it. On a card order the app follows the order straight away but only opens the
   tracker once payment comes back.

The WebView user agent ends in `OrderHubApp/<slug>`, so the storefront can
tell it is inside the app if it ever needs to.

## Adding a brand

1. **Artwork** from one square logo (Pillow: `pip install pillow`):
   ```bash
   python3 scripts/brand-assets.py pizzauno ~/Downloads/pizza-uno-logo.png --bg "#FFFFFF" --initial P
   ```
   This writes `brands/pizzauno/{icon,adaptive-icon,splash,notification-icon}.png`. The icon is flattened (the App
   Store rejects alpha). The Android notification icon is the brand initial in white, because Android draws it as a
   silhouette.
2. **Config.** Copy `brands/bestkebabs.json` to `brands/pizzauno.json` and edit it. `brands/brand.schema.json`
   documents every field, and `brands/load.js` enforces the rules at build time. The essentials:
   * `slug`: lowercase letters/digits only (Android package names can't contain hyphens).
   * `brandId`: the OrderHub `Brand.id`. Push installs and offers are filed under it. `locationId` is optional, for a
     single-shop brand.
   * `storefrontUrl`: the full storefront URL, **including `?brand=`** when the shop trades several brands. Without it
     the storefront shows the shop's default brand.
   * `ios.bundleId` / `android.package`: `com.orderhubsolutions.<slug>`.
3. **EAS project.** Each brand has its own, so an OTA update or a credential can never cross brands:
   ```bash
   npm run brand -- init pizzauno
   ```
   This creates `@<expo-account>/orderhub-pizzauno`, writes `easProjectId` into the brand file, and sets the
   project's `BRAND` environment variable. The build server reads it, because it never sees your shell. Commit the
   brand file afterwards.
4. **Try it locally:**
   ```bash
   BRAND=pizzauno npx expo run:ios      # or run:android
   ```
   Run `npm run brand -- list` to see every brand. If `pod install` fails with
   `Unicode Normalization not appropriate for ASCII-8BIT`, prefix the command with
   `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`. The iOS Simulator on this Mac does get a real Expo push token. Metro prints
   `[push] registered ExponentPushToken[…]` once `register-device` succeeds.

## Building and submitting

All builds go through `scripts/brand.mjs`, which loads the brand's env and
credentials and then calls EAS:

```bash
npm run brand -- build  pizzauno ios            # production profile
npm run brand -- build  pizzauno android
npm run brand -- build  pizzauno ios development  # simulator dev client
npm run brand -- submit pizzauno ios
npm run brand -- submit pizzauno android
npm run brand -- update pizzauno production "Fix basket button"   # OTA
```

`eas.json` has one set of profiles for every brand. Each profile has an
**EAS Update channel from day one** (`development` / `preview` /
`production`), because a build with no channel can never receive an OTA.
`runtimeVersion` follows the app `version`, so bump `version` in the brand
file whenever native code or dependencies change.

### iOS: the client's own Apple developer account (guideline 4.2.6)

Apple wants each restaurant's app published under the restaurant's own
account. We build and upload with an App Store Connect API key that the
client creates for us:

1. The client enrols in the Apple Developer Program as an organisation (D-U-N-S needed), then creates an API key in
   App Store Connect → Users and Access → Integrations with the **App Manager** role. They send us the `.p8`, the
   Key ID and the Issuer ID.
2. Save them **outside git** (`secrets/` is ignored):
   ```
   secrets/asc/pizzauno/AuthKey.p8
   secrets/asc/pizzauno/key.json      {"keyId": "ABC123DEFG", "issuerId": "00000000-0000-0000-0000-000000000000"}
   ```
   Put their Team ID in `ios.appleTeamId`.
3. Create the app record in their App Store Connect (bundle id `com.orderhubsolutions.pizzauno`). Apple's API can't
   create apps, so this is a one-off step for them or us in the web UI. Put its numeric id in `ios.ascAppId`.
4. `npm run brand -- build pizzauno ios`, then `npm run brand -- submit pizzauno ios`. The script exports
   `EXPO_ASC_API_KEY_PATH` / `EXPO_ASC_KEY_ID` / `EXPO_ASC_ISSUER_ID` / `EXPO_APPLE_TEAM_ID`, which EAS uses both to
   generate the distribution certificate + provisioning profile on the client's team and to upload. **Not yet
   exercised on a real client account:** confirm it on the first one, including that submit finds the app by bundle
   id without an `ascAppId` in `eas.json`.

Push on iOS needs an APNs key on the same team. EAS creates and stores one
during the first interactive `eas credentials` / build. Check that **Push
Notifications** shows a key under `eas credentials -p ios` for the brand.

### Android: OrderHub's Organisation Google Play account

* Put the Play Console service account JSON at `secrets/google-play-service-account.json` (shared by every brand).
  Submissions go to the **internal** track as a **draft**.
* Google requires a new app's **first** AAB to be uploaded by hand in Play Console. Use `eas submit` from the second
  release onwards.
* FCM for Android push: upload the FCM V1 service account key to the brand's EAS project
  (`eas credentials -p android` → Push Notifications) and add `google-services.json` from a Firebase Android app
  with the brand's package name. **Not set up for the example brand yet.** Android tokens won't issue until it is.

## Before the first store submission

These are not blockers for building, but App Review will raise them:

* **Account deletion (5.1.1(v)).** The storefront lets customers create an account inside the app, so Apple requires
  a way to delete it in-app. The storefront has no "Delete my account" yet. Add it to `/order/<slug>/account`.
* **Google sign-in in a WebView.** Google blocks OAuth inside embedded WebViews (`disallowed_useragent`), and
  guideline 4.8 then requires Sign in with Apple next to it. Email sign-in works. Either hide the Google button when
  the user agent contains `OrderHubApp/`, or move sign-in native in phase 2.
* Privacy "nutrition label" + privacy policy URL in App Store Connect. The app itself collects the push token, plus
  whatever the storefront collects at checkout.

## Layout

```
app.config.ts            reads BRAND → brands/<slug>.json (via brands/load.js)
brands/                  one JSON per brand + brands/<slug>/ artwork + brand.schema.json
scripts/brand.mjs        init / build / submit / update / list for one brand
scripts/brand-assets.py  icon, adaptive icon, splash, notification icon from one logo
src/brand.ts             the baked-in brand config + storefront URL helpers
src/push.ts              permission, token, register-device / preferences / subscribe
src/storefront-bridge.ts injected script + order URL parsing
src/screens/             Home, Order (WebView), MyOrders, Settings, OrderStatus
```

## Example brand

`brands/bestkebabs.json` is **Best Kebabs, West Cornforth** (brand
`cmt2ub5oa0007aqum9gjl0b94`, location `cmt2uabsm0005aqumbfcan248`, EAS
project `@maclondas/orderhub-bestkebabs`). Nothing for it has been
published to either store.
