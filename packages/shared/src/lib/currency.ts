// ── Country-derived defaults for a location ─────────────────────────────────
//
// Money was GBP everywhere: hardcoded "gbp" through the payment services and a
// literal £ in well over a hundred places in the dashboard. That is fine for a
// UK-only product and wrong the moment one shop trades in Dubai — a UAE
// operator would price in AED and read the total as pounds.
//
// Currency belongs to the LOCATION. Not to a global toggle, and not to the
// brand: a brand can trade in two countries, but a shop has one till, one
// bank account and one currency.

/** Country (ISO-3166 alpha-2) -> currency (ISO-4217). */
export const CURRENCY_BY_COUNTRY: Record<string, string> = {
  GB: "GBP",
  IE: "EUR",
  US: "USD",
  // Talabat / Careem markets.
  AE: "AED", // United Arab Emirates
  SA: "SAR", // Saudi Arabia
  KW: "KWD", // Kuwait
  QA: "QAR", // Qatar
  BH: "BHD", // Bahrain
  OM: "OMR", // Oman
  JO: "JOD", // Jordan
  EG: "EGP", // Egypt
  IQ: "IQD", // Iraq
  PK: "PKR", // Pakistan
};

export const DEFAULT_CURRENCY = "GBP";

/** The currency a country trades in. Unknown country falls back to GBP. */
export function currencyForCountry(country: string | null | undefined): string {
  const c = String(country ?? "").trim().toUpperCase();
  return CURRENCY_BY_COUNTRY[c] ?? DEFAULT_CURRENCY;
}

/**
 * How many decimal places this currency actually has.
 *
 * NOT always 2. The Kuwaiti, Bahraini and Omani dinars and the Jordanian
 * dinar are thousandths — 1.250 KWD is one dinar 250 fils, and rendering it
 * as "1.25" is a different amount of money. Iraq and Japan have none at all.
 * Anything that formats or rounds money has to ask rather than assume, which
 * is why `.toFixed(2)` is not safe once a Gulf shop exists.
 */
export function currencyDecimals(currency: string | null | undefined): number {
  const c = String(currency ?? DEFAULT_CURRENCY).trim().toUpperCase();
  if (["KWD", "BHD", "OMR", "JOD", "TND", "LYD"].includes(c)) return 3;
  if (["JPY", "KRW", "IQD", "VND", "CLP", "ISK"].includes(c)) return 0;
  return 2;
}

/** Short symbol for compact places — tiles, buttons, a 32-column receipt. */
export function currencySymbol(currency: string | null | undefined): string {
  const c = String(currency ?? DEFAULT_CURRENCY).trim().toUpperCase();
  const map: Record<string, string> = {
    GBP: "£",
    EUR: "€",
    USD: "$",
    AED: "AED ",
    SAR: "SAR ",
    KWD: "KWD ",
    QAR: "QAR ",
    BHD: "BHD ",
    OMR: "OMR ",
    JOD: "JOD ",
    EGP: "EGP ",
    IQD: "IQD ",
    PKR: "Rs ",
  };
  return map[c] ?? `${c} `;
}

/**
 * Format an amount for display.
 *
 * Uses the platform's own currency data where available so AED, KWD and the
 * rest come out with the right decimals and placement. Falls back to a plain
 * symbol + fixed decimals when Intl is unavailable (the print bridge runs in
 * places where it is not) — the fallback still asks currencyDecimals, so a
 * dinar keeps its three places either way.
 */
/**
 * Convert a decimal amount to a provider's smallest unit, and back.
 *
 * `amount * 100` is written out by hand all over the payments code and is
 * WRONG for a third of the currencies we now trade in: the Gulf dinars (KWD,
 * BHD, OMR) and JOD are thousandths, so 1.250 KWD is 1250 fils, not 125. Two
 * of Stripe's zero-decimal currencies (JPY, KRW) go the other way.
 *
 * Ask currencyDecimals rather than assuming, and round — floating point makes
 * 19.99 * 100 come out at 1998.9999999999998, which truncates to a penny
 * short on every order.
 */
