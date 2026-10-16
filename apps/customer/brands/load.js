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
  };
}

module.exports = { loadBrand, listBrands, ROOT };
