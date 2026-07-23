import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * Rate-limit key by AUTHENTICATED USER when we have one, falling back to IP.
 *
 * The default ThrottlerGuard keys purely by IP. Behind a shop's single NAT/proxy
 * IP — or Cloudflare→Render hops where `trust proxy` may not recover the real
 * client IP — every dashboard tab and staff member collapses into ONE bucket and
 * 429s each other ("Failed to load orders"). Keying by user id gives each logged-
 * in operator their own bucket, immune to shared IPs and multi-tab polling.
 *
 * Runs after JwtAuthGuard (registered earlier in APP_GUARD order), so req.user is
 * populated for authenticated routes. Anonymous/public routes (login, webhooks)
 * still fall back to IP, keeping their abuse protection intact.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const userId = req?.user?.id ?? req?.user?.userId;
    if (userId) return `user:${userId}`;

    // For anonymous requests, req.ip is NOT the real client behind Render's
    // Cloudflare edge — it's a shared infra IP, so every client collapses into
    // ONE bucket and 429s each other. Cloudflare sets the true client IP on
    // `cf-connecting-ip`; use it so each real client gets its own bucket. Fall
    // back to the left-most X-Forwarded-For, then req.ip.
    const headers = req?.headers ?? {};
    const cfIp =
      typeof headers["cf-connecting-ip"] === "string"
        ? headers["cf-connecting-ip"]
        : undefined;
    const xff =
      typeof headers["x-forwarded-for"] === "string"
        ? headers["x-forwarded-for"].split(",")[0].trim()
        : undefined;
    return `ip:${cfIp ?? xff ?? req?.ip ?? "anon"}`;
  }
}
