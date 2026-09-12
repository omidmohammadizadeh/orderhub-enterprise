import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";

/**
 * Handing a phone provider the address to ring, and proving it arrived.
 *
 * Two problems this solves, both of which used to be answered by a human:
 *
 *  1. The operator had to dig a location id out of a browser URL and paste a
 *     secret by hand. Now the shop's whole webhook line is built server-side
 *     and copied in one tap.
 *
 *  2. VOIP_WEBHOOK_KEY is ONE key for every shop on the platform. Any provider
 *     holding it could post rings against another shop's location id — not a
 *     breach we have seen, but the kind that only stays theoretical while the
 *     feature is small. Each shop now gets its own token, and that token is
 *     the only one we hand out. The shared key keeps working for the shops
 *     already live on it; nothing in the field has to be re-keyed on a
 *     deploy, and it is never shown in the dashboard to anybody.
 *
 * The shop token is stored on Location.settings.voipWebhookToken. It is a
 * ring-a-doorbell credential, not an account one — the worst a leaked token
 * does is put a fake caller card on that one shop's tills — so it lives
 * beside the shop's other settings rather than in the credential vault.
 */

export type RingSource = "webhook" | "voice" | "comet" | "test";

export interface RingRecord {
  at: string;
  /** Masked to the last 4 — this is a customer's number. */
  masked: string;
  /** How many digits arrived. 15 means two numbers stuck together. */
  digits: number;
  source: RingSource;
  /** True when the number that reached us is the SHOP's own, not the caller's. */
  looksLikeShopsOwnNumber?: boolean;
  matched?: boolean;
  /** Set when a post was refused, with why. */
  rejected?: string;
}

const RINGS_PER_LOCATION = 12;
const MAX_LOCATIONS_TRACKED = 300;

@Injectable()
export class CallerIdSetupService {
  private readonly logger = new Logger(CallerIdSetupService.name);

  /**
   * Recent rings, in memory and deliberately not in the database.
   *
   * This is a "did the provider's test call arrive?" light, looked at for a
   * minute during setup and never again. A row per ring would be a table of
   * customer phone numbers we have no reason to keep, growing forever, for a
   * question that stops being asked once the answer is yes. Losing it on a
   * deploy is the correct trade.
   */
  private readonly rings = new Map<string, RingRecord[]>();

  constructor(private readonly prisma: PrismaService) {}

  // ── The address we give the provider ────────────────────────────────────

