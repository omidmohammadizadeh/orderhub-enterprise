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
const VERSION = "oh-sw-v2";
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

/* ── Web Push (Phase AX) ───────────────────────────────────────────────────
 *
 * Customer order updates: "your food is being made", "on its way". This is
 * what makes the storefront PWA worth installing, and it's the reason a
 * restaurant can have push without an App Store listing.
 *
 * These listeners are additive — the POS offline caching above is untouched.
 * One service worker serves both because both are the same Next app on the
 * same origin; a customer's browser simply never receives a POS push.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A push with a non-JSON body is not ours. Showing a generic notification
    // is still better than silently dropping it: Chrome and Firefox both
    // punish a push that resolves without showing anything, and can revoke
    // the subscription for it.
    payload = {};
  }

  const title = payload.title || "Order update";
  const options = {
    body: payload.body || "",
    // The restaurant's own logo where we have one — the whole point of the
    // white-label story is that the customer sees their takeaway, not us.
    icon: payload.icon || "/orderhub-logo.png",
    badge: "/orderhub-logo.png",
    // Same tag per order, so three quick transitions replace one another
    // instead of stacking three stale notifications in the shade.
    tag: payload.tag || "order-update",
    renotify: true,
    data: payload.data || {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      const target = new URL(url, self.location.origin);
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Prefer focusing a tab the customer already has open on this order —
      // opening a second copy of the tracking page is disorienting when the
      // first one is sitting right there.
      for (const client of all) {
        try {
          if (new URL(client.url).pathname === target.pathname) {
            await client.focus();
            return;
          }
        } catch {
          // A client with an unparseable URL isn't the one we want.
        }
      }

      // Otherwise reuse any open tab of ours rather than spawning a new one.
      for (const client of all) {
        if ("navigate" in client) {
          await client.focus();
          await client.navigate(target.href);
          return;
        }
      }

      await self.clients.openWindow(target.href);
    })(),
  );
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
