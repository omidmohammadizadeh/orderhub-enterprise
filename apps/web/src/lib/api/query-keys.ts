// Central React Query key factory.
//
// Why this exists: the same endpoint was cached under several ad-hoc key
// shapes (`["locations"]`, `["locations","list"]`, `["locations","caller-id-rooms"]`
// all for GET /v1/locations) — so identical data was fetched and stored 2–3×,
// and invalidations missed siblings. One canonical key per resource fixes
// both. Only keys whose underlying fetch is IDENTICAL may share a shape here;
// location-scoped variants keep the scope in the key.
//
// Convention: every key is a `const` tuple, location/entity-scoped where the
// fetch is. `undefined` scope means "all locations" (admin view) and is kept
// IN the tuple so scoped and unscoped caches never collide.

export const queryKeys = {
  // GET /v1/locations (locationsClient.list — same fetch everywhere)
  locations: ["locations", "list"] as const,
  // GET /v1/locations/:id
  locationDetail: (locationId: string) =>
    ["locations", "detail", locationId] as const,

  // GET /v1/brands (brandsClient.list, unscoped)
  brands: ["brands"] as const,

  // GET /v1/orders/live?locationId= — THE shared live-orders cache. The orders
  // board, auto-accept and auto-print must all observe this one key so a
  // single fetch feeds every consumer.
  liveOrders: (locationId?: string) => ["orders", "live", locationId] as const,

  // GET /v1/alerts?locationId=
  alerts: (locationId?: string) =>
    ["alerts", "list", locationId ?? "all"] as const,

  // GET /v1/leads/unread-count
  leadsUnreadCount: ["leads", "unread-count"] as const,

  // GET /v1/printers?locationId=
  printers: (locationId?: string) =>
    ["printers", "list", locationId ?? "all"] as const,
} as const;
