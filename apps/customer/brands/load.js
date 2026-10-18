// Reads and checks brands/<slug>.json. Shared by app.config.ts and
// scripts/brand.mjs so a bad file fails the same way in both, before EAS has
// spent a build on it.
//
// CommonJS on purpose: app.config.ts is transpiled by Expo's config loader and
// the script is plain Node, and require() is the one thing both can do.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_API = "https://orderhub-api-0re6.onrender.com/api";
// OrderHub's Google OAuth *web* client (project 331572609147), the API's
// GOOGLE_CLIENT_ID. The native SDK mints ID tokens for this audience on both
// platforms, which is what the API checks. Not a secret.
const DEFAULT_GOOGLE_WEB_CLIENT_ID = "331572609147-vjm10k3ro6o0a0ce0g49g955bmkt4u7r.apps.googleusercontent.com";
const GOOGLE_CLIENT_RE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

function listBrands() {
  return fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".json") && f !== "brand.schema.json")
    .map((f) => f.slice(0, -5));
}

function fail(msg) {
  throw new Error(`[brand] ${msg}`);
}

function loadBrand(slug) {
  if (!slug) {
    fail(`BRAND is not set. Run e.g. BRAND=${listBrands()[0] ?? "<slug>"} npx expo start. Brands: ${listBrands().join(", ")}`);
  }
  const file = path.join(__dirname, `${slug}.json`);
  if (!fs.existsSync(file)) fail(`no brands/${slug}.json. Brands: ${listBrands().join(", ")}`);
  const b = JSON.parse(fs.readFileSync(file, "utf8"));

  if (b.slug !== slug) fail(`brands/${slug}.json has slug "${b.slug}"`);
  if (!/^[a-z][a-z0-9]{1,30}$/.test(slug)) fail(`slug "${slug}" must be lowercase letters/digits (Android package names allow no hyphens)`);
  for (const key of ["name", "brandId", "storefrontUrl", "primaryColor"]) {
    if (!b[key]) fail(`${slug}: ${key} is required`);
  }
  if (!/^https:\/\//.test(b.storefrontUrl)) fail(`${slug}: storefrontUrl must be https`);
  const idRe = /^com\.orderhubsolutions\.[a-z][a-z0-9]+$/;
  if (!idRe.test(b.ios?.bundleId ?? "")) fail(`${slug}: ios.bundleId must look like com.orderhubsolutions.${slug}`);
  if (!idRe.test(b.android?.package ?? "")) fail(`${slug}: android.package must look like com.orderhubsolutions.${slug}`);

  // Sign in with Google is optional per brand: it needs an iOS OAuth client
  // made for this bundle id (the Android client is matched by package +
  // signing SHA-1, so the app carries no id for it). Without one the app
  // offers Apple (iOS) and the storefront's email sign-in only.
  const g = b.google || null;
  if (g) {
    for (const key of ["iosClientId", "webClientId"]) {
      if (g[key] && !GOOGLE_CLIENT_RE.test(g[key])) fail(`${slug}: google.${key} must look like 1234-abc.apps.googleusercontent.com`);
    }
  }
  const google = g && g.iosClientId
    ? {
        iosClientId: g.iosClientId,
        webClientId: g.webClientId || DEFAULT_GOOGLE_WEB_CLIENT_ID,
        // What the iOS SDK opens to return to the app: the client id reversed.
        iosUrlScheme: `com.googleusercontent.apps.${g.iosClientId.replace(/\.apps\.googleusercontent\.com$/, "")}`,
        android: g.android !== false,
      }
    : null;

  const asset = (key, fallback) => {
    const rel = b[key] || `brands/${slug}/${fallback}`;
    if (!fs.existsSync(path.join(ROOT, rel))) fail(`${slug}: ${key} file ${rel} is missing (scripts/brand-assets.py makes them)`);
    return `./${rel}`;
  };

  return {
    slug,
    name: b.name,
    brandId: b.brandId,
    locationId: b.locationId || null,
    storefrontUrl: b.storefrontUrl,
    apiUrl: (b.apiUrl || DEFAULT_API).replace(/\/+$/, ""),
    primaryColor: b.primaryColor,
    backgroundColor: b.backgroundColor || "#FFFFFF",
    icon: asset("icon", "icon.png"),
    adaptiveIcon: asset("adaptiveIcon", "adaptive-icon.png"),
    splash: asset("splash", "splash.png"),
    notificationIcon: asset("notificationIcon", "notification-icon.png"),
    version: b.version || "1.0.0",
    ios: { bundleId: b.ios.bundleId, appleTeamId: b.ios.appleTeamId || null, ascAppId: b.ios.ascAppId || null },
    android: { package: b.android.package },
    easProjectId: b.easProjectId || null,
    google,
    // Sign in with Apple needs the capability on the client's App ID; off
    // only for a brand whose team can't have it yet.
    appleSignIn: b.ios.appleSignIn !== false,
  };
}

module.exports = { loadBrand, listBrands, ROOT };
