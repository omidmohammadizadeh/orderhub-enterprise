import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CareemClientService } from "./careem-client.service";
import { CareemOrderService } from "./careem-order.service";

// Phase CA-2 (outbound) — our order status, pushed back to Careem.
//
// Careem accepts exactly three states on PUT /orders/{id}: accepted, ready,
// cancelled. Everything else our board can be in has no counterpart and is
// simply not sent.
//
// ── Why cancellation_reason is not optional in practice ─────────────────────
//
// Their schema marks it required on every call, including accepts, and the
// values are a fixed, CASE-SENSITIVE enum. Sending our own free-text cancel
// reason — which is what a member of staff actually types — would be rejected,
// so the text is mapped onto their vocabulary and anything unrecognised
// becomes OTHER rather than failing the call. A cancelled order that Careem
// never hears about leaves a customer waiting for food nobody is making.

/** Their enum, exactly as spelled. Case-sensitive per the docs. */
const CANCELLATION_REASONS = [
  "ITEM_PERMANENTLY_NOT_AVAILABLE",
  "ITEM_TEMPORARILY_UNAVAILABLE",
  "KITCHEN_TOO_BUSY_TO_PREPARE_ORDER",
  "OUT_OF_KITCHEN_OPERATIONAL_HOURS",
  "OUTLET_CLOSED",
  "PARTNER_POS_OUTAGE",
  "PARTNER_ORDER_TIMEOUT",
  "OTHER",
] as const;
export type CareemCancellationReason = (typeof CANCELLATION_REASONS)[number];

/**
 * Map whatever a member of staff typed onto Careem's fixed vocabulary.
 *
 * Exported and pure because the mapping is a judgement call worth reading and
 * testing on its own. Unrecognised text becomes OTHER — never a rejected call.
 */
export function careemCancellationReason(
  raw: string | null | undefined,
): CareemCancellationReason {
  const s = String(raw ?? "").toLowerCase();
  if (!s) return "OTHER";
  // Already one of theirs (a re-send, or an operator picking from a list).
  const exact = CANCELLATION_REASONS.find((r) => r.toLowerCase() === s);
  if (exact) return exact;

  if (/permanent|discontinu|delisted/.test(s)) return "ITEM_PERMANENTLY_NOT_AVAILABLE";
  if (/out of stock|unavailable|sold out|86|no stock/.test(s))
    return "ITEM_TEMPORARILY_UNAVAILABLE";
  if (/busy|slammed|too many|capacity|backed up/.test(s))
    return "KITCHEN_TOO_BUSY_TO_PREPARE_ORDER";
  if (/clos(ed|ing)|shut/.test(s)) return "OUTLET_CLOSED";
  if (/hours|after hours|not open/.test(s)) return "OUT_OF_KITCHEN_OPERATIONAL_HOURS";
  if (/outage|offline|system|pos down/.test(s)) return "PARTNER_POS_OUTAGE";
  if (/timeout|timed out|no response/.test(s)) return "PARTNER_ORDER_TIMEOUT";
  return "OTHER";
}

@Injectable()
export class CareemOrderSyncService {
  private readonly logger = new Logger(CareemOrderSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: CareemClientService,
  ) {}

  /**
   * Push a status change for a Careem order.
   *
   * Listens rather than being called, so nothing in Orders has to know Careem
   * exists — the same decoupling the other marketplaces use. Non-Careem orders
   * fall out on the first check, which is most of them.
   */
  @OnEvent("order.status_changed")
  async onStatusChanged(payload: {
    orderId: string;
    tenantId: string;
  }): Promise<void> {
    if (!this.client.configured()) return;

    const order = await this.prisma.order.findFirst({
      where: { id: payload.orderId, platform: "CAREEM" as any },
      select: {
        id: true,
        externalId: true,
        status: true,
        failureReason: true,
        metadata: true,
      },
    });
    if (!order?.externalId) return;

    const state = CareemOrderService.outboundState(String(order.status));
    if (!state) return;

    const meta = (order.metadata ?? {}) as Record<string, unknown>;
    try {
      await this.client.request(`/orders/${order.externalId}`, {
        method: "PUT",
        // Careem scopes order endpoints by header, not by path.
        brandId: (meta.careemBrandId as string) ?? undefined,
        branchId: (meta.careemBranchId as string) ?? undefined,
        body: {
          state,
          // Required on every call, theirs included — not only on cancels.
          cancellation_reason:
            state === "cancelled"
              ? careemCancellationReason(order.failureReason)
              : "OTHER",
        },
      });
      this.logger.log(`Careem order ${order.externalId} → ${state}`);
    } catch (err) {
      // Never rethrow into the status transition. Our order has already moved;
      // failing here would roll back a kitchen state that staff can see, to
      // fix a marketplace they cannot.
      this.logger.error(
        `Careem ${state} failed for order ${order.externalId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Ask Careem for more preparation time.
   *
   * Their docs allow this ONCE per order, so it is not retried and a second
   * attempt is expected to fail — worth surfacing to whoever pressed the
   * button rather than swallowing.
   */
  async requestMoreTime(orderId: string, minutes: number): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, platform: "CAREEM" as any },
      select: { externalId: true, metadata: true },
    });
    if (!order?.externalId) return;
    const meta = (order.metadata ?? {}) as Record<string, unknown>;
    await this.client.request(`/orders/${order.externalId}/delay-request`, {
      method: "PUT",
      brandId: (meta.careemBrandId as string) ?? undefined,
      branchId: (meta.careemBranchId as string) ?? undefined,
      // Their maximum is 60.
      body: { delay_in_minutes: Math.min(60, Math.max(1, Math.round(minutes))) },
    });
  }

  /**
   * Tell Careem the shop turned this order down.
   *
   * Their tag endpoint takes exactly one value, `reject`, and it is metadata
   * rather than a state change — cancelling the order is a separate PUT, which
   * the status listener above already does. This is the extra signal that says
   * the rejection came from the kitchen, so their support can tell it apart
   * from a customer cancelling.
   */
  async tagRejected(orderId: string): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, platform: "CAREEM" as any },
      select: { externalId: true, metadata: true },
    });
    if (!order?.externalId) return;
    const meta = (order.metadata ?? {}) as Record<string, unknown>;
    await this.client.request(`/orders/${order.externalId}/tags`, {
      method: "PATCH",
      brandId: (meta.careemBrandId as string) ?? undefined,
      branchId: (meta.careemBranchId as string) ?? undefined,
      body: { tag: "reject" },
    });
  }
}
