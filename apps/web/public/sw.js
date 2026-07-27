/* Order Hub service worker — offline app-shell for the POS.
 *
 * SAFETY-FIRST design: this is NOT a speed optimisation, it's an offline
 * fallback. Online behaviour is unchanged because every request goes to the
 * NETWORK FIRST — the cache is only ever served when a fetch actually fails
 * (i.e. the device is offline). The one exception is immutable hashed build
 * assets under /_next/static/, which are safe to serve cache-first.
 *
 * Bump VERSION to invalidate all caches on the next deploy.
 */
const VERSION = "oh-sw-v1";
const CACHE = `orderhub-${VERSION}`;

self.addEventListener("install", () => {
  // Take over as soon as installed so a fix ships immediately.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop any older Order Hub caches.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("orderhub-") && k !== CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Allow the page to force-activate a new SW (used by the register helper).
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never touch writes
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // same-origin only
  if (url.pathname.startsWith("/api/")) return; // API data → app handles offline (IndexedDB)

  // Immutable hashed build assets — safe to serve cache-first (fast + offline).
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Everything else (documents, RSC, fonts, images) → network-first.
  event.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.status === 200) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    // Cache clean, non-redirected 200s only — never cache a redirect to
    // /login (that would show login offline) or an error.
    if (res && res.status === 200 && !res.redirected && res.type === "basic") {
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Offline cold-launch: any un-cached navigation (e.g. the native app's
    // /auth/oauth/callback handoff URL, which carries a one-off query) falls
    // back to the last cached POS shell. The app then hydrates auth from
    // persisted localStorage and the menu from IndexedDB.
    if (req.mode === "navigate") {
      const shell =
        (await cache.match("/dashboard/pos")) ||
        (await cache.match("/dashboard"));
      if (shell) return shell;
    }
    throw err;
  }
}
