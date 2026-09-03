// ── Which sales channels exist in which country ─────────────────────────────
//
// Careem and talabat trade in the Gulf; Just Eat, Uber Eats and Deliveroo are
// the UK set. Offering all of them everywhere is not harmless clutter: every
// channel here needs credentials and a store id, so an unavailable one is an
// invitation to spend an afternoon configuring something that cannot work.
//
// Keyed off the LOCATION's country rather than a control in the header. A
// country switcher would be a second source of truth that can disagree with
// the location switcher, and every screen would then have to decide which one
// wins. A shop is in exactly one country; ask the shop.

export type ChannelId =
  | "DIRECT_ONLINE"
  | "JUST_EAT"
  | "UBER_EATS"
  | "DELIVEROO"
  | "STUART"
  | "UBER_DIRECT"
  | "CAREEM"
  | "TALABAT"
  | "HUBRISE";

export interface ChannelDef {
  id: ChannelId;
  /** Configured in Location settings, not on the brand grid. */
  locationLevel?: boolean;
}

const DIRECT: ChannelDef = { id: "DIRECT_ONLINE" };

/** Everywhere: a brand's own storefront is not a marketplace. */
const UNIVERSAL: ChannelDef[] = [DIRECT];

const UK: ChannelDef[] = [
  DIRECT,
  { id: "JUST_EAT" },
  { id: "UBER_EATS" },
  { id: "DELIVEROO" },
  { id: "STUART" },
  { id: "UBER_DIRECT" },
];

// Deliveroo trades across the UAE — Dubai, Abu Dhabi and Sharjah — so it
// belongs here alongside the local marketplaces. (An earlier version of this
// file claimed it had withdrawn in 2024. That was wrong, and it was wrong in
// the worst way: stated as fact in a comment and pinned by a test, which is
// how a mistake stops looking like one. If a market changes, change it here
// with a source, not from memory.)
//
// Uber Eats is NOT listed: it withdrew from the UAE and folded into Careem,
// which Uber owns. Confirm before adding it — see the note above.
const GULF: ChannelDef[] = [
  DIRECT,
  { id: "TALABAT" },
  { id: "CAREEM" },
  { id: "DELIVEROO" },
];

// NOTE: SUPPORTED_COUNTRIES (currency.ts) offers US as well, and it is
// deliberately absent here — nobody has confirmed which US marketplaces we
// integrate with, and the rule at the top of this file is that a market goes
// in with a source, not from memory. The consequence is real though: a shop
// set to US falls back to UNIVERSAL and sees only direct ordering, which the
// brand grid now says out loud instead of leaving the operator to wonder.
export const CHANNELS_BY_COUNTRY: Record<string, ChannelDef[]> = {
  GB: UK,
  IE: [DIRECT, { id: "JUST_EAT" }, { id: "UBER_EATS" }, { id: "DELIVEROO" }],
  AE: GULF,
  SA: GULF,
  KW: GULF,
  QA: GULF,
  BH: GULF,
  OM: GULF,
  JO: GULF,
  EG: GULF,
};

/** Channels a shop in this country can actually sell through. */
export function channelsForCountry(country: string | null | undefined): ChannelDef[] {
  const c = String(country ?? "").trim().toUpperCase();
  return CHANNELS_BY_COUNTRY[c] ?? UNIVERSAL;
}

export function channelById(id: string): ChannelDef | undefined {
  for (const list of Object.values(CHANNELS_BY_COUNTRY)) {
    const hit = list.find((c) => c.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Channels to SHOW for a brand: everything its country offers, plus anything
 * already connected that the country list would otherwise hide.
 *
 * A shop that somehow holds a live connection to a channel outside its country
 * must still be able to see and disconnect it. Hiding it would not stop the
 * orders — it would just remove the only way to turn them off.
 */
export function visibleChannelIds(
  country: string | null | undefined,
  connectedPlatforms: readonly string[] = [],
): ChannelId[] {
  const base = channelsForCountry(country).map((c) => c.id);
  const seen = new Set<string>(base);
  const extra: ChannelId[] = [];
  for (const platform of connectedPlatforms) {
    if (seen.has(platform)) continue;
    const def = channelById(platform);
    // HubRise is configured in Location settings — showing it on the brand
    // grid is the duplicate-setup foot-gun that grid has always avoided.
    if (!def || def.locationLevel) continue;
    seen.add(def.id);
    extra.push(def.id);
  }
  return [...base, ...extra];
}
