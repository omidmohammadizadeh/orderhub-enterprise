// Which town is this postcode in?
//
// One question, one authoritative answer. A UK postcode belongs to exactly one
// town, and that fact is the only thing that should ever decide what town gets
// read back to a caller.
//
// Everything else that was being used for it is a guess wearing a disguise:
// the shop's own city is right until somebody delivers outside it, and our own
// order history is right until one order was typed wrong — which is how a
// caller in Washington was told they were in Salford, by a lookup that took
// 52ms because it never left the building.

const TOWN_CACHE = new Map<string, string | null>();

function key(postcode: string): string {
  return String(postcode ?? "").toUpperCase().replace(/\s+/g, "");
}

const TIMEOUT_MS = Number(process.env.ADDRESS_TOWN_TIMEOUT_MS) || 1500;

/**
 * The post town for a postcode, or null if we genuinely cannot say.
 *
 * Null is a real answer and callers must honour it: reading back a street and
 * a postcode with no town is correct, and borrowing a town from somewhere else
 * to fill the gap is exactly the bug this exists to end.
 */
export async function townForPostcode(postcode: string): Promise<string | null> {
  const k = key(postcode);
  if (!k) return null;
  if (TOWN_CACHE.has(k)) return TOWN_CACHE.get(k)!;

  try {
    const pretty = `${k.slice(0, -3)} ${k.slice(-3)}`;
    const res = await fetch(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(pretty)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      result?: { admin_district?: string; admin_ward?: string; parish?: string };
    };
    const r = data.result;
    if (!r) {
      TOWN_CACHE.set(k, null);
      return null;
    }
    // postcodes.io knows the local AUTHORITY, not the post town: NE37 comes
    // back "Sunderland" and everyone who lives there says Washington. A ward
    // named "<Town> North/South/East/West/Central" is naming its town.
    const ward = r.admin_ward ?? "";
    const m = ward.match(/^(.+?)\s+(north|south|east|west|central)(?:\s+\w+)?$/i);
    const town = m?.[1]?.trim() || r.admin_district || r.parish || null;
    TOWN_CACHE.set(k, town);
    return town;
  } catch {
    // Not cached: a network blip must not pin "no town" for the rest of the
    // process's life.
    return null;
  }
}

/** Test seam. */
export function clearTownCache(): void {
  TOWN_CACHE.clear();
}