  /** `https://…/api/v1/customers/caller-id/voip/<locationId>` */
  webhookUrl(locationId: string): string {
    const base = (process.env.API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
    return `${base}/api/v1/customers/caller-id/voip/${locationId}`;
  }

  sharedKeyEnabled(): boolean {
    return !!process.env.VOIP_WEBHOOK_KEY;
  }

  /**
   * Everything the setup panel needs for one shop, including its token.
   *
   * Tenant-scoped: the caller's own tenant id is matched against the
   * location's, so a location id guessed or pasted from elsewhere returns a
   * 404 rather than another tenant's token.
   */
  async getSetup(tenantId: string, locationId: string) {
    const loc = await this.locationInTenant(tenantId, locationId);
    const settings = (loc.settings ?? {}) as Record<string, any>;
    return {
      locationId: loc.id,
      locationName: loc.name,
      url: this.webhookUrl(loc.id),
      headerName: "x-voip-key",
      token: typeof settings.voipWebhookToken === "string" ? settings.voipWebhookToken : null,
      /** A shop with no token of its own can still be live on the shared key. */
      sharedKeyEnabled: this.sharedKeyEnabled(),
      /** Simultaneous-ring route: the number a provider would ring, and whether it's armed. */
      voiceNumber: typeof settings.voiceNumber === "string" ? settings.voiceNumber : null,
      callerIdOnly: settings.voiceCallerIdOnly === true,
      recentRings: this.recentRings(loc.id),
    };
  }

  /** Mint (or replace) this shop's token. Replacing immediately retires the old one. */
  async rotateToken(tenantId: string, locationId: string): Promise<string> {
    const loc = await this.locationInTenant(tenantId, locationId);
    const token = `ohcid_${randomBytes(24).toString("base64url")}`;
    const settings = { ...((loc.settings ?? {}) as Record<string, any>), voipWebhookToken: token };
    await this.prisma.location.update({ where: { id: loc.id }, data: { settings } });
    this.logger.log(`Caller-ID webhook token minted for location ${loc.id}`);
    return token;
  }

  // ── Letting a ring in ───────────────────────────────────────────────────

  /**
   * Does this presented key open this shop's door?
   *
   * Per-shop token first, platform key second. Both compared in constant time;
   * a length mismatch short-circuits, which leaks only the length.
   */
  async authorise(
    locationId: string,
    presented: string | undefined,
  ): Promise<{
    ok: boolean;
    locationExists: boolean;
    via?: "shop" | "shared";
    /** The shop's own numbers, so a ring carrying one can be flagged. */
    ownNumbers: string[];
  }> {
    if (!presented || presented.length > 200) {
      return { ok: false, locationExists: false, ownNumbers: [] };
    }
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null },
      select: { id: true, phone: true, settings: true },
    });
    const ownNumbers = loc ? ownNumbersOf(loc.phone, loc.settings) : [];
    const shopToken = (loc?.settings as any)?.voipWebhookToken;
    if (typeof shopToken === "string" && shopToken && constantEquals(presented, shopToken)) {
      return { ok: true, locationExists: true, via: "shop", ownNumbers };
    }
    const shared = process.env.VOIP_WEBHOOK_KEY;
    if (shared && constantEquals(presented, shared)) {
      return { ok: true, locationExists: !!loc, via: "shared", ownNumbers };
    }
    return { ok: false, locationExists: !!loc, ownNumbers };
  }

  // ── The "did it arrive?" light ──────────────────────────────────────────

  record(entry: {
    locationId: string;
    phone: string;
    source: RingSource;
    matched?: boolean;
    rejected?: string;
    /** The shop's own numbers, from `authorise` or `ownNumbersOf`. */
    ownNumbers?: string[];
  }): void {
    const digits = entry.phone.replace(/\D/g, "");
    const suffix = digits.slice(-9);
    const record: RingRecord = {
      at: new Date().toISOString(),
      masked: digits ? `…${digits.slice(-4)}` : "(withheld)",
      digits: digits.length,
      source: entry.source,
      matched: entry.matched,
      rejected: entry.rejected,
      looksLikeShopsOwnNumber:
        suffix.length === 9 && (entry.ownNumbers ?? []).includes(suffix),
    };
    const list = this.rings.get(entry.locationId) ?? [];
    list.unshift(record);
    this.rings.set(entry.locationId, list.slice(0, RINGS_PER_LOCATION));
    // Bound the map itself so a spray of location ids can't grow it forever.
    if (this.rings.size > MAX_LOCATIONS_TRACKED) {
      const oldest = this.rings.keys().next().value;
      if (oldest) this.rings.delete(oldest);
    }
  }

  recentRings(locationId: string): RingRecord[] {
    return this.rings.get(locationId) ?? [];
  }

  private async locationInTenant(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: { id: true, name: true, settings: true },
    });
    if (!loc) throw new NotFoundException("Unknown location");
    return loc;
  }
}

/**
 * The shop's OWN numbers, as 9-digit suffixes.
 *
 * One of the two things that decide whether a provider's simultaneous ring is
 * usable at all is whether the CALLER's number reaches us or the shop's own
 * replaces it — and an operator cannot tell by eye, because a number appears
 * on the till either way. It is the same number on every call that gives it
 * away, so we compare each ring against the shop's lines and say so.
 *
 * Nine digits because that is what the caller-ID lookup matches on: it makes
 * 01388… and +441388… forms of one line compare equal.
 */
export function ownNumbersOf(phone: string | null | undefined, settings: unknown): string[] {
  const s = (settings ?? {}) as Record<string, any>;
  return [phone, s.callerIdNumber, s.voiceNumber, s.smsNumber]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map((v) => v.replace(/\D/g, "").slice(-9))
    .filter((v) => v.length === 9);
}

function constantEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
