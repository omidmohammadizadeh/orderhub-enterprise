import fs from "fs";
import path from "path";
import type { ExpoConfig } from "expo/config";

// One codebase, one store app per restaurant. BRAND picks brands/<slug>.json;
// everything that differs between two restaurants' apps lives in that file
// (and brands/<slug>/ for the artwork), so the dashboard can write a new
// brand without touching code.
//
// On EAS servers BRAND comes from the brand's own EAS project environment
// variables (`npm run brand -- init <slug>` sets it), because the build
// machine doesn't see the shell that started the build.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadBrand } = require("./brands/load.js");

const brand = loadBrand(process.env.BRAND);

const config: ExpoConfig = {
  name: brand.name,
  // One EAS project per brand: the slug must match that project's, and
  // keeping projects apart means an OTA update for one restaurant can never
  // land in another's app (the update carries its own copy of this config).
  slug: `orderhub-${brand.slug}`,
  scheme: `orderhub-${brand.slug}`,
  version: brand.version,
  runtimeVersion: { policy: "appVersion" },
  orientation: "portrait",
  icon: brand.icon,
  userInterfaceStyle: "light",
  newArchEnabled: true,
  ...(brand.easProjectId
    ? {
        updates: {
          url: `https://u.expo.dev/${brand.easProjectId}`,
          enabled: true,
          checkAutomatically: "ON_LOAD",
          fallbackToCacheTimeout: 0,
        },
      }
    : {}),
  ios: {
    bundleIdentifier: brand.ios.bundleId,
    supportsTablet: false,
    ...(brand.ios.appleTeamId ? { appleTeamId: brand.ios.appleTeamId } : {}),
    // Adds the Sign in with Apple entitlement; EAS turns the capability on
    // for the App ID (an existing profile must be regenerated — README).
    usesAppleSignIn: brand.appleSignIn,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: brand.android.package,
    // Firebase (FCM) config for Android push, one per brand, downloaded from
    // the "OrderHub Customer Apps" Firebase project (omid@orderhubpos.com).
    // Without it the app still runs, but Android never gets a push token.
    ...(fs.existsSync(path.join(__dirname, "brands", brand.slug, "google-services.json"))
      ? { googleServicesFile: `./brands/${brand.slug}/google-services.json` }
      : {}),
    adaptiveIcon: {
      foregroundImage: brand.adaptiveIcon,
      backgroundColor: brand.backgroundColor,
    },
    edgeToEdgeEnabled: true,
    // Live delivery map on Android (Google Maps SDK). The key is extractable
    // from any APK, so it never sits in git: an EAS environment variable,
    // restricted to these apps and to Maps SDK for Android. iOS uses Apple
    // Maps and needs no key. Without one the tracker shows its card view.
    ...(process.env.GOOGLE_MAPS_API_KEY_ANDROID
      ? { config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_API_KEY_ANDROID } } }
      : {}),
    // Expo's defaults add these; the app needs none of them, and Play flags
    // SYSTEM_ALERT_WINDOW and storage access as sensitive at review time.
    blockedPermissions: [
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      ...(brand.multiShop
        ? []
        : ["android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION"]),
    ],
  },
  plugins: [
    ...(brand.appleSignIn ? ["expo-apple-authentication"] : []),
    // Nearest-shop picker. Only a multi-shop app asks for location; the rest
    // block the permissions below so Play's Data safety form stays simple.
    ...(brand.multiShop
      ? [
          [
            "expo-location",
            {
              locationWhenInUsePermission: `${brand.name} uses your location to show the shop nearest to you.`,
            },
          ] as [string, object],
        ]
      : []),
    // Only with a client id: the iOS SDK throws (and the app dies) if asked to
    // sign in without its URL scheme registered.
    ...(brand.google
      ? [["@react-native-google-signin/google-signin", { iosUrlScheme: brand.google.iosUrlScheme }] as [string, object]]
      : []),
    [
      "expo-notifications",
      {
        icon: brand.notificationIcon,
        color: brand.primaryColor,
      },
    ],
    [
      "expo-splash-screen",
      {
        image: brand.splash,
        imageWidth: 220,
        resizeMode: "contain",
        backgroundColor: brand.backgroundColor,
      },
    ],
  ],
  extra: {
    brand: {
      slug: brand.slug,
      name: brand.name,
      brandId: brand.brandId,
      locationId: brand.locationId,
      storefrontUrl: brand.storefrontUrl,
      apiUrl: brand.apiUrl,
      primaryColor: brand.primaryColor,
      backgroundColor: brand.backgroundColor,
      multiShop: brand.multiShop,
      // Whether this Android build carries a Maps key (iOS always has a map).
      androidMap: !!process.env.GOOGLE_MAPS_API_KEY_ANDROID,
      signIn: {
        apple: brand.appleSignIn,
        google: brand.google
          ? { iosClientId: brand.google.iosClientId, webClientId: brand.google.webClientId, android: brand.google.android }
          : null,
      },
    },
    ...(brand.easProjectId ? { eas: { projectId: brand.easProjectId } } : {}),
  },
};

export default config;
