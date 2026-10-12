import { randomBytes } from "crypto";

// The two secrets a walk-in card carries (see LoyaltyMember in the schema).
//
// The CODE is what the QR on the card says. Prefixed so the till can tell a
// loyalty card from a product barcode or a returns receipt (OHR:) the moment
// the scanner fires, and short enough to read out if a scanner fails.
// Crockford-style alphabet: no 0/O or 1/I/L for anyone typing it.

export const CARD_PREFIX = "OHL:";
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newMemberCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** The long, unguessable link secret for the card page and the pass. */
export function newPublicToken(): string {
  return randomBytes(24).toString("base64url");
}

/** What the QR / barcode encodes. */
export function scanValue(code: string): string {
  return `${CARD_PREFIX}${code}`;
}

/**
 * The member code inside whatever the till received: the scanned "OHL:XXXX",
 * a code typed by hand with or without the prefix, in any case, with stray
 * spaces or dashes. Null when it cannot be a card code.
 */
export function parseMemberCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = String(raw).trim().toUpperCase();
  // Some keyboard-wedge scanners on a non-UK layout turn ":" into ";".
  v = v.replace(/^OHL[:;]/, "");
  v = v.replace(/[\s-]/g, "");
  if (!/^[2-9A-Z]{8}$/.test(v)) return null;
  return v;
}
