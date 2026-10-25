// Eat For Less public site — where its pages live.
//
// The site is served from two places: eatforless.co.uk, where the middleware
// rewrites clean paths ("/near") into the /eatforless tree, and the OrderHub
// hosts (for testing), where the tree is reached by its real path
// ("/eatforless/near"). `base` is "" on the first and "/eatforless" on the
// second, so every link reads naturally on both. The middleware also leaves
// an already-prefixed path alone on the Eat For Less domain, so a link built
// with the prefix still works there.

export type EflBase = "" | "/eatforless";

export const EFL_PREFIX = "/eatforless";

/** The base for a request, from the `x-site-brand` header the middleware sets. */
export function eflBaseFor(siteBrand: string | null | undefined): EflBase {
  return siteBrand === "eatforless" ? "" : EFL_PREFIX;
}

/** "/near" → "/near" on eatforless.co.uk, "/eatforless/near" elsewhere. */
export function eflHref(base: EflBase, path: string): string {
  if (path === "/" || path === "") return base || "/";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The canonical public origin, for metadata. */
export const EFL_ORIGIN = "https://eatforless.co.uk";

export const EFL_CONTACT_EMAIL = "hello@eatforless.co.uk";

/** Tyne and Wear first. */
export const EFL_LAUNCH_TOWNS = [
  "Newcastle",
  "Gateshead",
  "Sunderland",
  "South Shields",
  "North Shields",
  "Jarrow",
] as const;
