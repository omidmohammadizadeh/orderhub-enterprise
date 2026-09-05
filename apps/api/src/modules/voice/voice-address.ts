// Turning "eleven Sunningdale Drive, Washington" into an address.
//
// The geocoder does the geography. What lives here is everything that decides
// whether its answer is good enough to read back to a caller — and that
// judgement cannot be delegated, because a search engine's job is to always
// return something and ours is to know when it hasn't understood.
//
// Three things it has to get right, all learned from real transcripts:
//
//   • "eleven" is a house number. The geocoder wants "11".
//   • Asked for "22 Fellside Road Gateshead", Nominatim's top hit was a
//     takeaway on Whitewell Road. Never trust position zero — check the road.
//   • Two Fellside Roads came back, NE16 6AB and NE16 5BQ. The shop's own
//     delivery zones are what settle which one the caller meant.

import { scoreItem, soundFold } from "./voice-menu-match";
import { addressLineFrom, normalisePostcode, streetOf } from "./voice-flow";

export interface AddressCandidate {
  line1?: string;
  city?: string;
  postcode?: string;
}

export interface ResolvedAddress {
  line1: string;
  city?: string;
  postcode: string;
}

/** Folded words of a street, for comparing a transcript against a gazetteer. */
function foldWords(text?: string | null): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(soundFold)
    .join(" ");
}

/** The bit of a postcode that says which district — "NE37 2LL" -> "NE37". */
export function outwardCode(postcode?: string | null): string {
  const p = String(postcode ?? "").toUpperCase().replace(/\s+/g, "");
  return p.length > 3 ? p.slice(0, p.length - 3) : p;
}

/**
 * What to actually send to the geocoder.
 *
 * Two jobs. Spoken numbers become digits, because "eleven Sunningdale Drive"
 * finds nothing and "11 Sunningdale Drive" finds the street. And when the
 * caller named no town — most people don't, they assume you know — the shop's
 * own town is added, because "Sunningdale Drive" on its own is a street in
 * several counties.
 */
export function addressQuery(
  said: string,
  ctx: { address?: { city?: string | null } },
): string {
  const line = addressLineFrom(said) ?? String(said ?? "").trim();
  const town = ctx.address?.city ?? "";
  if (!town) return line;
  if (foldWords(line).includes(foldWords(town))) return line;
  // Only when they plainly named no locality at all. "Fellside Road
  // Gateshead" is already located, and bolting our own town on the end sent
  // the geocoder looking for a Gateshead street in Washington — which it
  // correctly failed to find.
  const street = streetOf(line) ?? line;
  const words = street.split(/\s+/).filter(Boolean);
  return words.length <= 2 ? `${line}, ${town}` : line;
}

export interface RankedAddress {
  address: ResolvedAddress;
  score: number;
}

/**
 * Score what came back against what was said.
 *
 * The road has to match — that is the whole check, and without it a search for
 * a road returns a fast-food shop on a different one. Everything else nudges:
 * a postcode the shop delivers to is very likely the right one, and a town the
 * caller actually named is worth more than a town we assumed.
 */
export function rankAddresses(
  said: string,
  candidates: AddressCandidate[],
  ctx: { deliveryZones?: Array<{ postcodePrefix?: string | null }>; address?: { city?: string | null } },
): RankedAddress[] {
  const spokenLine = addressLineFrom(said) ?? said;
  const spokenStreet = streetOf(spokenLine) ?? spokenLine;
  const spokenFold = foldWords(spokenStreet);
  // Whatever came BEFORE the street, and nothing else. Asking the house-number
  // parser for one when the caller gave no number got the street handed back
  // as a house name, and the read-back became "Sunningdale Drive Sunningdale
  // Drive".
  const house =
    spokenLine.length > spokenStreet.length && spokenLine.endsWith(spokenStreet)
      ? spokenLine
          .slice(0, spokenLine.length - spokenStreet.length)
          .trim()
          .replace(/,$/, "")
          .trim() || null
      : null;
  const zones = (ctx.deliveryZones ?? [])
    .map((z) => String(z.postcodePrefix ?? "").toUpperCase().replace(/\s+/g, ""))
    .filter(Boolean);

  const ranked: RankedAddress[] = [];
  for (const c of candidates) {
    const postcode = normalisePostcode(c.postcode ?? "");
    // No postcode, no use. We need it for the zone, the driver and the
    // receipt, and a half-address read back sounds like understanding.
    if (!postcode) continue;

    const street = streetOf(c.line1) ?? c.line1 ?? "";
    if (!street) continue;
    const streetFold = foldWords(street);

    // The same scorer the menu uses, for the same reason: a transcript of a
    // street is a near miss, not a match. "Sunnyndale Drive" has to reach
    // "Sunningdale Drive" while "Whitewell Road" must not reach "Fellside
    // Road" on the strength of them both ending in a road type.
    let score = 0;
    const streetScore =
      streetFold === spokenFold ? 1 : Math.max(scoreItem(spokenStreet, street), scoreItem(street, spokenStreet));
    if (streetScore >= 0.75) score += streetScore;
    else continue; // a different road is not this caller's road

    if (zones.some((z) => outwardCode(postcode).startsWith(z) || z.startsWith(outwardCode(postcode)))) {
      score += 0.5;
    }
    const town = c.city ?? "";
    if (town && foldWords(said).includes(foldWords(town))) score += 0.3;
    else if (town && ctx.address?.city && foldWords(town) === foldWords(ctx.address.city)) score += 0.1;

    ranked.push({
      address: {
        // The geocoder rarely knows the house number and the caller always
        // does, so theirs wins.
        line1: [house, street].filter(Boolean).join(" "),
        city: c.city ?? ctx.address?.city ?? undefined,
        postcode,
      },
      score,
    });
  }

  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Is the best of them good enough to read back?
 *
 * Same shape as the menu matcher's confidence, and for the same reason: a
 * strong match that a runner-up is breathing down the neck of is not a
 * decision to make on someone's behalf. Two Fellside Roads one postcode
 * district apart is exactly that situation.
 */
export function bestAddress(ranked: RankedAddress[]): ResolvedAddress | null {
  const [best, second] = ranked;
  if (!best || best.score < 1) return null;
  if (second && best.score - second.score < 0.3) return null;
  return best.address;
}
