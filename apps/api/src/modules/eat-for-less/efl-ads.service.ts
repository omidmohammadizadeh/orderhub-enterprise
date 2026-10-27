// Eat For Less — sponsored listings: the auction, the taps, and what a shop
// owes. Rules live in efl-ads-rules.ts; this gathers the facts.

import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import {
  MAX_SHOWS_PER_DAY,
  TAP_DEDUPE_MINUTES,
  adRecoveryPence,
  londonDateKey,
  londonWeekStart,
  nextWeekStart,
  pacedBudgetLeft,
  predictedOrderChance,
  runAuction,
  validateCampaign,
  weekFraction,
} from "./efl-ads-rules";

/** A sponsored place is good for this long; a stale token can't be charged. */
const TOKEN_TTL_MS = 30 * 60_000;
/** Orders still waiting on payment hold their recovery this long, so two at
 *  once can't both pay off the same balance. */
const PENDING_RESERVE_MS = 60 * 60_000;
/** History used to predict how often a tap becomes an order. */
const CHANCE_WINDOW_DAYS = 30;
/** A tap counts towards an order placed within this long. */
const ATTRIBUTION_MS = 24 * 3600_000;

const PAID = ["PAID", "AUTHORIZED"];

export type Sponsored = { token: string; price: number };

@Injectable()
export class EflAdsService {
  private readonly logger = new Logger(EflAdsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The anonymous id a viewer is known by: never the raw id or IP. */
  static viewerKey(raw: { customerId?: string | null; installId?: string | null; ip?: string | null; ua?: string | null }) {
    const source = raw.customerId
      ? `c:${raw.customerId}`
      : raw.installId && /^[A-Za-z0-9_-]{8,64}$/.test(raw.installId)
        ? `i:${raw.installId}`
        : `n:${raw.ip ?? ""}|${raw.ua ?? ""}`;
    return createHash("sha256").update(`${secret()}:${source}`).digest("hex").slice(0, 32);
  }

  // ── The auction, run for each shop list ───────────────────────────────

  /**
   * Pick the sponsored shops for this viewer from the shops they could
   * actually order from, and count the show. Returns listingId → place.
   */
  async sponsor(
    candidates: Array<{ id: string; isOpen: boolean; orderable: boolean }>,
    viewerKey: string,
    now = new Date(),
  ): Promise<Map<string, Sponsored>> {
    const eligible = candidates.filter((c) => c.isOpen && c.orderable).map((c) => c.id);
    const placed = new Map<string, Sponsored>();
    if (!eligible.length) return placed;

    const campaigns = await this.prisma.eflAdCampaign.findMany({
      where: { listingId: { in: eligible }, active: true, pausedByAdmin: false },
    });
    if (!campaigns.length) return placed;

    const ids = campaigns.map((c) => c.listingId);
    const day = londonDateKey(now);
    const weekStart = londonWeekStart(now);
    const since = new Date(now.getTime() - CHANCE_WINDOW_DAYS * 86_400_000);
    const [shows, spend, history] = await Promise.all([
      this.prisma.eflAdShow.findMany({ where: { listingId: { in: ids }, viewerKey, day } }),
      this.prisma.eflAdTap.groupBy({
        by: ["listingId"],
        where: { listingId: { in: ids }, createdAt: { gte: weekStart } },
        _sum: { cost: true },
      }),
      this.prisma.eflAdTap.groupBy({
        by: ["listingId"],
        where: { listingId: { in: ids }, createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);
    const converted = await this.prisma.eflAdTap.groupBy({
      by: ["listingId"],
      where: { listingId: { in: ids }, createdAt: { gte: since }, orderId: { not: null } },
      _count: { _all: true },
    });
    const showsBy = new Map(shows.map((s) => [s.listingId, s.count]));
    const spentBy = new Map(spend.map((s) => [s.listingId, Number(s._sum.cost ?? 0)]));
    const tapsBy = new Map(history.map((h) => [h.listingId, h._count._all]));
    const ordersBy = new Map(converted.map((h) => [h.listingId, h._count._all]));
    const fraction = weekFraction(now);

    const winners = runAuction(
      campaigns
        .filter((c) => (showsBy.get(c.listingId) ?? 0) < MAX_SHOWS_PER_DAY)
        .map((c) => ({
          listingId: c.listingId,
          bid: Number(c.maxBid),
          chance: predictedOrderChance(tapsBy.get(c.listingId) ?? 0, ordersBy.get(c.listingId) ?? 0),
          budgetLeft: pacedBudgetLeft(Number(c.weeklyBudget), spentBy.get(c.listingId) ?? 0, fraction),
        })),
    );

    for (const w of winners) {
      placed.set(w.listingId, { price: w.price, token: sign({ l: w.listingId, p: w.price, v: viewerKey, t: now.getTime() }) });
      await this.prisma.eflAdShow
        .upsert({
          where: { listingId_viewerKey_day: { listingId: w.listingId, viewerKey, day } },
          create: { listingId: w.listingId, viewerKey, day, count: 1 },
          update: { count: { increment: 1 } },
        })
        .catch((e) => this.logger.warn(`Ad show not counted: ${(e as Error).message}`));
    }
    return placed;
  }

  /**
   * A tap on a sponsored shop. Charged at the auction's price, once per
   * viewer per shop per TAP_DEDUPE_MINUTES, and never past the budget.
   */
  async tap(token: string, viewerKey: string, now = new Date()): Promise<{ charged: boolean }> {
    const claim = verify(token);
    if (!claim || claim.v !== viewerKey || now.getTime() - claim.t > TOKEN_TTL_MS) return { charged: false };

    const recent = await this.prisma.eflAdTap.findFirst({
      where: {
        listingId: claim.l,
        viewerKey,
        createdAt: { gte: new Date(now.getTime() - TAP_DEDUPE_MINUTES * 60_000) },
      },
      select: { id: true },
    });
    if (recent) return { charged: false };

    const campaign = await this.prisma.eflAdCampaign.findUnique({ where: { listingId: claim.l } });
    if (!campaign?.active || campaign.pausedByAdmin) return { charged: false };
    const spent = await this.spentSince(claim.l, londonWeekStart(now));
    if (spent + claim.p > Number(campaign.weeklyBudget)) return { charged: false };

    await this.prisma.eflAdTap.create({ data: { listingId: claim.l, viewerKey, cost: claim.p } });
    return { charged: true };
  }

  /** Credit an order to the sponsored tap that brought it. */
  async attributeOrder(input: { listingId: string; viewerKeys: string[]; orderId: string }, now = new Date()) {
    const tap = await this.prisma.eflAdTap.findFirst({
      where: {
        listingId: input.listingId,
        viewerKey: { in: input.viewerKeys },
        orderId: null,
        createdAt: { gte: new Date(now.getTime() - ATTRIBUTION_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (tap) await this.prisma.eflAdTap.update({ where: { id: tap.id }, data: { orderId: input.orderId } });
  }

  // ── What a shop owes, and taking it back ──────────────────────────────

  /** Ad spend not yet recovered from orders, in pence. */
  async owedPence(listingId: string, locationId: string, now = new Date()): Promise<number> {
    const [taps, recovered] = await Promise.all([
      this.prisma.eflAdTap.aggregate({ where: { listingId }, _sum: { cost: true } }),
      this.prisma.order.aggregate({
        where: {
          locationId,
          orderSource: "EAT_FOR_LESS",
          eflAdRecovered: { gt: 0 },
          OR: [
            { paymentStatus: { in: PAID as any } },
            // Not paid yet, but may be: hold it, or two baskets in flight
            // would both pay off the same balance.
            { paymentStatus: "PENDING" as any, createdAt: { gte: new Date(now.getTime() - PENDING_RESERVE_MS) } },
          ],
        },
        _sum: { eflAdRecovered: true },
      }),
    ]);
    const owed = Number(taps._sum.cost ?? 0) - Number(recovered._sum.eflAdRecovered ?? 0);
    return Math.max(0, Math.round(owed * 100));
  }

  /** Pounds to recover on a new order with this much food. */
  async recoveryForOrder(listingId: string, locationId: string, foodPounds: number): Promise<number> {
    const owed = await this.owedPence(listingId, locationId);
    return adRecoveryPence(owed, Math.round(foodPounds * 100)) / 100;
  }

  // ── The shop's own settings (OrderHub) ────────────────────────────────

  async campaignForLocation(locationId: string, now = new Date()) {
    const listing = await this.prisma.eflListing.findUnique({
      where: { locationId },
      select: { id: true, adCampaign: true },
    });
    if (!listing) throw new NotFoundException("This shop isn't on Eat For Less");
    return {
      campaign: listing.adCampaign ? campaignDto(listing.adCampaign) : null,
      thisWeek: await this.weekStats(listing.id, londonWeekStart(now)),
      owed: (await this.owedPence(listing.id, locationId, now)) / 100,
    };
  }

  async saveCampaign(locationId: string, input: { active?: boolean; weeklyBudget?: number; maxBid?: number }) {
    const listing = await this.prisma.eflListing.findUnique({
      where: { locationId },
      select: { id: true, adCampaign: true },
    });
    if (!listing) throw new NotFoundException("This shop isn't on Eat For Less");
    const current = listing.adCampaign;
    const weeklyBudget = input.weeklyBudget ?? (current ? Number(current.weeklyBudget) : 25);
    const maxBid = input.maxBid ?? (current ? Number(current.maxBid) : 0.5);
    const problem = validateCampaign({ weeklyBudget, maxBid });
    if (problem) throw new BadRequestException(problem);
    const active = input.active ?? current?.active ?? false;
    if (active && current?.pausedByAdmin) {
      throw new ForbiddenException("Eat For Less has paused your ads. Contact partner@eatforless.co.uk.");
    }
    const saved = await this.prisma.eflAdCampaign.upsert({
      where: { listingId: listing.id },
      create: { listingId: listing.id, active, weeklyBudget, maxBid },
      update: { active, weeklyBudget, maxBid },
    });
    return campaignDto(saved);
  }

  // ── Numbers ───────────────────────────────────────────────────────────

  async weekStats(listingId: string, weekStart: Date) {
    const end = nextWeekStart(weekStart);
    const [shows, taps, orders] = await Promise.all([
      this.prisma.eflAdShow.aggregate({
        where: { listingId, day: { gte: londonDateKey(weekStart), lt: londonDateKey(end) } },
        _sum: { count: true },
      }),
      this.prisma.eflAdTap.aggregate({
        where: { listingId, createdAt: { gte: weekStart, lt: end } },
        _count: { _all: true },
        _sum: { cost: true },
      }),
      this.prisma.eflAdTap.count({ where: { listingId, createdAt: { gte: weekStart, lt: end }, orderId: { not: null } } }),
    ]);
    return {
      shows: shows._sum.count ?? 0,
      taps: taps._count._all,
      spent: Math.round(Number(taps._sum.cost ?? 0) * 100) / 100,
      orders: orders,
    };
  }

  private async spentSince(listingId: string, since: Date) {
    const r = await this.prisma.eflAdTap.aggregate({ where: { listingId, createdAt: { gte: since } }, _sum: { cost: true } });
    return Number(r._sum.cost ?? 0);
  }

  // ── Console ───────────────────────────────────────────────────────────

  async adminCampaigns(now = new Date()) {
    const weekStart = londonWeekStart(now);
    const rows = await this.prisma.eflAdCampaign.findMany({
      include: { listing: { select: { id: true, locationId: true, location: { select: { name: true, city: true, brand: { select: { name: true } } } } } } },
      orderBy: { updatedAt: "desc" },
    });
    return Promise.all(
      rows.map(async (c) => ({
        ...campaignDto(c),
        listingId: c.listingId,
        shopName: c.listing.location?.brand?.name ?? c.listing.location?.name ?? null,
        town: c.listing.location?.city ?? null,
        thisWeek: await this.weekStats(c.listingId, weekStart),
        owed: (await this.owedPence(c.listingId, c.listing.locationId, now)) / 100,
      })),
    );
  }

  async adminPause(listingId: string, paused: boolean) {
    const row = await this.prisma.eflAdCampaign.findUnique({ where: { listingId } });
    if (!row) throw new NotFoundException("No ads for this shop");
    return campaignDto(
      await this.prisma.eflAdCampaign.update({
        where: { listingId },
        data: { pausedByAdmin: paused, ...(paused ? { active: false } : {}) },
      }),
    );
  }
}

function campaignDto(c: { active: boolean; weeklyBudget: unknown; maxBid: unknown; pausedByAdmin: boolean }) {
  return {
    active: c.active,
    weeklyBudget: Number(c.weeklyBudget),
    maxBid: Number(c.maxBid),
    pausedByAdmin: c.pausedByAdmin,
  };
}

// ── Signed places: the price a tap is charged is the one the auction set ──

type Claim = { l: string; p: number; v: string; t: number };

function secret(): string {
  return process.env.JWT_SECRET ?? "efl-dev-ads";
}

function sign(claim: Claim): string {
  const body = Buffer.from(JSON.stringify(claim)).toString("base64url");
  const mac = createHmac("sha256", `${secret()}:efl-ads`).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify(token: string): Claim | null {
  const [body, mac] = String(token ?? "").split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", `${secret()}:efl-ads`).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const claim = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claim;
    return typeof claim.l === "string" && typeof claim.p === "number" && typeof claim.v === "string" ? claim : null;
  } catch {
    return null;
  }
}
