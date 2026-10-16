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
  },
  plugins: [
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
    },
    ...(brand.easProjectId ? { eas: { projectId: brand.easProjectId } } : {}),
  },
};

export default config;
