import { createHmac, timingSafeEqual } from "crypto";

// Phase TB-1 — the JWT Delivery Hero put on every call to our plugin.
//
// From the POS Plugin API's security scheme (MiddlewareJWTAuth):
//
//   • every request from the middleware carries `Authorization: Bearer <JWT>`;
//   • it is signed with a SECRET issued alongside our credentials, different
//     for staging and production;
//   • their example is HS512, payload `{ "service": "middleware" }`, and the
//     plugin "should also check if the token includes the service: middleware
//     claim".
//
// So this is an HMAC check plus one claim. No library: the format is three
// base64url segments and a keyed hash, and owning it means the failure modes
// are ours to name ("wrong secret", "claim missing") instead of a generic
// "invalid token".
//
// HS256 and HS384 are accepted as well as HS512 — the spec shows HS512 in an
// example rather than mandating it, and a signature is only valid under the
// secret either way. "none" and every asymmetric algorithm are refused: a
// token that chooses its own verification method is not verification.

const ALGORITHMS = {
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512",
} as const;
type Alg = keyof typeof ALGORITHMS;

export type TalabatJwtResult =
  | { ok: true; claims: Record<string, unknown> }
  | {
      ok: false;
      reason:
        | "missing"
        | "no_secret"
        | "malformed"
        | "unsupported_alg"
        | "bad_signature"
        | "wrong_service"
        | "expired";
    };

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Verify the middleware's token.
 *
 * Takes the raw header so the "Bearer " handling is in one place. Pure and
 * exported: every rejection path is a unit test rather than an HTTP probe.
 * `now` is injectable so the expiry check is testable without a clock.
 */
export function verifyTalabatJwt(
  authorization: string | undefined,
  secret: string | undefined,
  now: number = Date.now(),
): TalabatJwtResult {
  const key = (secret ?? "").trim();
  if (!key) return { ok: false, reason: "no_secret" };

  const raw = String(authorization ?? "").trim();
  if (!raw) return { ok: false, reason: "missing" };
  const token = raw.replace(/^Bearer\s+/i, "").trim();

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) {
    return { ok: false, reason: "malformed" };
  }
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  const claims = decodeJson(p);
  if (!header || !claims) return { ok: false, reason: "malformed" };

  const alg = String(header.alg ?? "") as Alg;
  if (!(alg in ALGORITHMS)) return { ok: false, reason: "unsupported_alg" };

  const expected = createHmac(ALGORITHMS[alg], key).update(`${h}.${p}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(s, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  // The claim their docs tell plugins to check. A token signed with our
  // secret for some other purpose is still not the middleware.
  if (claims.service !== "middleware") return { ok: false, reason: "wrong_service" };

  // Their example carries no exp, so an absent one is fine; a present one is
  // honoured. Seconds, per RFC 7519.
  if (typeof claims.exp === "number" && claims.exp * 1000 < now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}

/**
 * Sign a token the way the middleware does. Used ONLY by our sandbox, which
 * plays the middleware against our own plugin endpoints — never by anything
 * talking to Delivery Hero.
 */
export function signTalabatJwt(
  claims: Record<string, unknown>,
  secret: string,
  alg: Alg = "HS512",
): string {
  const h = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg })));
  const p = b64url(Buffer.from(JSON.stringify(claims)));
  const s = b64url(createHmac(ALGORITHMS[alg], secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${s}`;
}
