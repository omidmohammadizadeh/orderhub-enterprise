/**
 * Phone-number and sender-ID normalisation for outbound SMS.
 *
 * Carriers reject anything that isn't E.164 ("+" + country code + national
 * number, digits only). Operators type numbers the way they're written on a
 * ticket — "07788 187123", "(07788) 187123", "0044 7788 187123" — and every
 * one of those was being handed to the provider verbatim, which failed the
 * send with `Invalid 'To' Phone Number: 0778818XXXX` and left a live order
 * uncollectable.
 */

/** Default country dialling code for numbers typed in national format.
 *  UK unless the deployment says otherwise (see SMS_DEFAULT_COUNTRY_CODE). */
function defaultDialCode(): string {
  const raw = (process.env.SMS_DEFAULT_COUNTRY_CODE ?? "44").replace(/\D/g, "");
  return raw || "44";
}

/**
 * Countries whose national trunk "0" is dropped in the international form.
 *
 * The UK and Ireland, and the Gulf states this product trades in. Deliberately
 * NOT a general rule: Italy (+39) keeps the leading zero on landlines, and
 * several others do too, so anything not listed here is left exactly as the
 * operator typed it.
 */
const TRUNK_DROPPED = new Set([
  "44", // United Kingdom
  "353", // Ireland
  "971", // United Arab Emirates
  "966", // Saudi Arabia
  "965", // Kuwait
  "973", // Bahrain
  "974", // Qatar
  "968", // Oman
]);

/**
 * Convert an operator-typed phone number to E.164, or null if it can't be.
 *
 * Deliberately NOT a full libphonenumber: we only need to recognise the four
 * shapes a UK restaurant actually types. Anything we can't confidently place
 * returns null so the caller can say so, rather than guessing and having the
 * carrier reject it (or worse, texting a stranger).
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Strip everything a human might type as decoration. Keep a leading "+".
  const trimmed = String(raw).trim();
  const plus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  const cc = defaultDialCode();

  if (plus) {
    // Already international.
  } else if (digits.startsWith("00")) {
    // "0044 7788…" — the international access prefix.
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    // National format: drop the trunk "0" and prepend the country code.
    // "07788 187123" -> "447788187123".
    digits = cc + digits.replace(/^0+/, "");
  } else if (digits.startsWith(cc)) {
    // Already carries the country code, just without the "+".
    // Left as-is.
  } else {
    // A bare national number with no trunk prefix ("7788187123").
    digits = cc + digits;
  }

  // "+44 (0)191 231 2345" — the trunk zero left in behind the country code.
  //
  // It is how half the businesses in the country write their own number, and
  // it survived every branch above: the "+" said this was already
  // international, so nothing dropped the national prefix. The result looks
  // like a phone number and is not one, which is worse than a rejection —
  // Telnyx answered a live transfer with "Destination Number is invalid" on
  // call DXSoOJaQ and the caller who had asked for a person got silence.
  //
  // Only for the countries that actually drop the trunk digit. Italy keeps
  // its leading zero and a Rome landline would be destroyed by this, so the
  // rule is a list and not a guess.
  // Read from the number itself, not from the deployment's default country:
  // a UAE shop's number reaches a UK-defaulted deployment as +971 and still
  // has to be cleaned. Longest code first, so a longer prefix is never
  // mistaken for a shorter one.
  for (const code of [...TRUNK_DROPPED].sort((a, b) => b.length - a.length)) {
    if (digits.startsWith(`${code}0`)) {
      digits = code + digits.slice(code.length).replace(/^0+/, "");
      break;
    }
  }

  // E.164 allows at most 15 digits; anything under 8 is not a real mobile or
  // landline and is far more likely to be a typo or an extension.
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/**
 * Clean a shop's SMS sender name into something the carrier will accept as an
 * alphanumeric sender ID, or null if it can't be used.
 *
 * Carrier rules: at most 11 characters, letters/digits/spaces only, and at
 * least one letter (an all-digit sender ID is treated as a phone number and
 * rejected). Returning null rather than throwing is the whole point — a
 * cosmetic setting must never be able to block collection on a live order, so
 * an unusable name silently falls back to the shop's number.
 */
export function sanitiseSenderId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw)
    .normalize("NFD")
    // Drop accents so "Café Roma" becomes "Cafe Roma" instead of losing the e.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 11)
    .trim();
  if (!cleaned) return null;
  if (!/[A-Za-z]/.test(cleaned)) return null;
  return cleaned;
}
