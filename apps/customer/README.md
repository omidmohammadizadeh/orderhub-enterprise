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
| **Settings** | Order-update permission state, an **Offers & news** toggle, **Sign in with Apple / Google**, sign out, **Delete account**, and links to the account and rewards |
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
* Firebase project: **orderhub-customer-apps** (owner omid@orderhubpos.com, org orderhubpos.com,
  Analytics off). Each brand is one Android app in it; its `google-services.json` lives at
  `brands/<slug>/google-services.json` and app.config.ts picks it up when present.
* FCM for Android push: upload the FCM V1 service account key to the brand's EAS project
  (`eas credentials -p android` → Push Notifications) and add `google-services.json` from a Firebase Android app
  with the brand's package name. **Not set up for the example brand yet.** Android tokens won't issue until it is.

## Sign-in setup (Google + Apple)

Google refuses its OAuth page inside a WebView (`disallowed_useragent`), so
the app signs in natively and hands the storefront the session
(`src/auth.ts`):

1. The native SDK returns an ID token → `POST /v1/customer-auth/native {provider, idToken, firstName?, lastName?, brandId}`.
   The API checks the token's audience and returns the same customer `accessToken` as email login. Apple sends the
   name only on the first sign-in; the API saves it then.
2. The app keeps the token in AsyncStorage and writes it into the WebView's `localStorage["orderhub.customerToken"]`
   (what the storefront's `useCustomerAuth` reads) from `injectedJavaScriptBeforeContentLoaded`, then reloads the page.
3. The bridge reports every change the storefront makes to that key, so an email sign-in or a sign-out on the
   storefront shows in Settings too. A native sign-out clears the key and the session cookie, then reloads once.
4. Inside the app the storefront's login modal swaps its web Google button for **Continue with Apple / Google**
   buttons that call back into the app (`window.OrderHubApp`, set by the same script).

Builds made before this change have no native modules; the code requires them lazily, so an OTA update hides the
buttons there instead of crashing. Bump `version` in the brand file so the next store build carries them.

### Switching it on: Admin Dashboard → Social login

Each app shows a button only when **both** are true: the build can offer it (client ids / Apple capability below),
and a platform admin switched it on for that brand in **Admin Dashboard → Social login** (iOS Apple, iOS Google,
Android Google; stored on `Brand.settings.socialLogin`). The app reads
`GET /v1/public/customer-app/<brandId>/social-login` at launch (cached for offline), so this decides per store
submission without a new build. Everything starts **off**. iOS Google needs iOS Apple on (guideline 4.8): the API
refuses it otherwise, and the app never shows Google alone on iOS.

### API environment (Render, orderhub-api)

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | Already set: OrderHub's **web** client. The apps pass it as `webClientId`, so tokens on both platforms are minted for it |
| `CUSTOMER_APP_GOOGLE_CLIENT_IDS` | Optional, comma-separated: extra audiences, for a brand whose `google.webClientId` isn't the default |
| `CUSTOMER_APP_APPLE_BUNDLE_IDS` | **Required for Apple**, comma-separated: every brand's bundle id, e.g. `com.orderhubsolutions.kingstonpizza,com.orderhubsolutions.pizzaunopelton,com.orderhubsolutions.bestkebabs` |

### Per brand: Google

All clients live in OrderHub's Google Cloud project **331572609147** (the one that owns the web client), so the
native SDK can mint tokens for the web client's audience. Google Cloud console → APIs & Services → Credentials →
Create credentials → OAuth client ID:

1. **iOS** client, bundle ID `com.orderhubsolutions.<slug>` (add the client's App Store ID and Team ID once known).
   Put its client ID in the brand file:
   ```json
   "google": { "iosClientId": "331572609147-xxxx.apps.googleusercontent.com" }
   ```
   `brands/load.js` derives the reversed URL scheme the config plugin registers. Without `google`, the brand offers
   Apple (iOS) and email only; the plugin is left out, because the iOS SDK crashes without its URL scheme.
2. **Android** client, package `com.orderhubsolutions.<slug>`, with the **SHA-1 of the Play app-signing key**
   (Play Console → the app → Test and release → App integrity → App signing). Add a second Android client with the
   upload key's SHA-1 (`eas credentials -p android`) for internal / preview builds, which EAS signs itself. The app
   carries no Android client ID: Google matches on package + SHA-1. Until both exist, Android sign-in fails with
   `DEVELOPER_ERROR`; `"google": { …, "android": false }` hides the button meanwhile.
3. OAuth consent screen: published (not *Testing*), or only listed test users can sign in.

**Done so far (19 Oct 2026, project order-hub-solutions):** iOS clients for kingstonpizza, pizzaunopelton and
bestkebabs (ids in their brand files). Android clients for kingstonpizza and pizzaunopelton with the EAS upload key
and both Play app-signing keys (the org Play account, developer 7811250872041921096, shows a current and a previous
signing key since the 17 Oct key upgrade), and for all three with the local `android/app/debug.keystore` SHA-1
(`5E:8F:16:06:…`) for emulator builds. pizzauno (OrderHub's own Apple team, 19 Oct): iOS client and an Android client with its EAS upload key (`65:D3:35:66:…`); add its Play app-signing key once it has a Play app. Still to add for bestkebabs: its EAS upload key and Play signing key once it
has an Android build and a Play app.

### Per brand: Apple

1. In the **client's** Apple developer account: Certificates, IDs & Profiles → Identifiers →
   `com.orderhubsolutions.<slug>` → tick **Sign in with Apple** (primary App ID). EAS normally does this itself on the
   next build (the config sets `usesAppleSignIn`), but if the brand already has a provisioning profile, **delete it**
   (`eas credentials -p ios` → Provisioning Profile → remove) so EAS makes one with the new entitlement; the old one
   is reused otherwise and the build fails signing.
2. Add the bundle ID to `CUSTOMER_APP_APPLE_BUNDLE_IDS` on the API.
3. `"ios": { …, "appleSignIn": false }` turns it off for a brand. Don't ship Google on iOS without it (guideline 4.8).

## Before the first store submission

These are not blockers for building, but App Review will raise them:

* **Account deletion (5.1.1(v))** is in Settings (signed in → *Delete account*, `DELETE /v1/customer-auth/me`) and on
  the storefront's account page.
* **Sign in with Apple (4.8)** shows wherever Google does, on iOS. Make sure the capability is on the client's App ID
  before the build (see *Sign-in setup*).
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
