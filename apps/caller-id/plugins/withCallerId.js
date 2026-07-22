const { withAndroidManifest } = require("@expo/config-plugins");

/**
 * Config plugin for Order Hub Caller ID.
 *
 * The runtime permissions (READ_PHONE_STATE, READ_CALL_LOG, POST_NOTIFICATIONS,
 * FOREGROUND_SERVICE) are declared in app.json. The NotificationListenerService
 * that powers VoIP-call capture is merged in automatically from
 * react-native-android-notification-listener's own AndroidManifest via
 * autolinking, so we don't declare it here.
 *
 * This plugin is the place to add any native manifest tweaks we discover during
 * the first on-device build — e.g. a dedicated foreground service for
 * background-reliable SIM-call listening, or a manual <service> entry if the
 * library's auto-merge doesn't register the listener on a given RN version.
 */
module.exports = function withCallerId(config) {
  return withAndroidManifest(config, (cfg) => {
    // No-op for v1. Kept as the hook for post-build native adjustments.
    return cfg;
  });
};
