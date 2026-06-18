// Phase AW-19 — Marketing campaign service.
//
// CRUD over MarketingCampaign rows, tenant-scoped via brand FK. Type-
// specific validation enforces the cross-field rules (e.g. a
// PERCENTAGE_OFF campaign must have percentageOff set, a HAPPY_HOUR
// campaign must have daily start/end times).
//
// Storefront + POS read ACTIVE rows via resolveActiveForBrandChannel
// at order time — that path will get richer in AW-19-D when the
// audience evaluator lands.

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import type {
  CreateCampaignDto,
  UpdateCampaignDto,
  CampaignTypeValue,
  CampaignAudienceValue,
} from "./dto/campaign.dto";

@Injectable()
export class MarketingService {
  private readonly logger = new Logger(MarketingService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Reads ─────────────────────────────────────────────────────────

  /**
   * List every campaign in the tenant. When brandId is provided, scope
   * to that brand. Operators see drafts + active + paused + ended;
   * filtering is a UI concern.
   */
  async list(args: { tenantId: string; brandId?: string }) {
    return (this.prisma as any).marketingCampaign.findMany({
      where: {
        tenantId: args.tenantId,
        ...(args.brandId && { brandId: args.brandId }),
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });
  }

  async findOne(id: string, tenantId: string) {
    const row = await (this.prisma as any).marketingCampaign.findFirst({
      where: { id, tenantId },
    });
    if (!row) throw new NotFoundException(`Campaign ${id} not found`);
    return row;
  }

  /**
   * Resolve the campaigns currently eligible for this brand × channel.
   * Returns ACTIVE rows whose window covers now() and (when set)
   * whose daily start/end window covers the local time. Audience
   * matching is done by the caller because it needs the customer
   * context (see resolveAudience below).
   */
  async resolveActiveForBrandChannel(brandId: string, channel: string) {
    const now = new Date();
    const rows = await (this.prisma as any).marketingCampaign.findMany({
      where: {
        brandId,
        status: "ACTIVE",
        channels: { has: channel },
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [
          {
            OR: [{ endsAt: null }, { endsAt: { gt: now } }],
          },
        ],
      },
    });
    // Daily window filter (HAPPY_HOUR + any percentage-off campaign
    // with explicit dailyStart/End). Time is HH:MM local — the brand
    // doesn't carry a tz column yet, so we use the server's locale.
    // Phase AW-20 will replace this with brand-tz aware evaluation.
    return rows.filter((r: any) => this.matchesDailyWindow(r, now));
  }

  // ─── Writes ────────────────────────────────────────────────────────

  async create(args: {
    tenantId: string;
    userId?: string;
    dto: CreateCampaignDto;
  }) {
    await this.assertBrandAccess(args.dto.brandId, args.tenantId);
    this.assertTypeFields(args.dto.type, args.dto);
    const created = await (this.prisma as any).marketingCampaign.create({
      data: {
        tenantId: args.tenantId,
        brandId: args.dto.brandId,
        name: args.dto.name,
        description: args.dto.description ?? null,
        type: args.dto.type as any,
        status: (args.dto.status ?? "DRAFT") as any,
        audience: (args.dto.audience ?? "ALL") as any,
        channels: args.dto.channels ?? [],
        percentageOff: args.dto.percentageOff ?? null,
        amountOff: args.dto.amountOff ?? null,
        minOrder: args.dto.minOrder ?? null,
        freeItemId: args.dto.freeItemId ?? null,
        itemIds: args.dto.itemIds ?? [],
        dailyStartTime: args.dto.dailyStartTime ?? null,
        dailyEndTime: args.dto.dailyEndTime ?? null,
        startsAt: args.dto.startsAt ? new Date(args.dto.startsAt) : null,
        endsAt: args.dto.endsAt ? new Date(args.dto.endsAt) : null,
        maxRedemptions: args.dto.maxRedemptions ?? null,
        perCustomerLimit: args.dto.perCustomerLimit ?? null,
        // Phase AW-19 — extra structured fields ride on metadata so
        // we don't need a schema column for each campaign type:
        //   - rewardItemIds: BOGO (legacy single-reward model)
        //   - excludedCategoryIds: FREE_ITEM (drop these from the
        //     threshold calc so meal deals etc. don't unlock the gift)
        metadata: {
          ...(args.dto.rewardItemIds?.length
            ? { rewardItemIds: args.dto.rewardItemIds }
            : {}),
          ...(args.dto.excludedCategoryIds?.length
            ? { excludedCategoryIds: args.dto.excludedCategoryIds }
            : {}),
        },
        createdBy: args.userId ?? null,
      },
    });
    this.logger.log(
      `Campaign created: id=${created.id} type=${created.type} brandId=${created.brandId} channels=[${created.channels.join(",")}]`,
    );
    return created;
  }

  async update(id: string, tenantId: string, dto: UpdateCampaignDto) {
    const row = await this.findOne(id, tenantId);
    if (dto.status === "ACTIVE") {
      // Re-run type validation before going live — the operator may
      // have created a row as DRAFT with a missing field.
      this.assertTypeFields(row.type, { ...row, ...dto });
    }
    return (this.prisma as any).marketingCampaign.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.status && { status: dto.status as any }),
        ...(dto.audience && { audience: dto.audience as any }),
        ...(dto.channels && { channels: dto.channels }),
        ...(dto.percentageOff !== undefined && { percentageOff: dto.percentageOff }),
        ...(dto.amountOff !== undefined && { amountOff: dto.amountOff }),
        ...(dto.minOrder !== undefined && { minOrder: dto.minOrder }),
        ...(dto.freeItemId !== undefined && { freeItemId: dto.freeItemId }),
        ...(dto.itemIds && { itemIds: dto.itemIds }),
        ...(dto.dailyStartTime !== undefined && { dailyStartTime: dto.dailyStartTime }),
        ...(dto.dailyEndTime !== undefined && { dailyEndTime: dto.dailyEndTime }),
        ...(dto.startsAt !== undefined && {
          startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
        }),
        ...(dto.endsAt !== undefined && {
          endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
        }),
        ...(dto.maxRedemptions !== undefined && { maxRedemptions: dto.maxRedemptions }),
        ...(dto.perCustomerLimit !== undefined && { perCustomerLimit: dto.perCustomerLimit }),
      },
    });
  }

  async remove(id: string, tenantId: string) {
    await this.findOne(id, tenantId);
    await (this.prisma as any).marketingCampaign.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Audience resolver (used by AW-19-D, exposed here so the POS
  //     picker can preview which campaigns would apply too) ──────────

  /**
   * Bucket the customer into NEW / RETURNING / LAPSED / ALL based on
   * their CustomerAccount.totalOrders and most-recent order date.
   *
   *   NEW       — totalOrders === 0 (or the customer has no account)
   *   RETURNING — at least one order in the last 90 days
   *   LAPSED    — last order > 45 days ago
   *   ALL       — always (default; storefront resolves this for guests)
   *
   * A campaign with audience=ALL matches every bucket.
   */
  async resolveAudience(args: {
    tenantId: string;
    customerAccountId?: string | null;
  }): Promise<CampaignAudienceValue> {
    if (!args.customerAccountId) return "NEW";
    const account = await (this.prisma as any).customerAccount.findFirst({
      where: { id: args.customerAccountId, tenantId: args.tenantId },
      select: { totalOrders: true },
    });
    if (!account || account.totalOrders === 0) return "NEW";

    // Last completed order timestamp.
    const lastOrder = await (this.prisma as any).order.findFirst({
      where: { customerAccountId: args.customerAccountId, tenantId: args.tenantId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (!lastOrder) return "NEW";
    const now = Date.now();
    const ageMs = now - lastOrder.createdAt.getTime();
    const days = ageMs / (1000 * 60 * 60 * 24);
    if (days > 45) return "LAPSED";
    return "RETURNING";
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private async assertBrandAccess(brandId: string, tenantId: string) {
    const brand = await (this.prisma as any).brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException("Brand not found");
  }

  /**
   * Phase AW-19 — per-item promo map for PERCENT_OFF_ITEMS campaigns.
   *
   * Walks all ACTIVE in-window PERCENT_OFF_ITEMS rows for the brand
   * on the ONLINE channel and returns a Map keyed by itemId with the
   * winning percentageOff (highest if multiple campaigns name the
   * same item). Storefront uses this to decorate menu cards with a
   * strikethrough price + percent badge.
   */
  async resolveItemPromos(
    brandId: string,
    audiences: Array<"ALL" | "NEW" | "RETURNING" | "LAPSED">,
  ): Promise<
    Record<string, { percentageOff: number; campaignId: string; campaignName: string }>
  > {
    const rows = await this.resolveActiveForBrandChannel(brandId, "ONLINE");
    const out: Record<
      string,
      { percentageOff: number; campaignId: string; campaignName: string }
    > = {};
    for (const r of rows as any[]) {
      if (r.type !== "PERCENT_OFF_ITEMS") continue;
      if (!audiences.includes(r.audience)) continue;
      if (r.percentageOff == null) continue;
      const pct = Number(r.percentageOff);
      for (const itemId of (r.itemIds ?? []) as string[]) {
        const existing = out[itemId];
        if (!existing || pct > existing.percentageOff) {
          out[itemId] = {
            percentageOff: pct,
            campaignId: r.id,
            campaignName: r.name,
          };
        }
      }
    }
    return out;
  }

  /**
   * Phase AW-19 — pick the active BOGO campaign for storefront.
   * Returns null when nothing matches. We only honour one BOGO at
   * a time on the storefront — if the operator publishes more than
   * one we take the most-recently-updated row.
   */
  async resolveBogo(
    brandId: string,
    audiences: Array<"ALL" | "NEW" | "RETURNING" | "LAPSED">,
  ): Promise<{
    campaignId: string;
    campaignName: string;
    triggerItemIds: string[];
  } | null> {
    const rows = await this.resolveActiveForBrandChannel(brandId, "ONLINE");
    const bogo = (rows as any[])
      .filter(
        (r) =>
          r.type === "BOGO" &&
          audiences.includes(r.audience) &&
          (r.itemIds?.length ?? 0) > 0,
      )
      .sort(
        (a, b) =>
          new Date(b.updatedAt ?? 0).getTime() -
          new Date(a.updatedAt ?? 0).getTime(),
      )[0];
    if (!bogo) return null;
    return {
      campaignId: bogo.id,
      campaignName: bogo.name,
      triggerItemIds: bogo.itemIds ?? [],
    };
  }

  /**
   * Phase AW-19 — pick the active FREE_ITEM campaign for storefront.
   * Returns the gift threshold + the pool of items the customer can
   * pick from + categories that don't count toward the threshold.
   * Only one active FREE_ITEM is surfaced at a time — operator can
   * pause others; ties broken by most-recently-updated.
   */
  async resolveFreeItem(
    brandId: string,
    audiences: Array<"ALL" | "NEW" | "RETURNING" | "LAPSED">,
  ): Promise<{
    campaignId: string;
    campaignName: string;
    minOrder: number;
    freeItemIds: string[];
    excludedCategoryIds: string[];
  } | null> {
    const rows = await this.resolveActiveForBrandChannel(brandId, "ONLINE");
    const row = (rows as any[])
      .filter(
        (r) =>
          r.type === "FREE_ITEM" &&
          audiences.includes(r.audience) &&
          (r.itemIds?.length ?? 0) > 0 &&
          r.minOrder != null,
      )
      .sort(
        (a, b) =>
          new Date(b.updatedAt ?? 0).getTime() -
          new Date(a.updatedAt ?? 0).getTime(),
      )[0];
    if (!row) return null;
    const excludedCategoryIds: string[] = Array.isArray(
      (row.metadata as any)?.excludedCategoryIds,
    )
      ? (row.metadata as any).excludedCategoryIds
      : [];
    return {
      campaignId: row.id,
      campaignName: row.name,
      minOrder: Number(row.minOrder),
      freeItemIds: row.itemIds,
      excludedCategoryIds,
    };
  }

  private assertTypeFields(type: CampaignTypeValue, fields: any) {
    const missing: string[] = [];
    switch (type) {
      case "PERCENTAGE_OFF":
        if (fields.percentageOff == null) missing.push("percentageOff");
        break;
      case "AMOUNT_OFF_ORDER":
        if (fields.amountOff == null) missing.push("amountOff");
        break;
      case "PERCENT_OFF_ITEMS":
        if (fields.percentageOff == null) missing.push("percentageOff");
        if (!fields.itemIds?.length) missing.push("itemIds");
        break;
      case "BOGO":
        // Reward is the trigger item itself — adding any of these to
        // the cart drops a free £0 copy of the same item.
        if (!fields.itemIds?.length) missing.push("itemIds");
        break;
      case "FREE_ITEM":
        // itemIds = pool of free items the customer can claim
        // (single → auto-added; multiple → storefront picker).
        // minOrder is the spend threshold computed on the eligible
        // subtotal (after metadata.excludedCategoryIds is netted out).
        if (!fields.itemIds?.length) missing.push("itemIds");
        if (fields.minOrder == null) missing.push("minOrder");
        break;
      case "FREE_DELIVERY":
        break;
      case "HAPPY_HOUR":
        if (fields.percentageOff == null) missing.push("percentageOff");
        if (!fields.dailyStartTime) missing.push("dailyStartTime");
        if (!fields.dailyEndTime) missing.push("dailyEndTime");
        break;
    }
    if (missing.length) {
      throw new BadRequestException(
        `Campaign type ${type} requires: ${missing.join(", ")}`,
      );
    }
  }

  private matchesDailyWindow(row: any, now: Date): boolean {
    if (!row.dailyStartTime || !row.dailyEndTime) return true;
    const hhmm = (d: Date) =>
      `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const t = hhmm(now);
    // Simple lex compare works for HH:MM 24h. Handles wrap-around
    // (e.g. 22:00 → 02:00 next morning) by OR'ing the two halves.
    if (row.dailyStartTime <= row.dailyEndTime) {
      return t >= row.dailyStartTime && t < row.dailyEndTime;
    }
    return t >= row.dailyStartTime || t < row.dailyEndTime;
  }
}
