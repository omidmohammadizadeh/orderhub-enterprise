// Phase UE-6 — Uber Eats Marketplace Promotions (Base44-era cert item).
//
// Maps our MarketingCampaign rows onto Uber's Promotions API (partner
// OpenAPI, Promotions 1.0.0):
//
//   POST /v1/delivery/stores/{store_id}/promotion       (eats.store.promotion.write)
//   POST /v1/delivery/promotions/{promotion_id}/revoke  (write)
//   GET  /v1/delivery/promotions/{promotion_id}         (eats.store.promotion.read)
//   GET  /v1/delivery/stores/{store_id}/promotions      (read)
//
// Money here is in PENCE ({amount, currency_code} — smallest unit), NOT the
// amount_e5 format the Order API uses. Items are referenced by
// item_external_id = the merchant item id we publish in the menu payload
// (our MenuItem ids / itemId__sN size ids). external_promotion_id carries
// our campaign id so Uber-side promos are traceable back to the campaign.
//
// Lifecycle: campaign ACTIVE + channel UBER_EATS → create on every connected
// store of the brand; PAUSED/ENDED/deleted or channel removed → revoke.
// Created promotion ids live in campaign.metadata.uberEats.promotions.

import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { UberEatsClientService } from "./ubereats-client.service";

const WRITE_SCOPES = ["eats.store.promotion.write"];
const READ_SCOPES = ["eats.store.promotion.read"];

const pence = (pounds: unknown): number =>
  Math.max(0, Math.round((Number(pounds) || 0) * 100));

const DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

@Injectable()
export class UberEatsPromotionsService {
  private readonly logger = new Logger(UberEatsPromotionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: UberEatsClientService,
  ) {}

  // ── campaign → Uber promotion body ─────────────────────────────────────

