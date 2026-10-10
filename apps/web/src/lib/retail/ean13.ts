// EAN-13 bar patterns, for printing test labels without a barcode library.
//
// The standard encoding: a start guard, six left digits in odd (L) or even
// (G) parity chosen by the first digit, a centre guard, six right digits (R),
// an end guard — 95 modules. A 12-digit UPC-A is the same code with a leading
// zero. Anything else returns null and the caller shows a QR instead.

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** Normalise to a 13-digit EAN with a valid check digit, or null. */
export function asEan13(code: string): string | null {
  const c = String(code ?? "").trim();
  const d = /^\d{12}$/.test(c) ? `0${c}` : c;
  if (!/^\d{13}$/.test(d)) return null;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(d[12]) ? d : null;
}

/** The 95-module bar string ("1" = bar) for a valid EAN-13, or null. */
export function ean13Modules(code: string): string | null {
  const d = asEan13(code);
  if (!d) return null;
  const digits = d.split("").map(Number);
  const parity = PARITY[digits[0]!]!;
  let out = "101";
  for (let i = 1; i <= 6; i++) out += (parity[i - 1] === "L" ? L : G)[digits[i]!]!;
  out += "01010";
  for (let i = 7; i <= 12; i++) out += R[digits[i]!]!;
  return out + "101";
}
