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
        // Trigger + reward items live in metadata for now.
        break;
      case "FREE_ITEM":
        if (!fields.freeItemId) missing.push("freeItemId");
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
