import * as crypto from "crypto";
import { KeetaInt, stringifyKeeta } from "./keeta-json";

// Phase KT — Keeta's request signature (Standard Keeta API).
//
// VERIFIED against the worked example in their Authorization Guide: the test
// reproduces their published sig 48eb6d56…ca86 byte for byte.
//
//   sig = lowercase_hex( SHA-256( URL + "?" + k1=v1&k2=v2… + AppSecret ) )
//
// Traps, every one of which their prose gets wrong or leaves out:
//
//   • It is a plain SHA-256 of the secret APPENDED — not an HMAC, and not
//     Base64, whatever the API Request Protocol page says ("HMAC-SHA256").
//   • The "?" between URL and params appears only in their example and their
//     Java, not in the written steps. The example is what the server checks.
//   • The secret is appended with NO separator: "...timestamp=1682566749abc".
//   • Keys ASCII-sorted, `sig` itself excluded, EMPTY and NULL values included
//     ("description":null is signed as the text null).
//   • A nested object or array is signed as its JSON text "as-is", unsorted
//     inside. We sign exactly the string we put on the wire (stringifyKeeta),
//     so the two cannot drift.
//   • The URL is the full endpoint URL with no query string.
//
// This file is also where the (undocumented) WEBHOOK signature is checked —
// see keetaWebhookSigCandidates.

/** How one body value is written into the string to sign. */
export function keetaSigValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof KeetaInt) return value.digits;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return stringifyKeeta(value);
}

/** k1=v1&k2=v2… over every param but `sig`, keys in ASCII order. */
export function keetaSortedParams(params: Record<string, unknown>): string {
  return Object.keys(params)
    .filter((k) => k !== "sig" && params[k] !== undefined)
    // Plain code-unit comparison = ASCII order, which is what Java's
    // Arrays.sort on the key set does. localeCompare would not be.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => `${k}=${keetaSigValue(params[k])}`)
    .join("&");
}

/** The exact pre-hash string. Exported so a failing sig can be logged. */
export function keetaSigBase(url: string, params: Record<string, unknown>, secret: string): string {
  return `${url}?${keetaSortedParams(params)}${secret}`;
}

export function keetaSign(url: string, params: Record<string, unknown>, secret: string): string {
  return crypto.createHash("sha256").update(keetaSigBase(url, params, secret), "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(String(a ?? "").toLowerCase(), "utf8");
  const y = Buffer.from(String(b ?? "").toLowerCase(), "utf8");
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Candidate recipes for the WEBHOOK signature.
 *
 * Keeta say "Developers must verify message signatures" and never say how.
 * The obvious guess is the same recipe as a request, with OUR webhook URL in
 * place of theirs — but whether the URL is included, and which URL, is
 * exactly what the docs leave out. So we try the plausible variants and
 * REPORT which one matched, the same approach that settled JET's HMAC on the
 * first real delivery. Until one has been seen matching, the controller runs
 * in observe mode (KEETA_WEBHOOK_SIG_MODE) and does not drop orders over it.
 */
export function keetaWebhookSigCandidates(
  envelope: Record<string, unknown>,
  secret: string,
  urls: string[],
): Array<{ variant: string; sig: string }> {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) if (k !== "sig") params[k] = v;
  const sorted = keetaSortedParams(params);
  const hash = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
  const out: Array<{ variant: string; sig: string }> = [];
  for (const u of Array.from(new Set(urls.filter(Boolean)))) {
    out.push({ variant: `url?params+secret (${u})`, sig: hash(`${u}?${sorted}${secret}`) });
    out.push({ variant: `url+params+secret (${u})`, sig: hash(`${u}${sorted}${secret}`) });
  }
  out.push({ variant: "params+secret", sig: hash(`${sorted}${secret}`) });
  out.push({ variant: "?params+secret", sig: hash(`?${sorted}${secret}`) });
  return out;
}

/** Which candidate, if any, reproduces the sig Keeta sent. */
export function verifyKeetaWebhookSig(
  envelope: Record<string, unknown>,
  secret: string,
  urls: string[],
): { ok: boolean; variant: string | null } {
  const presented = String(envelope?.sig ?? "");
  if (!presented || !secret) return { ok: false, variant: null };
  for (const c of keetaWebhookSigCandidates(envelope, secret, urls)) {
    if (safeEqualHex(c.sig, presented)) return { ok: true, variant: c.variant };
  }
  return { ok: false, variant: null };
}
