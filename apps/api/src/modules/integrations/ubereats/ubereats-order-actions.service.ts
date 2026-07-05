// Phase UE-4b — the rest of Uber's Order Fulfillment suite. These were all
// exercised in the Base44-era certification, so they must return 200s in the
// sandbox checklist:
//
//   adjust-price               {amount_e5, tax_rate?, reason, custom_reason?}
//   update-ready-time          {ready_for_pickup_time}
//   validate-item-fulfillment  {issue_type, action_type?, item, …}
//   resolve-fulfillment-issues {fulfillment_issues:[{issue_type, action_type,
//                               item, suspend_until?, store_response?}]}
//   get-replacement-recommendations {id, order_id, store_id}
//
// All bodies are spec-shaped (partner OpenAPI, Order Fulfillment API 1.0.0).
// Callers reference OUR order id; we resolve the Uber order/store ids.

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { UberEatsClientService } from "./ubereats-client.service";

const SCOPES = ["eats.order"];
// validate-item-fulfillment + resolve-fulfillment-issues require BOTH scopes
// (the spec lists them together in one security block = AND). eats.order
// alone → 401.
const FULFILLMENT_SCOPES = ["eats.order", "eats.store.orders.read"];

export type AdjustPriceReason =
  | "REQUESTED_ADD_ONS"
  | "BIGGER_SIZE"
  | "NEW_ITEM_ADDED"
  | "ITEM_SOLD_OUT"
  | "REMOVED_ITEM"
  | "ADD_ON_UNAVAILABLE"
  | "OTHER";

@Injectable()
export class UberEatsOrderActionsService {
  private readonly logger = new Logger(UberEatsOrderActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: UberEatsClientService,
  ) {}

  /** Resolve OUR order → the Uber order id (+ store id from ingest metadata). */
  private async uberOrder(tenantId: string, orderId: string) {
    const row = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId, platform: "UBER_EATS" },
      select: { id: true, externalId: true, metadata: true },
    });
    if (!row?.externalId) {
      throw new NotFoundException("Uber Eats order not found");
    }
    const storeId =
      ((row.metadata as any)?.uberStoreId as string | undefined) ?? "";
    return { uberOrderId: row.externalId, storeId };
  }

  /**
   * Adjust the order price (item sold out, size change, add-on unavailable…).
   * `amountPounds` is the NEW price for the affected scope in pounds; Uber
   * wants amount_e5 (×10^5).
   */
  async adjustPrice(
    tenantId: string,
    orderId: string,
    dto: {
      amountPounds: number;
      taxRate?: number | string;
      reason: AdjustPriceReason;
      customReason?: string;
    },
  ) {
    if (!Number.isFinite(Number(dto.amountPounds))) {
      throw new BadRequestException("amountPounds is required");
    }
    const { uberOrderId } = await this.uberOrder(tenantId, orderId);
    await this.client.request(
      "POST",
      `/v1/delivery/order/${encodeURIComponent(uberOrderId)}/adjust-price`,
      {
        scopes: SCOPES,
        body: {
          amount_e5: Math.round(Number(dto.amountPounds) * 100_000),
          ...(dto.taxRate != null ? { tax_rate: String(dto.taxRate) } : {}),
          reason: dto.reason,
          ...(dto.customReason ? { custom_reason: dto.customReason } : {}),
        },
      },
    );
    this.logger.log(
      `Uber Eats adjust-price ${uberOrderId}: £${dto.amountPounds} (${dto.reason})`,
    );
    return { ok: true };
  }

  /** Push a new ready-for-pickup time (kitchen running behind/ahead). */
  async updateReadyTime(
    tenantId: string,
    orderId: string,
    dto: { minutesFromNow?: number; readyAt?: string },
  ) {
    const readyAt = dto.readyAt
      ? new Date(dto.readyAt)
      : new Date(Date.now() + (dto.minutesFromNow ?? 15) * 60_000);
    if (Number.isNaN(readyAt.getTime())) {
      throw new BadRequestException("Invalid ready time");
    }
    const { uberOrderId } = await this.uberOrder(tenantId, orderId);
    await this.client.request(
      "POST",
      `/v1/delivery/order/${encodeURIComponent(uberOrderId)}/update-ready-time`,
      { scopes: SCOPES, body: { ready_for_pickup_time: readyAt.toISOString() } },
    );
    this.logger.log(
      `Uber Eats update-ready-time ${uberOrderId} → ${readyAt.toISOString()}`,
    );
    return { ok: true, readyForPickupTime: readyAt.toISOString() };
  }

  /**
   * Validate how an item issue should be handled BEFORE resolving it
   * (out-of-item / partial availability / found item). Body passes through
   * spec-shaped; we only inject the Uber order id.
   */
  async validateItemFulfillment(
    tenantId: string,
    orderId: string,
    body: Record<string, unknown>,
  ) {
    if (!body?.issue_type || !body?.item) {
      throw new BadRequestException("issue_type and item are required");
    }
    const { uberOrderId } = await this.uberOrder(tenantId, orderId);
    const res = await this.client.request(
      "POST",
      `/v1/delivery/order/${encodeURIComponent(uberOrderId)}/validate-item-fulfillment`,
      { scopes: FULFILLMENT_SCOPES, body },
    );
    return res ?? { ok: true };
  }

  /** Resolve fulfillment issues (restaurant shape: fulfillment_issues[]). */
  async resolveFulfillmentIssues(
    tenantId: string,
    orderId: string,
    body: Record<string, unknown>,
  ) {
    const issues = (body as any)?.fulfillment_issues;
    if (!Array.isArray(issues) || issues.length === 0) {
      throw new BadRequestException(
        "fulfillment_issues must be a non-empty array",
      );
    }
    const { uberOrderId } = await this.uberOrder(tenantId, orderId);
    const res = await this.client.request(
      "POST",
      `/v1/delivery/order/${encodeURIComponent(uberOrderId)}/resolve-fulfillment-issues`,
      { scopes: FULFILLMENT_SCOPES, body },
    );
    this.logger.log(
      `Uber Eats resolve-fulfillment-issues ${uberOrderId}: ${issues.length} issue(s)`,
    );
    return res ?? { ok: true };
  }

  /** Replacement recommendations for a sold-out item. */
  async replacementRecommendations(
    tenantId: string,
    orderId: string,
    dto: { itemId: string; storeId?: string },
  ) {
    if (!dto.itemId) throw new BadRequestException("itemId is required");
    const { uberOrderId, storeId } = await this.uberOrder(tenantId, orderId);
    const store = dto.storeId || storeId;
    if (!store) {
      throw new BadRequestException(
        "No Uber store id on this order — pass storeId explicitly",
      );
    }
    const res = await this.client.request(
      "POST",
      `/v1/delivery/get-replacement-recommendations`,
      {
        scopes: SCOPES,
        body: { id: dto.itemId, order_id: uberOrderId, store_id: store },
      },
    );
    return res ?? { recommendations: [] };
  }
}
