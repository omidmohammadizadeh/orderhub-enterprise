// Does a phone number typed at the online checkout look like a real one?
//
// The storefront took anything at all in the phone box. The owner of Best
// Kebab tried it himself (14 Oct 2026) and any number placed an order, which
// leaves a shop with food in a bag and no way to ring the customer. This is a shape
// check, not proof of ownership. It stops typos and made-up numbers; it
// cannot stop somebody typing a real number that is not theirs, which would
// need a code sent by SMS.
//
// Deliberately small, like toE164 in the API's sms module: we only need the
// shapes a customer of a UK or Gulf shop actually types.

/** Countries whose number plan we check exactly. Everywhere else gets the
 *  length check only: Ireland's mobiles are 9 digits after the 0, the Gulf's
 *  vary, and a wrong exact rule would turn real customers away. */
const UK_LIKE = new Set(["GB", "UK"]);

/**
 * True when `raw` is plausibly a reachable phone number for a shop in
 * `country` (ISO code; UK when unknown).
 */
export function isPlausibleCustomerPhone(
  raw: string | null | undefined,
  country?: string | null,
): boolean {
  if (!raw) return false;
  const trimmed = String(raw).trim();
  // Letters mean it is not a number somebody can dial.
  if (/[a-z]/i.test(trimmed)) return false;
  const plus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);

  // "07777 777777", "0000000000": a real line never repeats one digit.
  const significant = digits.replace(/^0+/, "");
  if (!significant || /^(\d)\1+$/.test(significant)) return false;

  const cc = String(country ?? "GB").toUpperCase();
  const international = plus || trimmed.replace(/\s/g, "").startsWith("00");

  if (UK_LIKE.has(cc) && (!international || digits.startsWith("44"))) {
    // National significant number: drop "44" and the trunk "0" (including
    // the "+44 (0)…" spelling). UK numbers are 10 digits after the 0 and
    // start 1, 2, 3, 5, 7 or 8 (9 is premium rate, 4 and 6 are unused).
    let nsn = digits;
    if (international || nsn.startsWith("44")) nsn = nsn.replace(/^44/, "");
    nsn = nsn.replace(/^0/, "");
    return nsn.length === 10 && /^[123578]/.test(nsn);
  }

  // Anywhere else: E.164 allows up to 15 digits, and nothing reachable is
  // shorter than 8 (country code included or a national number).
  return digits.length >= 8 && digits.length <= 15;
}
