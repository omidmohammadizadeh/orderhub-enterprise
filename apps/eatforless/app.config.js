// Dynamic Expo config — app.json holds everything static; read that first.
//
// This layer only adds what must not be committed or does not exist yet:
//
//   GOOGLE_MAPS_API_KEY_ANDROID / _IOS  Maps SDK keys (the live-tracking map).
//                                       iOS falls back to Apple Maps without one;
//                                       Android shows a blank map without one.
//   EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID    The Google Sign-In iOS OAuth client for
//                                       com.eatforless.app. Its reversed id is
//                                       the URL scheme the Google plugin needs,
//                                       so the plugin is only added once the
//                                       client exists (Eat For Less Ltd's Google
//                                       Cloud project — not created yet).
//
// Locally these live in apps/eatforless/.env (gitignored); on EAS they will be
// project environment variables.

function reversedClientId(clientId) {
  return clientId ? clientId.split(".").reverse().join(".") : null;
}

module.exports = ({ config }) => {
  const androidMapsKey = process.env.GOOGLE_MAPS_API_KEY_ANDROID;
  const iosMapsKey = process.env.GOOGLE_MAPS_API_KEY_IOS;
  const googleScheme = reversedClientId(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID);

  return {
    ...config,
    plugins: [
      ...(config.plugins ?? []),
      ...(googleScheme
        ? [["@react-native-google-signin/google-signin", { iosUrlScheme: googleScheme }]]
        : []),
    ],
    ios: {
      ...config.ios,
      ...(iosMapsKey ? { config: { ...config.ios?.config, googleMapsApiKey: iosMapsKey } } : {}),
    },
    android: {
      ...config.android,
      ...(androidMapsKey
        ? { config: { ...config.android?.config, googleMaps: { apiKey: androidMapsKey } } }
        : {}),
    },
  };
};
