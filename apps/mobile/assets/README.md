# Mobile assets

Replace the placeholders below with the real artwork before submitting to
the App Store or Google Play.

## Required files

- `icon.png` — 1024×1024, square, opaque background. Used by Expo to
  generate every iOS icon size and as the foreground for the Android
  adaptive icon.
- `adaptive-icon.png` — 1024×1024, transparent margins. Android draws
  this on top of `app.json → expo.android.adaptiveIcon.backgroundColor`
  (currently `#0F172A`). Keep the logo inside the inner 67% safe area.
- `splash.png` — 1242×2436 (or larger). Shown before the JS bundle
  loads. Expo resizes it; centred logo on the navy background is fine.

## Where to drop the Base44 assets

Base44's `assets/icon/logo.png` is a good starting point — copy it to
both `icon.png` and `adaptive-icon.png` here. The first build will use
it; you can iterate on a polished version later without re-submitting
to the stores (icon updates ship in the same OTA release).
