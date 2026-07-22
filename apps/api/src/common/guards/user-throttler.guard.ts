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
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const userId = req?.user?.id ?? req?.user?.userId;
    return userId ? `user:${userId}` : (req?.ip ?? "anon");
  }
}
