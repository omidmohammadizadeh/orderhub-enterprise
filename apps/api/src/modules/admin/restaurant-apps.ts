// A restaurant's own app in the stores, and whether to send customers to it.
//
// Stored on Brand.settings.customerApp by Admin Dashboard → Restaurant apps.
// Promotion (the storefront banner, Apple's Smart App Banner, the confirmation
// email badges) is off until switched on: an app that is still in internal
// testing has a Play link that 404s for the public.

export type CustomerAppConfig = {
  promote: boolean;
  androidPackage: string | null;
  iosAppStoreId: string | null;
};

/** What customer-facing surfaces get: real store links, or nothing. */
export type CustomerAppLinks = {
  android: string | null;
  ios: string | null;
  /** Numeric App Store id, for Apple's Smart App Banner meta tag. */
  iosAppStoreId: string | null;
};

const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const APP_STORE_ID_RE = /^\d{6,12}$/;

export function readCustomerApp(settings: unknown): CustomerAppConfig {
  const raw = (settings as { customerApp?: any } | null)?.customerApp;
  const pkg = typeof raw?.androidPackage === "string" && PACKAGE_RE.test(raw.androidPackage) ? raw.androidPackage : null;
  const ios = typeof raw?.iosAppStoreId === "string" && APP_STORE_ID_RE.test(raw.iosAppStoreId) ? raw.iosAppStoreId : null;
  return { promote: raw?.promote === true, androidPackage: pkg, iosAppStoreId: ios };
}

/** Links to promote, or null when promotion is off or there's no store link. */
export function customerAppLinks(settings: unknown): CustomerAppLinks | null {
  const c = readCustomerApp(settings);
  if (!c.promote || (!c.androidPackage && !c.iosAppStoreId)) return null;
  return {
    android: c.androidPackage ? `https://play.google.com/store/apps/details?id=${c.androidPackage}` : null,
    ios: c.iosAppStoreId ? `https://apps.apple.com/app/id${c.iosAppStoreId}` : null,
    iosAppStoreId: c.iosAppStoreId,
  };
}

/** Validates admin input; throws a readable message on a bad value. */
export function cleanCustomerApp(input: {
  promote?: unknown;
  androidPackage?: unknown;
  iosAppStoreId?: unknown;
}): CustomerAppConfig {
  const pkg = typeof input.androidPackage === "string" ? input.androidPackage.trim() : "";
  const ios = typeof input.iosAppStoreId === "string" ? input.iosAppStoreId.trim().replace(/^id/i, "") : "";
  if (pkg && !PACKAGE_RE.test(pkg)) throw new Error("Android package should look like com.orderhubsolutions.pizzauno");
  if (ios && !APP_STORE_ID_RE.test(ios)) throw new Error("App Store ID is the number in the app's App Store link, e.g. 6824555180");
  const promote = input.promote === true;
  if (promote && !pkg && !ios) throw new Error("Add at least one store link before promoting the app");
  return { promote, androidPackage: pkg || null, iosAppStoreId: ios || null };
}

/** Where a restaurant is in getting its own iPhone app live, on its own Apple
 *  developer account (guideline 4.2.6). Ids only: the App Store Connect key
 *  file itself never goes in the database (it lives with the build machine,
 *  apps/customer secrets/asc/<slug>/). */
export type IosOnboarding = {
  contactEmail: string | null;
  teamId: string | null;
  keyId: string | null;
  issuerId: string | null;
  steps: {
    enrolled: boolean;
    keyReceived: boolean;
    appRecordCreated: boolean;
    built: boolean;
    submitted: boolean;
    live: boolean;
  };
  notes: string | null;
};

const STEP_KEYS = ["enrolled", "keyReceived", "appRecordCreated", "built", "submitted", "live"] as const;
const TEAM_RE = /^[A-Z0-9]{10}$/;
const KEY_RE = /^[A-Z0-9]{10}$/;
const ISSUER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function readIosOnboarding(settings: unknown): IosOnboarding {
  const raw = (settings as { iosOnboarding?: any } | null)?.iosOnboarding ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const steps = Object.fromEntries(STEP_KEYS.map((k) => [k, raw?.steps?.[k] === true])) as IosOnboarding["steps"];
  return {
    contactEmail: str(raw.contactEmail),
    teamId: str(raw.teamId),
    keyId: str(raw.keyId),
    issuerId: str(raw.issuerId),
    steps,
    notes: str(raw.notes),
  };
}

export function cleanIosOnboarding(input: Record<string, unknown>): IosOnboarding {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const teamId = str(input.teamId)?.toUpperCase() ?? null;
  const keyId = str(input.keyId)?.toUpperCase() ?? null;
  const issuerId = str(input.issuerId)?.toLowerCase() ?? null;
  const contactEmail = str(input.contactEmail);
  if (teamId && !TEAM_RE.test(teamId)) throw new Error("Team ID is 10 letters/digits, e.g. ANR7VRQRYT (developer.apple.com → Membership)");
  if (keyId && !KEY_RE.test(keyId)) throw new Error("Key ID is 10 letters/digits, shown next to the key in App Store Connect");
  if (issuerId && !ISSUER_RE.test(issuerId)) throw new Error("Issuer ID looks like 57246542-96fe-1a63-e053-0824d011072a");
  if (contactEmail && !EMAIL_RE.test(contactEmail)) throw new Error("Contact email doesn't look right");
  const rawSteps = (input.steps ?? {}) as Record<string, unknown>;
  const steps = Object.fromEntries(STEP_KEYS.map((k) => [k, rawSteps[k] === true])) as IosOnboarding["steps"];
  const notes = str(input.notes);
  if (notes && notes.length > 2000) throw new Error("Notes are limited to 2000 characters");
  return { contactEmail, teamId, keyId, issuerId, steps, notes };
}
