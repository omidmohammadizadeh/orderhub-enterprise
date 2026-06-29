// Shared "is the shop open at time T (in its timezone)" check.
// Mirrors OrderingService.isCurrentlyOpen so WhatsApp ordering enforces the
// exact same opening-hours rules as the online storefront. Supports both the
// legacy array shape and the Phase AN/AW map shape, including overnight slots.

export function isCurrentlyOpen(openingHours: any, timezone: string): boolean {
  if (!openingHours) return true; // No hours configured = always open

  const now = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
  const dayOfWeek = now.getDay(); // 0 = Sunday
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  // Phase AN / AW map shape: { monday: { enabled, slots:[{from,to}] } | [{from,to}], … }
  if (!Array.isArray(openingHours) && typeof openingHours === "object") {
    const keys = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ] as const;
    const slotsForKey = (key: string): Array<{ from?: string; to?: string }> => {
      const d = openingHours[key];
      if (!d) return [];
      if (Array.isArray(d)) return d;
      if (d.enabled === false) return [];
      return Array.isArray(d.slots) ? d.slots : [];
    };
    const toMins = (s: string) => {
      const [h = 0, m = 0] = s.split(":").map(Number);
      return h * 60 + m;
    };
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const yesterdayIdx = (dayOfWeek + 6) % 7;

    for (const s of slotsForKey(keys[dayOfWeek] as string)) {
      if (!s.from || !s.to) continue;
      const from = toMins(s.from);
      const to = toMins(s.to);
      if (from < to) {
        if (nowMins >= from && nowMins < to) return true;
      } else if (from > to) {
        // Overnight slot — open from `from` until midnight
        if (nowMins >= from) return true;
      }
    }
    // Yesterday's overnight slot spilling past midnight into today
    for (const s of slotsForKey(keys[yesterdayIdx] as string)) {
      if (!s.from || !s.to) continue;
      const from = toMins(s.from);
      const to = toMins(s.to);
      if (from > to && nowMins < to) return true;
    }
    return false;
  }

  // Legacy array shape: [{ day, open, close }]
  if (Array.isArray(openingHours)) {
    if (openingHours.length === 0) return true;
    const todayHours = openingHours.find((h: any) => h.day === dayOfWeek);
    if (!todayHours) return false;
    return currentTime >= todayHours.open && currentTime < todayHours.close;
  }

  return true;
}

/** True when an opening-hours value actually has any configuration. */
export function hoursConfigured(openingHours: any): boolean {
  if (!openingHours) return false;
  if (Array.isArray(openingHours)) return openingHours.length > 0;
  if (typeof openingHours === "object") return Object.keys(openingHours).length > 0;
  return false;
}
