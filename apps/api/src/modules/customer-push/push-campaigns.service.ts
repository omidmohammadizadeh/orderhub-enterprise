import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CustomerPushService } from "./customer-push.service";
import {
  BODY_MAX,
  DEFAULT_MESSAGES,
  DEFAULT_REVIEW_DELAY_MINUTES,
  PUSH_TRIGGERS,
  REVIEW_DELAY_RANGE,
  REVIEW_TRIGGER,
  TITLE_MAX,
  isEnabled,
  isPushTrigger,
  resolveMessage,
  reviewDelayMinutes,
  storefrontRootFrom,
} from "./push-messages";

// The restaurant's side of push: what the dashboard reads and writes, and the
// two crons that send things later — campaigns at their scheduled time, and
// the review ask some minutes after an order completes.
//
// Both crons claim work with a compare-and-set on status, so two API instances
// ticking together never send the same thing twice. A claim whose instance
// died is NOT retried: a push that might already have gone out is better lost
// than doubled, because a doubled marketing push is how an app gets deleted.

/** A claim older than this belonged to a tick that died. */
const STALE_MS = 15 * 60_000;
/** Review asks sent per tick. Each one is a few queries and one push. */
const REVIEW_BATCH = 50;
/** Subscriptions read per page when sending a campaign. */
const AUDIENCE_PAGE = 500;
/** An order completed longer ago than this is not worth asking about — a
 *  backlog after an outage should not wake people about last week's dinner. */
const REVIEW_MAX_AGE_MS = 24 * 3_600_000;

export type CampaignInput = {
  title: string;
  body: string;
  locationId?: string | null;
  brandId?: string | null;
};

@Injectable()
export class PushCampaignsService {
  private readonly logger = new Logger(PushCampaignsService.name);
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: CustomerPushService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  // ── Dashboard reads ───────────────────────────────────────────────────────

