// Dynamic Expo config.
//
// Everything static lives in app.json — read that first; Expo hands it to this
// file as `config`. This layer exists for ONE reason: the Google Maps keys are
// baked into the binary at build time and are extractable from any APK, so they
// must not be committed. They come from the environment instead:
//
//   GOOGLE_MAPS_API_KEY_ANDROID  — restricted to the Android app
//                                  (package com.orderhubsolutions.driver + the
//                                  release signing SHA-1) and to Maps SDK for
//                                  Android only.
//   GOOGLE_MAPS_API_KEY_IOS      — restricted to the iOS app
//                                  (bundle ID com.orderhubsolutions.driver) and
//                                  to Maps SDK for iOS only.
//
// On EAS they are project secrets (`eas secret:list` to check); locally they
// live in apps/driver/.env, which is gitignored. Never put a key with
// Geocoding/Places/Directions enabled here — those belong to the server key,
// which stays on the server.
//
// A missing key means a blank grey map on the job card, so an EAS build fails
// loudly rather than shipping one. Locally it only warns: `eas build` evaluates
// this file on your machine too, where the secrets are not present.

const onEasBuild = process.env.EAS_BUILD === "true";

function mapsKey(name) {
  const value = process.env[name];
  if (value) return value;
  const message =
    `${name} is not set — the map on the job card would render blank. ` +
    `Set it as an EAS secret (eas secret:create --name ${name}) and in apps/driver/.env for local runs.`;
  if (onEasBuild) throw new Error(message);
  console.warn(`[app.config.js] ${message}`);
  return undefined;
}

module.exports = ({ config }) => {
  const androidKey = mapsKey("GOOGLE_MAPS_API_KEY_ANDROID");
  const iosKey = mapsKey("GOOGLE_MAPS_API_KEY_IOS");

  return {
    ...config,
    ios: {
      ...config.ios,
      ...(iosKey ? { config: { ...config.ios?.config, googleMapsApiKey: iosKey } } : {}),
    },
    android: {
      ...config.android,
      ...(androidKey
        ? { config: { ...config.android?.config, googleMaps: { apiKey: androidKey } } }
        : {}),
    },
  };
};
