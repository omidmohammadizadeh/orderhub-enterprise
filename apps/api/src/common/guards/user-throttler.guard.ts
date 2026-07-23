import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/** Decode the `sub` (user id) from a JWT WITHOUT verifying it. Safe here: this
 *  is only used to pick a rate-limit bucket — a forged token still fails auth
 *  (JwtAuthGuard), so the worst case is someone throttling their own fake key. */
function jwtSub(token: string): string | undefined {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return undefined;
    const json = Buffer.from(payloadPart, "base64url").toString("utf8");
    const payload = JSON.parse(json) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rate-limit key by AUTHENTICATED USER, else by the REAL client IP.
 *
 * Two failure modes the default ThrottlerGuard hit in production:
 *  1. It keys purely by IP, and behind Render's Cloudflare edge `req.ip` is a
 *     shared infra IP — so every dashboard collapsed into one bucket and 429'd
 *     each other platform-wide ("Failed to load orders").
 *  2. `req.user` is NOT reliably set at throttle time (guard execution order),
 *     so keying off req.user alone silently fell back to that shared IP.
 *
 * Fix: derive the user id from req.user OR straight from the JWT in the
 * Authorization header (order-independent) → each logged-in operator gets their
 * own generous bucket. Anonymous requests key by the true client IP from
 * Cloudflare's `cf-connecting-ip` (→ x-forwarded-for → req.ip).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const fromReq = req?.user?.id ?? req?.user?.userId;
    if (typeof fromReq === "string" && fromReq) return `user:${fromReq}`;

    const auth = req?.headers?.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      const sub = jwtSub(auth.slice(7));
      if (sub) return `user:${sub}`;
    }

    const headers = (req?.headers ?? {}) as Record<
      string,
      string | string[] | undefined
    >;
    const cfRaw = headers["cf-connecting-ip"];
    const cfIp = typeof cfRaw === "string" ? cfRaw : undefined;
    const xffRaw = headers["x-forwarded-for"];
    const xff =
      typeof xffRaw === "string" ? xffRaw.split(",")[0]?.trim() : undefined;
    return `ip:${cfIp ?? xff ?? req?.ip ?? "anon"}`;
  }
}
