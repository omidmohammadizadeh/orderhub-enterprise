import { createHmac, timingSafeEqual } from "crypto";

// Signed tokens for links that act without a login: unsubscribe, and the
// one-click List-Unsubscribe POST that Gmail and Yahoo fire on their own.
//
// The id inside is not secret (a cuid), the signature is what stops someone
// unsubscribing a whole list by guessing ids. Tokens never expire: an
// unsubscribe link in a two-year-old email must still work — the law does not
// let it stop.

export type EmailTokenKind = "r" | "c"; // recipient | contact

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(secret: string, payload: string): string {
  return b64url(createHmac("sha256", secret).update(`email-unsub:${payload}`).digest()).slice(0, 27);
}

export function makeEmailToken(secret: string, kind: EmailTokenKind, id: string): string {
  const payload = `${kind}:${id}`;
  return `${b64url(payload)}.${sign(secret, payload)}`;
}

export function readEmailToken(
  secret: string,
  token: string | undefined | null,
): { kind: EmailTokenKind; id: string } | null {
  const [p, sig] = String(token ?? "").split(".");
  if (!p || !sig || !secret) return null;
  let payload: string;
  try {
    payload = Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }
  const expected = sign(secret, payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const m = payload.match(/^([rc]):(.+)$/);
  if (!m) return null;
  return { kind: m[1] as EmailTokenKind, id: m[2]! };
}

/**
 * Resend signs webhooks with Svix: HMAC-SHA256 over `${id}.${timestamp}.${body}`
 * keyed with the base64 part of `whsec_…`, sent as space-separated `v1,<sig>`.
 * Five minutes of clock skew either way, so a captured payload can't be
 * replayed tomorrow.
 */
export function verifySvixSignature(args: {
  secret: string;
  id?: string;
  timestamp?: string;
  signature?: string;
  body: string;
  nowSeconds?: number;
}): boolean {
  const { secret, id, timestamp, signature, body } = args;
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  const e = Buffer.from(expected);
  return signature.split(" ").some((part) => {
    const sig = part.split(",")[1] ?? "";
    const s = Buffer.from(sig);
    return s.length === e.length && timingSafeEqual(s, e);
  });
}
