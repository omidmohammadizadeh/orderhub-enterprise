import { BadRequestException, Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { TalabatClientService } from "./talabat-client.service";
import { talabatSettings, type TalabatConnectionRow } from "./talabat-connection.service";
import { TalabatOrderService } from "./talabat-order.service";
import { rollUpPromotions, summarizeTalabatDiscounts } from "./talabat-promotions";
import type { TalabatOrder } from "./talabat-types";

// Phase TB-6 — reconciliation and promotion reporting.
//
// ── Missed orders (POS Order Report service) ────────────────────────────────
//
//   GET /v2/chains/{chainCode}/orders/ids?status=accepted|cancelled
//        &pastNumberOfHours=…&vendorId=…        → { orderIdentifiers, count }
//   GET /v2/chains/{chainCode}/orders/{orderId} → { order: Order + status }
//
// Talabat measure us on Order-Ingestion success (≥ 98.9% to onboard, 99% for
// the base tier). An order Talabat took payment for that never reached our
// board is exactly what that metric counts — so this compares their list of
// the last 24 hours with ours and names the gaps, and can pull a missed order
// in so the kitchen at least sees it.
//
// ── Promotions ──────────────────────────────────────────────────────────────
//
// Every Talabat order carries its discount breakdown by sponsor (see
// talabat-promotions.ts). This rolls it up per promotion: how many orders,
// how much was discounted, and how much of that the RESTAURANT paid.

@Injectable()
export class TalabatReportService {
  private readonly logger = new Logger(TalabatReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TalabatClientService,
    private readonly orders: TalabatOrderService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  async reconcile(c: TalabatConnectionRow, opts: { hours?: number; importMissing?: boolean } = {}) {
    const chain = talabatSettings(c).chainCode;
    if (!chain || !c.externalStoreId) throw new BadRequestException("This connection needs a chain code first.");
    const hours = Math.min(24, Math.max(1, Math.round(opts.hours ?? 24)));
    const vendorId = talabatSettings(c).platformVendorId;

    const listed: Array<{ id: string; status: "accepted" | "cancelled" }> = [];
    for (const status of ["accepted", "cancelled"] as const) {
      const res = await this.client.request<{ orderIdentifiers?: string[] }>(
        `/v2/chains/${encodeURIComponent(chain)}/orders/ids`,
        { method: "GET", query: { status, pastNumberOfHours: hours, vendorId: vendorId ?? undefined } },
      );
      for (const id of res.data?.orderIdentifiers ?? []) listed.push({ id, status });
    }

    const ours = listed.length
      ? await this.prisma.order.findMany({
          where: { platform: "TALABAT" as any, externalId: { in: listed.map((l) => l.id) } },
          select: { externalId: true, status: true, id: true },
        })
      : [];
    const known = new Map(ours.map((o) => [o.externalId, o]));

    const missing: Array<{ token: string; talabatStatus: string; code?: string | null; total?: string | null; imported?: string | null; skipped?: string }> = [];
    const mismatched: Array<{ token: string; talabatStatus: string; ourStatus: string; orderId: string }> = [];
    for (const l of listed) {
      const mine = known.get(l.id);
      if (mine) {
        // Talabat cancelled it but our board still shows it live: the
        // ORDER_CANCELLED notification never landed.
        const live = !["CANCELLED", "REJECTED", "FAILED", "COMPLETED"].includes(String(mine.status));
        if (l.status === "cancelled" && live) {
          mismatched.push({ token: l.id, talabatStatus: l.status, ourStatus: String(mine.status), orderId: mine.id });
        }
        continue;
      }
      if (l.status === "cancelled") continue; // never reaching us and cancelled = nothing to cook
      const detail = await this.client
        .request<{ order?: TalabatOrder & { status?: string } }>(
          `/v2/chains/${encodeURIComponent(chain)}/orders/${encodeURIComponent(l.id)}`,
          { method: "GET" },
        )
        .then((r) => r.data?.order ?? null)
        .catch(() => null);
      // Without a vendor filter the list is chain-wide; only this vendor's
      // orders are ours to judge.
      if (detail && vendorId && detail.platformRestaurant?.id && String(detail.platformRestaurant.id) !== String(vendorId)) {
        continue;
      }
      const row: (typeof missing)[number] = {
        token: l.id,
        talabatStatus: l.status,
        code: detail?.code ?? null,
        total: detail?.price?.grandTotal ?? null,
      };
      if (opts.importMissing && detail) {
        // Already accepted on Talabat's side, so no accept callback applies:
        // strip them so our sync can't send a second accept.
        const recovered = { ...detail, token: detail.token || l.id, callbackUrls: {} } as TalabatOrder;
        const res = await this.orders.dispatch(c.externalStoreId, recovered);
        row.imported = res.orderId ?? null;
        if (!res.orderId) row.skipped = String(res.body?.message ?? "could not import");
      }
      missing.push(row);
    }

    const summary = {
      windowHours: hours,
      talabatOrders: listed.length,
      onOurBoard: listed.length - missing.length,
      missing,
      cancelledOnTalabatButLiveHere: mismatched,
      // OI SR as Talabat count it, for this window and this vendor.
      ingestionRate: listed.filter((l) => l.status === "accepted").length
        ? Math.round(
            (1 - missing.length / listed.filter((l) => l.status === "accepted").length) * 10000,
          ) / 100
        : null,
    };
    if (missing.length || mismatched.length) {
      this.activity?.record({
        tenantId: c.tenantId,
        brandId: c.brandId,
        locationId: c.locationId,
        category: "ORDERS",
        channel: "TALABAT",
        action: "order.reconcile",
        status: "WARNING",
        message:
          `Talabat reconciliation: ${missing.length} order(s) Talabat accepted never reached the board` +
          (mismatched.length ? `, ${mismatched.length} cancelled on Talabat still live here` : ""),
        details: summary,
      });
    }
    return summary;
  }

  async promotions(
    tenantId: string,
    filter: { from?: string; to?: string; locationId?: string; brandId?: string },
  ) {
    const from = filter.from ? new Date(filter.from) : new Date(Date.now() - 7 * 24 * 3600_000);
    const to = filter.to ? new Date(filter.to) : new Date();
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
      throw new BadRequestException("from/to must be dates");
    }
    const rows = await this.prisma.order.findMany({
      where: {
        tenantId,
        platform: "TALABAT" as any,
        isSandbox: false,
        createdAt: { gte: from, lte: to },
        status: { notIn: ["CANCELLED", "REJECTED", "FAILED"] as any },
        ...(filter.locationId ? { locationId: filter.locationId } : {}),
        ...(filter.brandId ? { brandId: filter.brandId } : {}),
      },
      select: { id: true, total: true, discount: true, metadata: true },
      take: 20_000,
    });
    const summaries = rows.map((o) => {
      const t = ((o.metadata ?? {}) as any).talabat ?? {};
      // Orders ingested before this summary existed still carry the raw body.
      return t.promotions ?? summarizeTalabatDiscounts(((o.metadata ?? {}) as any).talabatRaw ?? {});
    });
    const { rows: byPromotion, totals } = rollUpPromotions(summaries);
    const sales = rows.reduce((a, o) => a + Number(o.total ?? 0), 0);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      orders: rows.length,
      ordersWithDiscount: summaries.filter((s) => (s?.total ?? 0) > 0).length,
      sales: Math.round(sales * 100) / 100,
      discounts: totals,
      byPromotion,
      note:
        "Talabat restaurant promotions are created in Talabat's own portal; the POS API only reports them. " +
        "'vendor' is what the restaurant funded, 'platform' what Talabat funded.",
    };
  }
}
