// Who is allowed to call this API from a browser.
//
// Three kinds of caller, and the middle one is the one that bit us:
//
//   1. No Origin at all — curl, the mobile app, server-to-server, and any
//      SAME-ORIGIN GET. Always allowed; CORS doesn't apply.
//   2. A same-origin POST/PUT/DELETE. Browsers send Origin on every non-GET
//      request, INCLUDING to the page's own host, and the web app proxies
//      /api/* through Next — so the API sees Origin: https://<the shop's own
//      domain> on a request that isn't cross-origin at all.
//   3. A genuinely cross-origin caller. Refused.
//
// (2) is why a refusal must never throw. It used to, which Nest turned into a
// 500 "Internal server error", so on a brand's custom domain the storefront
// loaded (GETs carry no Origin) and the first POST — start a group order,
// checkout, apply a promo — died. Refusing by simply not setting the CORS
// headers leaves same-origin requests working and still leaves a real
// cross-origin caller blocked, by the browser, which is CORS's actual job.
//
// Brand custom domains are storefronts we serve but can't list in an env var:
// operators connect them themselves. They come from the database, cached,
// because this runs on every request that carries an Origin.

export interface CorsOriginDeps {
  /** Origins from CORS_ALLOWED_ORIGINS / APP_URL. Exact-match, with scheme. */
  allowedOrigins: string[];
  /** Every brand custom domain, lowercased hostnames, no scheme. */
  loadCustomDomains: () => Promise<string[]>;
  /** How long a loaded set is trusted before a refresh is attempted. */
  ttlMs?: number;
  now?: () => number;
}

export type CorsOriginFn = (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
) => void;

export function createCorsOriginCheck(deps: CorsOriginDeps): {
  origin: CorsOriginFn;
  /** Prime the cache at boot so the first request doesn't pay for it. */
  warm: () => Promise<void>;
} {
  const ttlMs = deps.ttlMs ?? 5 * 60_000;
  const now = deps.now ?? (() => Date.now());
  let domains = new Set<string>();
  let loadedAt = 0;
  let inFlight: Promise<void> | null = null;

  // A shop stores its domain either way round and its customers arrive either
  // way round; www.theshop.co.uk and theshop.co.uk are the same shop, and the
  // stored value isn't normalised for it.
  const key = (d: string) =>
    (d ?? "").trim().toLowerCase().replace(/^www\./, "");

  const refresh = async () => {
    if (inFlight) return inFlight;
    inFlight = deps
      .loadCustomDomains()
      .then((list) => {
        domains = new Set(list.map(key).filter(Boolean));
        loadedAt = now();
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const hostOf = (origin: string): string => {
    try {
      return key(new URL(origin).hostname);
    } catch {
      return "";
    }
  };

  const origin: CorsOriginFn = (requestOrigin, callback) => {
    if (!requestOrigin) return callback(null, true);
    if (deps.allowedOrigins.includes(requestOrigin)) return callback(null, true);

    const host = hostOf(requestOrigin);
    if (!host) return callback(null, false);
    if (domains.has(host)) return callback(null, true);

    // Not in the set — but a domain connected minutes ago wouldn't be. Reload
    // once the cache is stale, then answer. A failed reload refuses rather
    // than opening up.
    if (now() - loadedAt > ttlMs) {
      void refresh()
        .then(() => callback(null, domains.has(host)))
        .catch(() => callback(null, false));
      return;
    }
    callback(null, false);
  };

  return { origin, warm: refresh };
}