export function toMinorUnits(
  amount: number | string | null | undefined,
  currency: string | null | undefined,
): number {
  const n = Number(amount);
  const value = Number.isFinite(n) ? n : 0;
  return Math.round(value * 10 ** currencyDecimals(currency));
}

export function fromMinorUnits(
  units: number | string | null | undefined,
  currency: string | null | undefined,
): number {
  const n = Number(units);
  const value = Number.isFinite(n) ? n : 0;
  return value / 10 ** currencyDecimals(currency);
}

/**
 * Round a decimal amount to the number of places its currency actually has.
 *
 * Tap takes amounts as DECIMALS rather than minor units, and rejects one with
 * more precision than the currency allows — and its webhook signature is
 * computed over the amount as a string, so an amount that disagrees with
 * Tap's rounding fails signature verification rather than failing visibly.
 */
export function roundToCurrency(
  amount: number | string | null | undefined,
  currency: string | null | undefined,
): number {
  return fromMinorUnits(toMinorUnits(amount, currency), currency);
}

/**
 * What to CALL a currency out loud, and what to call its subunit.
 *
 * For the voice agent, which is read aloud by a speech engine: "four pounds
 * fifty", "fifteen dirhams". The prompt used to hardcode pounds, so the phone
 * bot quoted a Dubai caller's order in sterling while the till charged AED.
 *
 * Plural forms only — prices are said as "one pound fifty" rarely enough that
 * a singular table would be more machinery than it earns.
 */
const CURRENCY_NAMES: Record<string, { major: string; minor: string }> = {
  GBP: { major: "pounds", minor: "pence" },
  EUR: { major: "euros", minor: "cents" },
  USD: { major: "dollars", minor: "cents" },
  AED: { major: "dirhams", minor: "fils" },
  SAR: { major: "riyals", minor: "halalas" },
  QAR: { major: "riyals", minor: "dirhams" },
  KWD: { major: "dinars", minor: "fils" },
  BHD: { major: "dinars", minor: "fils" },
  OMR: { major: "rials", minor: "baisa" },
  JOD: { major: "dinars", minor: "piastres" },
  EGP: { major: "pounds", minor: "piastres" },
  IQD: { major: "dinars", minor: "fils" },
  PKR: { major: "rupees", minor: "paisa" },
};

/** The spoken name of a currency's main unit, e.g. "dirhams". Falls back to
 *  the ISO code, which a speech engine reads out letter by letter — ugly, but
 *  unmistakably not a wrong currency name. */
export function currencyName(currency: string | null | undefined): string {
  const c = String(currency ?? DEFAULT_CURRENCY).trim().toUpperCase();
  return CURRENCY_NAMES[c]?.major ?? c;
}

/** The spoken name of a currency's subunit, e.g. "fils". */
export function currencyMinorName(currency: string | null | undefined): string {
  const c = String(currency ?? DEFAULT_CURRENCY).trim().toUpperCase();
  return CURRENCY_NAMES[c]?.minor ?? "";
}

export function formatMoney(
  amount: number | string | null | undefined,
  currency: string | null | undefined = DEFAULT_CURRENCY,
  opts?: { /** Symbol only, no grouping — for narrow receipt columns. */ compact?: boolean },
): string {
  const n = Number(amount);
  const value = Number.isFinite(n) ? n : 0;
  const cur = String(currency ?? DEFAULT_CURRENCY).trim().toUpperCase();
  const dp = currencyDecimals(cur);

  if (opts?.compact) return `${currencySymbol(cur)}${value.toFixed(dp)}`;

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: cur,
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    }).format(value);
  } catch {
    // Unknown/invalid code — never throw over a display concern.
    return `${currencySymbol(cur)}${value.toFixed(dp)}`;
  }
}

/**
 * Default IANA timezone for a country.
 *
 * Used to seed Location.timezone when a shop is created — a Dubai location
 * created with the old Europe/London default would advertise its opening
 * hours four hours out, and publish the wrong service times to every
 * marketplace. The operator can still change it; this only stops the default
 * from being silently wrong.
 *
 * Countries with several zones are not guessed at — they keep the UK default
 * and the operator picks, which is honest rather than confidently wrong.
 */