  /** Build the spec-shaped create body for a campaign, or throw if unmappable. */
  buildPromotionBody(campaign: any): Record<string, unknown> {
    // Uber's runtime REQUIRES min_basket_constraint on the discount even
    // though the OpenAPI schema marks it optional (it 400s "request is
    // missing min_basket_constraint" without it). Always send it; a
    // campaign with no minimum order means min_spend = 0 (any basket).
    const minBasket = {
      min_basket_constraint: {
        min_spend: { amount: pence(campaign.minOrder) },
      },
    };
    const common = {
      external_promotion_id: campaign.id,
      user_group:
        campaign.audience === "NEW" ? "FIRST_TIME_CUSTOMER" : "ALL_CUSTOMERS",
      // Present in Uber's own create examples; include to avoid the
      // one-missing-field-at-a-time 400 cycle. allow_unlimited_apply =
      // the promo can apply on repeat orders. currency_code is GBP for our
      // UK stores (make per-store when we onboard other regions).
      allow_unlimited_apply: true,
      currency_code: "GBP",
      // Uber REQUIRES a top-level `budget` on every promotion — omitting it
      // 400s with "request is missing budget". We default to an uncapped
      // budget (no total spend limit); when the campaign carries a spend
      // cap (campaign.budget, in pounds) we send a WEEKLY periodic budget
      // in pence instead. `money.amount` is the smallest unit (pence).
      budget:
        campaign.budget != null && Number(campaign.budget) > 0
          ? {
              unlimited_budget: false,
              periodic_budget: {
                budget_amount: { amount: pence(campaign.budget) },
                budget_period: "WEEKLY",
              },
            }
          : { unlimited_budget: true },
      ...(campaign.startsAt
        ? { start_time: new Date(campaign.startsAt).toISOString() }
        : {}),
      ...(campaign.endsAt
        ? { end_time: new Date(campaign.endsAt).toISOString() }
        : {}),
    };

    switch (campaign.type) {
      case "PERCENTAGE_OFF":
      case "HAPPY_HOUR": {
        const percent = Math.round(Number(campaign.percentageOff) || 0);
        if (percent <= 0) {
          throw new BadRequestException("Campaign has no percentage set");
        }
        // Uber's percent-off examples always carry max_discount_value (the
        // £ cap on the discount), and the runtime rejects the promo without
        // it. Default to an effectively-uncapped £1000 when the campaign
        // doesn't set one; use the campaign's cap (pounds) when present.
        const maxDiscount =
          campaign.maxDiscount != null && Number(campaign.maxDiscount) > 0
            ? pence(campaign.maxDiscount)
            : 100_000;
        const body: Record<string, unknown> = {
          ...common,
          promo_type: "PERCENTOFF",
          promotion_discount: {
            percent_off_discount: {
              percent_value: percent,
              max_discount_value: { amount: maxDiscount },
              ...minBasket,
            },
          },
        };
        // Happy hour → daypart constraint from the campaign's daily window.
        if (
          campaign.type === "HAPPY_HOUR" &&
          campaign.dailyStartTime &&
          campaign.dailyEndTime
        ) {
          const [sh, sm] = String(campaign.dailyStartTime).split(":").map(Number);
          const [eh, em] = String(campaign.dailyEndTime).split(":").map(Number);
          body.promotion_customization = {
            marketing_experience_type: "HAPPY_HOUR",
            custom_schedule: {
              daypart_constraints: [
                {
                  day_of_week: DAYS,
                  hours: [
                    {
                      start_hour: sh || 0,
                      start_minute: sm || 0,
                      end_hour: eh || 0,
                      end_minute: em || 0,
                    },
                  ],
                },
              ],
            },
          };
        }
        return body;
      }
      case "AMOUNT_OFF_ORDER": {
        const amount = pence(campaign.amountOff);
        if (amount <= 0) {
          throw new BadRequestException("Campaign has no amount set");
        }
        return {
          ...common,
          promo_type: "FLATOFF",
          promotion_discount: {
            flat_off_discount: {
              discount_value: { amount },
              ...minBasket,
            },
          },
        };
      }
      case "PERCENT_OFF_ITEMS": {
        const percent = Math.round(Number(campaign.percentageOff) || 0);
        const itemIds: string[] = campaign.itemIds ?? [];
        if (percent <= 0 || itemIds.length === 0) {
          throw new BadRequestException(
            "Campaign needs a percentage and at least one item",
          );
        }
        return {
          ...common,
          promo_type: "MENU_ITEM_DISCOUNT",
          promotion_discount: {
            menu_item_discount: {
              item_discounts: itemIds.map((id) => ({
                item: { item_external_id: id },
                discount_amount: {
                  percent_discount: { percent_value: percent },
                },
              })),
            },
          },
        };
      }
      case "BOGO": {
        const meta = (campaign.metadata ?? {}) as Record<string, any>;
        const targets: string[] = [
          ...(meta.trigger_item_id ? [String(meta.trigger_item_id)] : []),
          ...(campaign.itemIds ?? []),
        ];
        if (targets.length === 0) {
          throw new BadRequestException("BOGO campaign has no target item");
        }
        return {
          ...common,
          promo_type: "BOGO",
          promotion_discount: {
            bogo_discount: {
              target_items: targets.map((id) => ({ item_external_id: id })),
            },
          },
        };
      }
      case "FREE_ITEM": {
        if (!campaign.freeItemId) {
          throw new BadRequestException("Campaign has no free item set");
        }
        return {
          ...common,
          promo_type: "FREEITEM_MINBASKET",
          promotion_discount: {
            free_item_discount: {
              ...minBasket,
              free_items: [{ free_item_id: String(campaign.freeItemId) }],
            },
          },
        };
      }
      case "FREE_DELIVERY": {
        return {
          ...common,
          promo_type: "FREEDELIVERY",
          promotion_discount: {
            free_delivery_discount: { ...minBasket },
          },
        };
      }
      default:
        throw new BadRequestException(
          `Campaign type ${campaign.type} can't be mapped to an Uber Eats promotion`,
        );
    }
  }

  // ── lifecycle sync ──────────────────────────────────────────────────────

  /**
   * Reconcile one campaign with Uber: ACTIVE + UBER_EATS channel → ensure a
   * promotion exists on every connected store of the brand; anything else →
   * revoke whatever we created earlier. Best-effort: called after campaign
   * writes, failures are logged and surfaced in campaign.metadata.uberEats.
   */
  async syncCampaign(campaignId: string): Promise<void> {
    const campaign = await (this.prisma as any).marketingCampaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign) return;

    const meta = (campaign.metadata ?? {}) as Record<string, any>;
    const existing: Array<{ storeId: string; promotionId: string }> =
      meta.uberEats?.promotions ?? [];

    const shouldBeLive =
      campaign.status === "ACTIVE" &&
      (campaign.channels ?? []).includes("UBER_EATS");

    if (!shouldBeLive) {
      if (existing.length) await this.revokeAll(campaign, existing);
      return;
    }

