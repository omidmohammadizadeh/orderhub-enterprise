import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

export interface SubmitReviewDto {
  orderId: string;
  rating: number;
  comment?: string;
  customerName?: string;
}

// Only a finished order can be reviewed. Reviewing an order still being cooked
// tells you nothing, and it's the "verified purchase" property that makes these
// reviews worth more than an open review site's.
const REVIEWABLE_STATUSES = ["COMPLETED", "DELIVERED"];

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private db() {
    return this.prisma as any;
  }

  // ── Customer side (public) ──────────────────────────────────────────────

  /**
   * Leave a review for an order. Public — the customer proves entitlement by
   * knowing the order id, which they only have from their own order history.
   */
  async submit(dto: SubmitReviewDto) {
    const rating = Math.round(Number(dto.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException("Rating must be between 1 and 5");
    }
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        brandId: true,
        customerId: true,
        status: true,
        customerInfo: true,
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!REVIEWABLE_STATUSES.includes(String(order.status))) {
      throw new BadRequestException(
        "You can leave a review once the order is complete.",
      );
    }
    const existing = await this.db().review.findUnique({
      where: { orderId: order.id },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException("You've already reviewed this order.");
    }
    const nameFromOrder =
      (order.customerInfo as any)?.name ?? (order.customerInfo as any)?.firstName;
    return this.db().review.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        locationId: order.locationId,
        brandId: order.brandId ?? null,
        customerId: order.customerId ?? null,
        customerName: this.displayName(dto.customerName ?? nameFromOrder),
        rating,
        comment: dto.comment?.trim()?.slice(0, 2000) || null,
      },
    });
  }

  /**
   * "Bruce W." — first name plus a surname initial. Reviews are public, so we
   * never publish a customer's full name.
   */
  private displayName(raw?: string | null): string {
    const parts = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "Customer";
    const first = parts[0]!;
    const last = parts.length > 1 ? parts[parts.length - 1]! : "";
    return last ? `${first} ${last[0]!.toUpperCase()}.` : first;
  }

  /** Which of these order ids already have a review (drives the UI button). */
  async reviewedOrderIds(orderIds: string[]): Promise<string[]> {
    if (!orderIds.length) return [];
    const rows = await this.db().review.findMany({
      where: { orderId: { in: orderIds } },
      select: { orderId: true },
    });
    return rows.map((r: any) => r.orderId);
  }

  // ── Storefront display (public) ─────────────────────────────────────────

  /** Published reviews + rating summary for a brand or a location. */
  async publicList(params: {
    brandId?: string;
    locationId?: string;
    rating?: number;
    limit?: number;
  }) {
    const { brandId, locationId } = params;
    if (!brandId && !locationId) {
      throw new BadRequestException("brandId or locationId is required");
    }
    // Brand wins when both are given — a storefront is a brand, and a brand can
    // trade from several locations.
    const scope = brandId ? { brandId } : { locationId };
    const where: any = { ...scope, status: "PUBLISHED" };

    // Summary is always over ALL published reviews, never the filtered subset —
    // otherwise picking "2 stars" would redraw the headline average as 2.0.
    const grouped = await this.db().review.groupBy({
      by: ["rating"],
      where: { ...scope, status: "PUBLISHED" },
      _count: { rating: true },
    });
    const breakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let total = 0;
    let sum = 0;
    for (const g of grouped) {
      const n = g._count.rating as number;
      breakdown[g.rating as number] = n;
      total += n;
      sum += n * (g.rating as number);
    }

    if (params.rating) where.rating = params.rating;
    const reviews = await this.db().review.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(params.limit ?? 20, 1), 100),
      select: {
        id: true,
        rating: true,
        comment: true,
        customerName: true,
        reply: true,
        repliedAt: true,
        createdAt: true,
      },
    });

    return {
      summary: {
        average: total ? Math.round((sum / total) * 10) / 10 : 0,
        total,
        breakdown,
      },
      reviews,
    };
  }

  // ── Operator side (dashboard) ───────────────────────────────────────────

  async list(
    user: AuthenticatedUser,
    params: { locationId?: string; brandId?: string; rating?: number; limit?: number },
  ) {
    const where: any = { tenantId: user.tenantId };
    if (params.locationId) where.locationId = params.locationId;
    if (params.brandId) where.brandId = params.brandId;
    if (params.rating) where.rating = params.rating;
    return this.db().review.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(params.limit ?? 50, 1), 200),
    });
  }

  private async assertOwned(id: string, tenantId: string) {
    const review = await this.db().review.findUnique({ where: { id } });
    if (!review) throw new NotFoundException("Review not found");
    if (review.tenantId !== tenantId) {
      throw new ForbiddenException("Not your review");
    }
    return review;
  }

  /** Publish (or update) the operator's public response. */
  async reply(id: string, user: AuthenticatedUser, text: string) {
    await this.assertOwned(id, user.tenantId);
    const reply = String(text ?? "").trim().slice(0, 2000);
    if (!reply) throw new BadRequestException("Write a reply first");
    return this.db().review.update({
      where: { id },
      data: { reply, repliedAt: new Date(), repliedBy: user.userId },
    });
  }

  /**
   * Hide or restore. Hiding keeps the row — the operator can still read it, and
   * a deleted-on-demand review system is one an owner can quietly launder.
   */
  async setStatus(id: string, user: AuthenticatedUser, status: string) {
    await this.assertOwned(id, user.tenantId);
    const next = String(status).toUpperCase();
    if (!["PUBLISHED", "HIDDEN"].includes(next)) {
      throw new BadRequestException("status must be PUBLISHED or HIDDEN");
    }
    return this.db().review.update({ where: { id }, data: { status: next } });
  }
}