  /** Everything the page needs on first paint. */
  async overview(tenantId: string) {
    const [brands, locations, byKind, optedIn, reviewsAsked] = await Promise.all([
      this.db().brand.findMany({
        where: { tenantId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      this.db().location.findMany({
        where: { brand: { tenantId } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      this.db().customerPushSubscription.groupBy({
        by: ["kind"],
        where: { tenantId, isActive: true },
        _count: { _all: true },
      }),
      this.db().customerPushSubscription.count({
        where: { tenantId, isActive: true, marketingOptIn: true },
      }),
      this.db().pushReviewRequest.count({
        where: { tenantId, status: "SENT", sentAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      }),
    ]);
    const count = (kind: string) =>
      byKind.find((r: any) => r.kind === kind)?._count?._all ?? 0;
    return {
      webConfigured: this.push.configured(),
      subscribers: { browsers: count("WEB"), apps: count("EXPO"), offers: optedIn },
      reviewsAskedLast30Days: reviewsAsked,
      brands,
      locations,
    };
  }

  /** Every trigger, with the restaurant's settings merged over the defaults so
   *  the page never has to know what the defaults are. */
  async listAutomations(tenantId: string) {
    const rows = await this.push.automationsFor(tenantId);
    return PUSH_TRIGGERS.map((trigger) => {
      const row = rows.get(trigger) ?? null;
      return {
        trigger,
        enabled: isEnabled(trigger, row),
        title: row?.title ?? null,
        body: row?.body ?? null,
        defaultTitle: DEFAULT_MESSAGES[trigger].title,
        defaultBody: DEFAULT_MESSAGES[trigger].body,
        delayMinutes: trigger === REVIEW_TRIGGER ? reviewDelayMinutes(row) : null,
        preview: resolveMessage({
          trigger,
          row: row ? { ...row, enabled: true } : null,
          orderRef: "#1042",
          shopName: "Your shop",
        }),
      };
    });
  }

  async saveAutomation(
    tenantId: string,
    trigger: string,
    input: { enabled?: boolean; title?: string | null; body?: string | null; delayMinutes?: number | null },
  ) {
    if (!isPushTrigger(trigger)) throw new BadRequestException("Unknown notification");
    const title = this.cleanText(input.title, TITLE_MAX, "Title");
    const body = this.cleanText(input.body, BODY_MAX, "Message");
    let delayMinutes: number | null = null;
    if (trigger === REVIEW_TRIGGER) {
      const raw = input.delayMinutes ?? DEFAULT_REVIEW_DELAY_MINUTES;
      if (!Number.isFinite(raw) || raw < REVIEW_DELAY_RANGE.min || raw > REVIEW_DELAY_RANGE.max) {
        throw new BadRequestException(
          `Send the review request between ${REVIEW_DELAY_RANGE.min} minutes and 24 hours after the order completes`,
        );
      }
      delayMinutes = Math.round(raw);
    }
    const data = {
      enabled: input.enabled ?? true,
      title,
      body,
      delayMinutes,
    };
    await this.db().pushAutomation.upsert({
      where: { tenantId_trigger: { tenantId, trigger } },
      create: { tenantId, trigger, ...data },
      update: data,
    });
    return this.listAutomations(tenantId);
  }

  /** Blank means "use the default"; too long is an error, not a silent cut. */
  private cleanText(raw: string | null | undefined, max: number, label: string): string | null {
    const text = raw?.trim() ?? "";
    if (!text) return null;
    if (text.length > max) throw new BadRequestException(`${label} must be ${max} characters or fewer`);
    return text;
  }

  // ── Campaigns ─────────────────────────────────────────────────────────────

  async listCampaigns(tenantId: string) {
    return this.db().pushCampaign.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  /** How many phones a campaign with this targeting would reach right now. */
  async audienceCount(tenantId: string, target: { locationId?: string | null; brandId?: string | null }) {
    const where = await this.audienceWhere(tenantId, target);
    const [browsers, apps] = await Promise.all([
      this.db().customerPushSubscription.count({ where: { ...where, kind: "WEB" } }),
      this.db().customerPushSubscription.count({ where: { ...where, kind: "EXPO" } }),
    ]);
    return { total: browsers + apps, browsers, apps };
  }

  async createCampaign(tenantId: string, userId: string | undefined, input: CampaignInput) {
    const data = await this.validCampaign(tenantId, input);
    return this.db().pushCampaign.create({
      data: { tenantId, ...data, status: "DRAFT", createdBy: userId ?? null },
    });
  }

  async updateCampaign(tenantId: string, id: string, input: CampaignInput) {
    const campaign = await this.ownCampaign(tenantId, id);
    if (campaign.status !== "DRAFT" && campaign.status !== "SCHEDULED") {
      throw new BadRequestException("This campaign has already been sent");
    }
    const data = await this.validCampaign(tenantId, input);
    return this.db().pushCampaign.update({ where: { id }, data });
  }

  /** Send now (no date) or at a time. Either way the cron does the sending, so
   *  there is exactly one path that can push to customers. */
  async scheduleCampaign(tenantId: string, id: string, scheduledFor?: string | null) {
    const campaign = await this.ownCampaign(tenantId, id);
    if (campaign.status !== "DRAFT" && campaign.status !== "SCHEDULED") {
      throw new BadRequestException("This campaign has already been sent");
    }
    let when = new Date();
    if (scheduledFor) {
      when = new Date(scheduledFor);
      if (Number.isNaN(when.getTime())) throw new BadRequestException("That date isn't valid");
      if (when.getTime() < Date.now() - 60_000) throw new BadRequestException("Pick a time in the future");
      if (when.getTime() > Date.now() + 60 * 86_400_000) {
        throw new BadRequestException("Campaigns can be scheduled up to 60 days ahead");
      }
    }
    const audience = await this.audienceCount(tenantId, campaign);
    if (audience.total === 0) {
      throw new BadRequestException("Nobody has said yes to offers from this shop yet, so there is no one to send to");
    }
    // Compare-and-set on status: a double-clicked Send must not move a
    // campaign the cron has already claimed back to SCHEDULED.
    const moved = await this.db().pushCampaign.updateMany({
      where: { id, tenantId, status: { in: ["DRAFT", "SCHEDULED"] } },
      data: { status: "SCHEDULED", scheduledFor: when },
    });
    if (!moved.count) throw new BadRequestException("This campaign has already been sent");
    return this.ownCampaign(tenantId, id);
  }

  async cancelCampaign(tenantId: string, id: string) {
    await this.ownCampaign(tenantId, id);
    const moved = await this.db().pushCampaign.updateMany({
      where: { id, tenantId, status: "SCHEDULED" },
      data: { status: "DRAFT", scheduledFor: null },
    });
    if (!moved.count) throw new BadRequestException("Only a scheduled campaign can be cancelled");
    return this.ownCampaign(tenantId, id);
  }

  async deleteCampaign(tenantId: string, id: string) {
    const gone = await this.db().pushCampaign.deleteMany({ where: { id, tenantId, status: "DRAFT" } });
    if (!gone.count) throw new BadRequestException("Only a draft can be deleted");
    return { ok: true };
  }

  private async ownCampaign(tenantId: string, id: string) {
    const campaign = await this.db().pushCampaign.findFirst({ where: { id, tenantId } });
    if (!campaign) throw new NotFoundException("Campaign not found");
    return campaign;
  }

  private async validCampaign(tenantId: string, input: CampaignInput) {
    const title = this.cleanText(input.title, TITLE_MAX, "Title");
    const body = this.cleanText(input.body, BODY_MAX, "Message");
    if (!title || !body) throw new BadRequestException("A campaign needs a title and a message");
    const target = await this.ownTarget(tenantId, input);
    return { title, body, ...target };
  }

  /** A location or brand from another tenant would aim this tenant's campaign
   *  at someone else's customers. Location has no tenantId — it's on Brand. */
  private async ownTarget(tenantId: string, input: { locationId?: string | null; brandId?: string | null }) {
    let locationId: string | null = null;
    let brandId: string | null = null;
    if (input.locationId) {
      const loc = await this.db().location.findFirst({
        where: { id: input.locationId, brand: { tenantId } },
        select: { id: true },
      });
      if (!loc) throw new BadRequestException("Shop not found");
      locationId = loc.id;
    }
    if (input.brandId) {
      const brand = await this.db().brand.findFirst({
        where: { id: input.brandId, tenantId },
        select: { id: true },
      });
      if (!brand) throw new BadRequestException("Brand not found");
      brandId = brand.id;
    }
    return { locationId, brandId };
  }

  private async audienceWhere(tenantId: string, target: { locationId?: string | null; brandId?: string | null }) {
    const { locationId, brandId } = await this.ownTarget(tenantId, target);
    return {
      tenantId,
      isActive: true,
      marketingOptIn: true,
      ...(locationId ? { locationId } : {}),
      ...(brandId ? { brandId } : {}),
    };
  }

  // ── Crons ─────────────────────────────────────────────────────────────────

  @Cron("*/30 * * * * *")
  async tick(): Promise<void> {
    // One tick at a time per instance; other instances are kept off by the
    // status claims below.
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.expireStaleClaims();
      await this.sendDueCampaigns();
      await this.sendDueReviewRequests();
    } catch (e: any) {
      this.logger.error(`push tick failed: ${e?.message ?? e}`);
    } finally {
      this.ticking = false;
    }
  }

  private async expireStaleClaims() {
    const cutoff = new Date(Date.now() - STALE_MS);
    await this.db().pushCampaign.updateMany({
      where: { status: "SENDING", startedAt: { lt: cutoff } },
      data: { status: "FAILED" },
    });
    await this.db().pushReviewRequest.updateMany({
      where: { status: "SENDING", claimedAt: { lt: cutoff } },
      data: { status: "SKIPPED" },
    });
  }

  private async sendDueCampaigns() {
    const due = await this.db().pushCampaign.findMany({
      where: { status: "SCHEDULED", scheduledFor: { lte: new Date() } },
      orderBy: { scheduledFor: "asc" },
      take: 5,
    });
    for (const campaign of due) {
      const claimed = await this.db().pushCampaign.updateMany({
        where: { id: campaign.id, status: "SCHEDULED" },
        data: { status: "SENDING", startedAt: new Date() },
      });
      if (!claimed.count) continue;
      await this.sendCampaign(campaign);
    }
  }

  /** Page through the audience by id so a big list never sits in memory and
   *  a phone that subscribes mid-send can't be counted twice. */
  async sendCampaign(campaign: any): Promise<void> {
    let targeted = 0;
    let delivered = 0;
    try {
      const where = {
        tenantId: campaign.tenantId,
        isActive: true,
        marketingOptIn: true,
        ...(campaign.locationId ? { locationId: campaign.locationId } : {}),
        ...(campaign.brandId ? { brandId: campaign.brandId } : {}),
      };
      const branding = await this.push.brandingFor({
        brandId: campaign.brandId,
        locationId: campaign.locationId,
      });
      let cursor: string | null = null;
      for (;;) {
        const page: any[] = await this.db().customerPushSubscription.findMany({
          where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: "asc" },
          take: AUDIENCE_PAGE,
          include: { orders: { orderBy: { createdAt: "desc" }, take: 1, select: { trackPath: true } } },
        });
        if (!page.length) break;
        cursor = page[page.length - 1].id;
        targeted += page.length;
        const result = await this.push.sendTo(page, {
          title: campaign.title,
          body: campaign.body,
          icon: branding.icon,
          tag: `campaign-${campaign.id}`,
          data: { campaignId: campaign.id },
          // Back to the storefront this phone ordered from. An app install
          // with no order yet gets no url and opens on its home screen.
          urlFor: (sub) => storefrontRootFrom(sub.orders?.[0]?.trackPath),
        });
        delivered += result.delivered;
        // Progress is visible while a big send is still running.
        await this.db().pushCampaign.update({
          where: { id: campaign.id },
          data: { targeted, delivered, failed: targeted - delivered, startedAt: new Date() },
        });
      }
      await this.db().pushCampaign.update({
        where: { id: campaign.id },
        data: { status: "SENT", sentAt: new Date(), targeted, delivered, failed: targeted - delivered },
      });
      this.logger.log(`push campaign ${campaign.id} sent ${delivered}/${targeted}`);
    } catch (e: any) {
      this.logger.error(`push campaign ${campaign.id} failed: ${e?.message ?? e}`);
      await this.db()
        .pushCampaign.update({
          where: { id: campaign.id },
          data: { status: "FAILED", targeted, delivered, failed: targeted - delivered },
        })
        .catch(() => undefined);
    }
  }

  private async sendDueReviewRequests() {
    const due = await this.db().pushReviewRequest.findMany({
      where: { status: "PENDING", dueAt: { lte: new Date() } },
      orderBy: { dueAt: "asc" },
      take: REVIEW_BATCH,
    });
    for (const request of due) {
      const claimed = await this.db().pushReviewRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: { status: "SENDING", claimedAt: new Date() },
      });
      if (!claimed.count) continue;
      const sent = await this.sendReviewRequest(request).catch((e: any) => {
        this.logger.warn(`review push ${request.orderId} failed: ${e?.message ?? e}`);
        return false;
      });
      await this.db().pushReviewRequest.update({
        where: { id: request.id },
        data: sent ? { status: "SENT", sentAt: new Date() } : { status: "SKIPPED" },
      });
    }
  }

  /**
   * Ask, unless something changed while we waited: the restaurant switched the
   * ask off, the order was refunded back out of COMPLETED, the customer already
   * left a review, or the backlog is so old the ask would be strange.
   */
  async sendReviewRequest(request: { tenantId: string; orderId: string; dueAt: Date }): Promise<boolean> {
    if (Date.now() - new Date(request.dueAt).getTime() > REVIEW_MAX_AGE_MS) return false;

    const automations = await this.push.automationsFor(request.tenantId);
    const row = automations.get(REVIEW_TRIGGER);
    if (!isEnabled(REVIEW_TRIGGER, row)) return false;

    const [order, existing] = await Promise.all([
      this.db().order.findUnique({ where: { id: request.orderId }, select: { status: true } }),
      this.db().review.findUnique({ where: { orderId: request.orderId }, select: { id: true } }),
    ]);
    if (!order || order.status !== "COMPLETED" || existing) return false;

    const links = await this.db().customerPushOrder.findMany({
      where: { orderId: request.orderId, subscription: { isActive: true } },
      include: { subscription: true },
    });
    if (!links.length) return false;

    const branding = await this.push.brandingFor(links[0].subscription);
    const message = resolveMessage({ trigger: REVIEW_TRIGGER, row, shopName: branding.name });
    if (!message) return false;

    // The tracking page opens its review form when it sees ?review=1.
    const trackPath: string | null = links.find((l: any) => l.trackPath)?.trackPath ?? null;
    const url = trackPath ? `${trackPath}${trackPath.includes("?") ? "&" : "?"}review=1` : null;
    const result = await this.push.sendTo(
      links.map((l: any) => l.subscription),
      {
        ...message,
        icon: branding.icon,
        tag: `order-${request.orderId}`,
        data: { orderId: request.orderId, review: true },
        urlFor: () => url,
      },
    );
    return result.delivered > 0;
  }
}