    const connections = await this.prisma.brandPlatformConnection.findMany({
      where: {
        brandId: campaign.brandId,
        platform: "UBER_EATS",
        status: "connected",
        externalStoreId: { not: null },
      },
      select: { externalStoreId: true },
    });
    if (connections.length === 0) {
      this.logger.warn(
        `Campaign ${campaign.id} targets UBER_EATS but the brand has no connected store`,
      );
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = this.buildPromotionBody(campaign);
    } catch (err: any) {
      this.logger.warn(
        `Campaign ${campaign.id} can't map to an Uber promotion: ${err?.message}`,
      );
      return;
    }

    const created: Array<{ storeId: string; promotionId: string }> = [];
    const errors: string[] = [];
    const already = new Set(existing.map((e) => e.storeId));
    for (const conn of connections) {
      const storeId = conn.externalStoreId!;
      if (already.has(storeId)) {
        created.push(existing.find((e) => e.storeId === storeId)!);
        continue;
      }
      try {
        const res = await this.client.request<any>(
          "POST",
          `/v1/delivery/stores/${encodeURIComponent(storeId)}/promotion`,
          { scopes: WRITE_SCOPES, body },
        );
        const promotionId =
          res?.promotion_id ?? res?.id ?? res?.promotion?.id ?? "";
        created.push({ storeId, promotionId: String(promotionId) });
        this.logger.log(
          `Uber Eats promotion created for campaign ${campaign.id} on store ${storeId}: ${promotionId}`,
        );
      } catch (err: any) {
        errors.push(`${storeId}: ${err?.message}`);
        this.logger.error(
          `Uber Eats promotion create failed (campaign ${campaign.id}, store ${storeId}): ${err?.message}`,
        );
      }
    }

    await this.writeMeta(campaign.id, meta, {
      promotions: created,
      lastSyncAt: new Date().toISOString(),
      lastError: errors.length ? errors.join("; ") : null,
    });
  }

  private async revokeAll(
    campaign: any,
    promos: Array<{ storeId: string; promotionId: string }>,
  ): Promise<void> {
    const remaining: Array<{ storeId: string; promotionId: string }> = [];
    for (const p of promos) {
      if (!p.promotionId) continue;
      try {
        await this.client.request(
          "POST",
          `/v1/delivery/promotions/${encodeURIComponent(p.promotionId)}/revoke`,
          { scopes: WRITE_SCOPES, body: {} },
        );
        this.logger.log(
          `Uber Eats promotion ${p.promotionId} revoked (campaign ${campaign.id})`,
        );
      } catch (err: any) {
        // Already revoked/expired → fine; anything else keep for retry.
        const msg = String(err?.message ?? "");
        if (!msg.includes("404") && !msg.includes("409")) {
          remaining.push(p);
          this.logger.error(
            `Uber Eats promotion revoke failed (${p.promotionId}): ${msg}`,
          );
        }
      }
    }
    await this.writeMeta(
      campaign.id,
      (campaign.metadata ?? {}) as Record<string, any>,
      {
        promotions: remaining,
        lastSyncAt: new Date().toISOString(),
        lastError: null,
      },
    );
  }

  /** Revoke everything a campaign created — used before campaign delete. */
  async revokeForCampaign(campaign: any): Promise<void> {
    const meta = (campaign?.metadata ?? {}) as Record<string, any>;
    const promos = meta.uberEats?.promotions ?? [];
    if (promos.length) await this.revokeAll(campaign, promos);
  }

  private async writeMeta(
    campaignId: string,
    meta: Record<string, any>,
    uberEats: Record<string, unknown>,
  ): Promise<void> {
    await (this.prisma as any).marketingCampaign
      .update({
        where: { id: campaignId },
        data: {
          metadata: { ...meta, uberEats: { ...(meta.uberEats ?? {}), ...uberEats } },
        },
      })
      .catch(() => {
        /* best-effort bookkeeping */
      });
  }

  // ── dashboard/verification reads ────────────────────────────────────────

  async listStorePromotions(tenantId: string, connectionId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "UBER_EATS" },
    });
    if (!conn?.externalStoreId) {
      throw new BadRequestException("Uber Eats isn't connected for this brand.");
    }
    const res = await this.client.request<any>(
      "GET",
      `/v1/delivery/stores/${encodeURIComponent(conn.externalStoreId)}/promotions`,
      { scopes: READ_SCOPES },
    );
    return res ?? { promotions: [] };
  }

  async getPromotion(promotionId: string) {
    return (
      (await this.client.request<any>(
        "GET",
        `/v1/delivery/promotions/${encodeURIComponent(promotionId)}`,
        { scopes: READ_SCOPES },
      )) ?? null
    );
  }
}
