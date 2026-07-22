const { withAndroidManifest } = require("@expo/config-plugins");

/**
 * Config plugin for Order Hub Caller ID.
 *
 * Runtime permissions live in app.json. The NotificationListenerService that
 * powers VoIP-call capture is merged in from react-native-android-notification-
 * listener's own AndroidManifest via autolinking.
 *
 * That library declares android:allowBackup="false" on <application>, which
 * collides with the app's default of "true" and fails the manifest merger. We
 * resolve it explicitly with tools:replace so OUR value wins. This is also the
 * hook for any further native manifest tweaks found during on-device builds.
 */
module.exports = function withCallerId(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$ = manifest.$ || {};
    manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";

    const app = manifest.application && manifest.application[0];
    if (app) {
      app.$ = app.$ || {};
      app.$["android:allowBackup"] = "true";
      const existing = app.$["tools:replace"];
      app.$["tools:replace"] = existing
        ? Array.from(new Set(existing.split(",").concat("android:allowBackup"))).join(",")
        : "android:allowBackup";
    }
    return cfg;
  });
};
