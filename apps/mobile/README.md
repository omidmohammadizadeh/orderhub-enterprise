# @orderhub/mobile

Native iOS + Android shell for the OrderHub POS. Lean WebView around
the existing web dashboard with native auth (Google / Apple / email)
and a JWT bridge so operators don't see a browser anywhere.

## Stack

- **Expo SDK 51** (bare workflow via EAS Build)
- **React Native 0.74**
- **react-native-webview** for the dashboard shell
- **@react-native-google-signin/google-signin** for native Google
- **expo-apple-authentication** for native Apple
- **expo-secure-store** for JWT persistence (Keychain / Keystore)
- **expo-keep-awake** so till tablets don't sleep mid-shift

No FCM, no push, no native business-logic screens. Add those later if
needed — the WebView covers the entire feature set today.

## One-time setup

```bash
# From the repo root
pnpm install

# Install the Expo + EAS CLIs globally (or use npx if you prefer)
npm install -g expo-cli eas-cli

# Inside apps/mobile, log into your Expo account once
cd apps/mobile
eas login
eas init --id <existing-project-id-or-blank-to-create>
```

`eas init` writes the resulting `projectId` into `app.json → extra.eas.projectId` —
replace the placeholder there.

## Filling in the placeholders before the first build

`app.json` has three `REPLACE_*` strings:

| Placeholder | Where to get it |
|---|---|
| `googleWebClientId` | Google Cloud Console → Credentials → the **Web application** OAuth Client ID |
| `googleIosClientId` | Google Cloud Console → Credentials → the **iOS** OAuth Client ID |
| `REPLACE_WITH_REVERSED_CLIENT_ID` (in the google-signin plugin block) | The iOS Client ID, reversed — e.g. `com.googleusercontent.apps.217235196986-xxx` |
| `appleTeamId` (in `eas.json`) | Apple Developer → Membership → Team ID |

Also drop your real icon + splash artwork into `assets/` — see
`assets/README.md` for sizes.

## Daily development

```bash
# From apps/mobile
pnpm start
```

That opens the Expo dev server. Scan the QR code with the **Expo Go**
app on your phone (Android) — works for the basic WebView screen.

For the native Google / Apple sign-in to work you need a **dev client**
build (Expo Go can't load native modules it doesn't ship with):

```bash
eas build --platform ios --profile development
eas build --platform android --profile development
```

Install the resulting build on your device once, then `pnpm start` will
hot-reload into it for the rest of development.

## Production builds — no Mac required

EAS Build runs in the cloud, including iOS builds on Apple-licensed
macOS workers, so you can ship from a Linux or Windows laptop too.

### Android production build → upload to Play Store

```bash
pnpm build:android
# → produces .aab uploaded to your EAS project
# → download link printed at the end
# → upload the .aab to Play Console → Production track → Submit for review
```

Or do it in one shot:

```bash
pnpm build:android
pnpm submit:android   # uploads the latest build to Play Console
```

### iOS production build → upload to App Store

```bash
pnpm build:ios
# → first run prompts you to log in to Apple Developer once,
#   EAS auto-creates the App ID + provisioning profile + cert
# → outputs .ipa downloadable from the EAS dashboard

pnpm submit:ios       # uses Transporter under the hood
```

You'll need an **App Store Connect record** created first (App Store
Connect → My Apps → New App), using bundle ID `com.orderhubsolutions.pos`
and SKU `orderhub-pos`.

## Replacing the existing Base44 app on Google Play

Because we use a new package name (`com.orderhubsolutions.pos`) the new
build will appear as a **separate listing** on the Play Store, not as
an update to Base44's app. Workflow:

1. Build + submit this app to Play Console internal track.
2. Promote through closed testing → open testing → production.
3. Once approved and live, in Play Console find Base44's old listing
   → App content → Unpublish.
4. Send your existing operators the new install link.

Same approach for iOS if Base44 had an App Store listing.

## Why WebView and not native React Native screens

The web dashboard already renders the orders board, POS cart, menu
manager, locations, brands, marketing, analytics, etc. Rewriting all
of that in native React Native is months of work for zero customer
benefit on a counter tablet that doesn't roam.

What we get from WebView:
- Every web feature works on day one — no per-screen porting.
- New channels (HubRise, Uber Eats, Deliveroo) light up automatically
  because they're server-side; the WebView just reflects what the
  dashboard already shows.
- One bug fix, one codebase.

What we'd lose:
- Background reliability — if the operator backgrounds the app for a
  long time, the WebSocket dies and sound doesn't play. Not relevant
  for a till tablet that stays open + on. If we ever need true
  background reliability, add FCM in `src/services/push.ts` later.

Migrate screens to native React Native one at a time, only when the
business case is real (offline mode, faster cart rendering, etc).