export const TIMEZONE_BY_COUNTRY: Record<string, string> = {
  GB: "Europe/London",
  IE: "Europe/Dublin",
  AE: "Asia/Dubai",
  SA: "Asia/Riyadh",
  KW: "Asia/Kuwait",
  QA: "Asia/Qatar",
  BH: "Asia/Bahrain",
  OM: "Asia/Muscat",
  JO: "Asia/Amman",
  EG: "Africa/Cairo",
  IQ: "Asia/Baghdad",
  PK: "Asia/Karachi",
};

export const DEFAULT_TIMEZONE = "Europe/London";

export function timezoneForCountry(country: string | null | undefined): string {
  const c = String(country ?? "").trim().toUpperCase();
  return TIMEZONE_BY_COUNTRY[c] ?? DEFAULT_TIMEZONE;
}

/**
 * Notes a counter actually reaches for, per currency.
 *
 * The cash keypad's quick-tender buttons were 5/10/20/50 — UK notes. Showing
 * the right SYMBOL against those was only half the fix: a Dubai counter is
 * handed 10/20/50/100 dirham notes and never a 5, so a UK ladder makes the
 * shortcut buttons useless and staff key every amount by hand.
 *
 * Deliberately the physical notes in circulation, not round numbers: the
 * button exists so an operator can tap what the customer just handed over.
 */
export const TENDER_NOTES: Record<string, number[]> = {
  GBP: [5, 10, 20, 50],
  EUR: [5, 10, 20, 50],
  USD: [5, 10, 20, 50],
  AED: [10, 20, 50, 100],
  SAR: [5, 10, 50, 100],
  QAR: [10, 50, 100, 500],
  // The dinars are thousandths, and their small notes are fractional — a
  // half-dinar note is real currency, so 0.5 belongs on the keypad.
  KWD: [0.5, 1, 5, 10],
  BHD: [0.5, 1, 5, 10],
  OMR: [0.5, 1, 5, 10],
  JOD: [1, 5, 10, 20],
  EGP: [10, 20, 50, 100],
  PKR: [50, 100, 500, 1000],
};

/** Quick-tender buttons for this currency; falls back to the GBP ladder. */
export function tenderNotesFor(currency: string | null | undefined): number[] {
  const c = String(currency ?? DEFAULT_CURRENCY).trim().toUpperCase();
  return TENDER_NOTES[c] ?? TENDER_NOTES.GBP!;
}

/**
 * Countries a shop can be created in, for the picker.
 *
 * Derived from the ones we actually support rather than a full ISO list: each
 * of these has a currency, a timezone and a channel set behind it, so offering
 * a country we cannot price or schedule would be a trap. The Country field was
 * a free-text box with a "GB" placeholder — typing "UAE" or "Dubai" instead of
 * "AE" missed every lookup and silently produced a GBP/London shop.
 */
export interface CountryOption {
  code: string;
  name: string;
  /** Dial prefix, for phone-field placeholders. */
  dialCode: string;
}

export const SUPPORTED_COUNTRIES: CountryOption[] = [
  { code: "GB", name: "United Kingdom", dialCode: "+44" },
  { code: "IE", name: "Ireland", dialCode: "+353" },
  { code: "AE", name: "United Arab Emirates", dialCode: "+971" },
  { code: "SA", name: "Saudi Arabia", dialCode: "+966" },
  { code: "KW", name: "Kuwait", dialCode: "+965" },
  { code: "QA", name: "Qatar", dialCode: "+974" },
  { code: "BH", name: "Bahrain", dialCode: "+973" },
  { code: "OM", name: "Oman", dialCode: "+968" },
  { code: "JO", name: "Jordan", dialCode: "+962" },
  { code: "EG", name: "Egypt", dialCode: "+20" },
  { code: "US", name: "United States", dialCode: "+1" },
];

export function countryOption(code: string | null | undefined): CountryOption | undefined {
  const c = String(code ?? "").trim().toUpperCase();
  return SUPPORTED_COUNTRIES.find((x) => x.code === c);
}

/** Dial prefix for a country, for placeholders. Defaults to the UK. */
export function dialCodeForCountry(code: string | null | undefined): string {
  return countryOption(code)?.dialCode ?? "+44";
}
