# Order Hub Caller ID (Android)

A small Android app that catches **incoming calls on the phone it's installed on**
and pops the caller on the shop's POS tablets — no Twilio, no per-call cost.

It covers the two paths we agreed on:

1. **Divert-to-SIM** — the shop diverts its number (or just uses this phone as its
   line). The phone rings natively → we read the caller number (`react-native-call-detection`).
2. **VoIP app** — the owner is logged into a VoIP dialer app on this phone. We read
   that app's *incoming-call notification* and pull the number out
   (`react-native-android-notification-listener` + Notification Access).

Both paths POST the number to the **existing** public endpoint
`POST /api/v1/customers/caller-id/voip/:locationId?key=…` (body `{ phone }`),
which broadcasts the popup to that location's POS tablets. **No backend change.**

> ⚠️ Native telephony app — **Android only** (iOS blocks reading calls). It has
> **not** been run on a device yet; treat this as v1 to validate on real hardware.

## Prerequisites
- `VOIP_WEBHOOK_KEY` set in Render (same key the app is configured with).
- An Android phone (the one that will receive the calls).
- EAS CLI logged in (`npx eas login`), same Expo account as `apps/mobile`.

## Build (APK)
```bash
pnpm install
cd apps/caller-id
npx eas build --platform android --profile preview   # produces an installable APK
```
Local alternative (needs Android SDK): `npx expo prebuild -p android --clean && npx expo run:android`.

## Set up on the phone
1. Install the APK, open the app.
2. Fill in **API base URL**, **Location ID** (the shop), and **Webhook key** (= `VOIP_WEBHOOK_KEY`). Save.
3. Tap **Send test popup to POS** — a tablet at that location should pop `+44 7700 900123`. This proves the config + endpoint before touching phone calls.
4. **SIM calls:** toggle **Listen for SIM calls** and approve the phone permission. Divert the shop number to this phone (or call this phone) → the caller pops.
5. **VoIP calls:** tap **Open Notification Access**, enable Order Hub Caller ID in the list, reopen the app. Optionally put the VoIP app's package id in "VoIP app package(s)" (leave blank to watch all apps while discovering it). Make a VoIP call → the caller pops.

## Known iteration points (expected on first build)
- **Native lib versions** (`react-native-call-detection`, `react-native-android-notification-listener`) may need pinning for Expo SDK 51 / RN 0.74 — send me the first EAS build log if it fails and I'll adjust `package.json`.
- **VoIP notification parsing** varies per app: some put the number in the title, some in the text, some show only a name. Use the on-screen Activity log to see what a given app sends, then we tune the parser in `src/detectors.ts`.
- **Background reliability for SIM calls:** the SIM listener runs while the app process is alive. For always-on background we'll add a foreground service (hook is in `plugins/withCallerId.js`). VoIP capture already runs in the background via the notification headless task.
- **Divert caller ID:** whether a diverted call shows the *original* caller (vs the shop's own number) is carrier-dependent — test with the shop's provider (BT/Virgin/XLN).
