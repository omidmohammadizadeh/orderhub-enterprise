/**
 * Which ordering channels exist, and where each one actually operates.
 *
 * This is the single source of truth behind the country filter on the Brands
 * page. Offering a UK brand a Careem connection isn't merely untidy — every
 * channel here needs credentials and a store id, so a channel that can't
 * exist in that country is an invitation to misconfigure. Keeping the
 * available set honest is the cheapest guard we have.
 *
 * Lives in @orderhub/shared because the API needs the same answer when it
 * validates a connection request, not just the dashboard that draws the grid.
 */

export type ChannelId =
  | "DIRECT_ONLINE"
  | "JUST_EAT"
  | "UBER_EATS"
  | "DELIVEROO"
  | "CAREEM"
  | "TALABAT"
  | "STUART"
  | "UBER_DIRECT"
  | "HUBRISE";

/**
 * "marketplace" — someone else's app sends us orders.
 * "direct"      — our own storefront; always available, everywhere.
 * "courier"     — delivery-only partners that carry OUR orders. They don't
 *                 send orders in, so the UI groups them separately.
 */
export type ChannelKind = "direct" | "marketplace" | "courier";

export interface ChannelDef {
  id: ChannelId;
  label: string;
  kind: ChannelKind;
  /** ISO-3166-1 alpha-2 codes. Empty array means "everywhere". */
  countries: string[];
  /**
   * Configured on the LOCATION rather than the brand. HubRise issues its
   * token against a HubRise location, so exposing it per brand created a
   * duplicate-setup foot-gun — it stays out of the brand grid.
   */
  locationLevel?: boolean;
}

export const CHANNELS: ChannelDef[] = [
  { id: "DIRECT_ONLINE", label: "Direct online ordering", kind: "direct", countries: [] },

  // ── Marketplaces ────────────────────────────────────────────────────────
  { id: "JUST_EAT", label: "Just Eat", kind: "marketplace", countries: ["GB", "IE"] },
  { id: "UBER_EATS", label: "Uber Eats", kind: "marketplace", countries: ["GB", "IE"] },
  // Deliveroo trades in the UK/IE and across part of the Gulf.
  {
    id: "DELIVEROO",
    label: "Deliveroo",
    kind: "marketplace",
    countries: ["GB", "IE", "AE", "KW", "QA"],
  },
  // Careem Food — the Gulf. Careem took over Uber's food business in the
  // region, which is why UBER_EATS is deliberately absent from AE.
  {
    id: "CAREEM",
    label: "Careem",
    kind: "marketplace",
    countries: ["AE", "SA", "JO"],
  },
  {
    id: "TALABAT",
    label: "talabat",
    kind: "marketplace",
    countries: ["AE", "KW", "SA", "BH", "OM", "QA"],
  },

  // ── Courier networks ────────────────────────────────────────────────────
  { id: "STUART", label: "Stuart", kind: "courier", countries: ["GB", "IE"] },
  { id: "UBER_DIRECT", label: "Uber Direct", kind: "courier", countries: ["GB", "IE"] },

  // ── Location-level ──────────────────────────────────────────────────────
  {
    id: "HUBRISE",
    label: "HubRise",
    kind: "marketplace",
    countries: [],
    locationLevel: true,
  },
];

/** Countries we can offer at least one brand-level channel in. */
export const CHANNEL_COUNTRIES: { code: string; name: string }[] = [
  { code: "GB", name: "United Kingdom" },
  { code: "IE", name: "Ireland" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "KW", name: "Kuwait" },
  { code: "QA", name: "Qatar" },
  { code: "BH", name: "Bahrain" },
  { code: "OM", name: "Oman" },
  { code: "JO", name: "Jordan" },
];

export function channelById(id: string): ChannelDef | undefined {
  return CHANNELS.find((c) => c.id === id);
}

/**
 * Brand-level channels available in a country, in display order.
 *
 * Excludes HubRise (location-level, see above). A channel with an empty
 * `countries` list is available everywhere — that's our own storefront, which
 * has no third party to be unavailable.
 */
export function channelsForCountry(country: string | null | undefined): ChannelDef[] {
  const code = String(country ?? "").trim().toUpperCase();
  return CHANNELS.filter(
    (c) =>
      !c.locationLevel &&
      (c.countries.length === 0 || (!!code && c.countries.includes(code))),
  );
}

/** True when `channel` can actually be connected in `country`. */
export function isChannelAvailableIn(
  channel: string,
  country: string | null | undefined,
): boolean {
  return channelsForCountry(country).some((c) => c.id === channel);
}

/**
 * Channels to SHOW for a brand: everything available in the selected country,
 * plus anything already connected that the country filter would otherwise hide.
 *
 * The filter is a page-level control, so an operator exploring UAE channels
 * would otherwise watch a live Uber Eats connection disappear from a UK
 * brand's grid. Nothing is written either way — the connection keeps taking
 * orders — but it becomes unmanageable and looks deleted. Making the filter
 * purely additive means it can offer more, never conceal something live.
 *
 * Location-level channels stay excluded even when connected (HubRise is
 * configured in Location settings; showing it here is the duplicate-setup
 * foot-gun the brand grid has always avoided).
 */
export function visibleChannelIds(
  country: string | null | undefined,
  connectedPlatforms: readonly string[],
): ChannelId[] {
  const base = channelsForCountry(country).map((c) => c.id);
  const seen = new Set<string>(base);
  const extra: ChannelId[] = [];
  for (const platform of connectedPlatforms) {
    if (seen.has(platform)) continue;
    const def = channelById(platform);
    if (!def || def.locationLevel) continue;
    seen.add(def.id);
    extra.push(def.id);
  }
  return [...base, ...extra];
}
