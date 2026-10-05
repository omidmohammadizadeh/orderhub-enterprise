import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Optional,
} from "@nestjs/common";
import type { PromoCodeType } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { WalletService } from "../wallet/wallet.service";

// Phase AM — PromoCode CRUD + validate.
//
// Validation rules:
//   • code must exist for this tenant (case-insensitive)
//   • isActive = true
//   • now ∈ [startAt, expiresAt] when those are set
//   • usedCount < maxUses when maxUses is set
//   • subtotal ≥ minOrderValue when set
//   • locationIds must include the requested locationId when the array is non-empty
//
// usedCount is NOT incremented here — that happens when the order is actually
// created so an abandoned cart doesn't burn a use.

export interface CreatePromoCodeDto {
  code: string;
  type: PromoCodeType; // PERCENTAGE | FIXED_AMOUNT | FREE_DELIVERY
  value: number; // % for PERCENTAGE, £ for FIXED_AMOUNT, ignored for FREE_DELIVERY
  description?: string;
  minOrderValue?: number;
  maxUses?: number;
  /** Uses allowed per customer (1 = once each). Null/undefined = no limit. */
  maxUsesPerCustomer?: number | null;
  startAt?: string;
  expiresAt?: string;
  isActive?: boolean;
  locationIds?: string[];
  /** Show as a quick discount button on the till. Default true. */
  showOnPos?: boolean;
}

export type UpdatePromoCodeDto = Partial<CreatePromoCodeDto>;

export interface ValidateResult {
  valid: boolean;
  reason?: string;
  promoId?: string;
  code?: string;
  type?: PromoCodeType;
  value?: number;
  discountAmount?: number;
  freeDelivery?: boolean;
}

export interface ValidateInput {
  code: string;
  locationId: string;
  subtotal: number;
  /** Who is using it — needed for a once-per-customer code. */
  customerAccountId?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  /**
   * The online checkout knows who the customer is (sign-in is required), so a
   * per-customer code with nobody to check against is refused there. The till
   * passes false: staff apply codes at the counter at their discretion.
   */
  requireCustomerForLimit?: boolean;
}

/** Order statuses that never became a real order: their use doesn't count.
 *  PENDING is real only while fresh — an unpaid card order left for an hour
 *  was abandoned, and must not spend the customer's one go. */
const NOT_REAL = ["CANCELLED", "REJECTED", "FAILED"];

@Injectable()
export class PromoCodesService {
  constructor(
    private readonly prisma: PrismaService,
    // For "which shops may this user manage" (it owns that rule). Optional so
    // the existing positional test constructors keep working.
    @Optional() private readonly wallet?: WalletService,
  ) {}

  async list(tenantId: string, locationId?: string) {
    return this.prisma.promoCode.findMany({
      where: {
        tenantId,
        // When a locationId is given, return promos that are EITHER
        // unscoped (locationIds is empty = tenant-wide) OR include
        // this location explicitly. The Prisma `has` filter on a
        // String[] column does the explicit-include check; we OR it
        // with `isEmpty: true` to pick up tenant-wide promos.
        ...(locationId && {
          OR: [
            { locationIds: { isEmpty: true } },
            { locationIds: { has: locationId } },
          ],
        }),
      },
      orderBy: [{ isActive: "desc" }, { code: "asc" }],
    });
  }

  async create(tenantId: string, dto: CreatePromoCodeDto) {
    const code = (dto.code ?? "").trim().toUpperCase();
    if (!code) throw new BadRequestException("code is required");
    if (dto.value < 0) throw new BadRequestException("value must be ≥ 0");

    try {
      return await this.prisma.promoCode.create({
        data: {
          tenantId,
          code,
          type: dto.type,
          value: dto.value,
          description: dto.description ?? null,
          minOrderValue: dto.minOrderValue ?? null,
          maxUses: dto.maxUses ?? null,
          maxUsesPerCustomer: dto.maxUsesPerCustomer ?? null,
          startAt: dto.startAt ? new Date(dto.startAt) : null,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          isActive: dto.isActive ?? true,
          locationIds: dto.locationIds ?? [],
          showOnPos: dto.showOnPos ?? true,
        },
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        throw new ConflictException(`Promo code "${code}" already exists`);
      }
      throw err;
    }
  }

  async update(tenantId: string, id: string, dto: UpdatePromoCodeDto) {
    const existing = await this.prisma.promoCode.findFirst({
      where: { id, tenantId },
    });
    if (!existing) throw new NotFoundException("Promo code not found");

    return this.prisma.promoCode.update({
      where: { id },
      data: {
        ...(dto.code !== undefined && { code: dto.code.trim().toUpperCase() }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.value !== undefined && { value: dto.value }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.minOrderValue !== undefined && { minOrderValue: dto.minOrderValue }),
        ...(dto.maxUses !== undefined && { maxUses: dto.maxUses }),
        ...(dto.maxUsesPerCustomer !== undefined && { maxUsesPerCustomer: dto.maxUsesPerCustomer }),
        ...(dto.startAt !== undefined && {
          startAt: dto.startAt ? new Date(dto.startAt) : null,
        }),
        ...(dto.expiresAt !== undefined && {
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.locationIds !== undefined && { locationIds: dto.locationIds }),
        ...(dto.showOnPos !== undefined && { showOnPos: dto.showOnPos }),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    const existing = await this.prisma.promoCode.findFirst({
      where: { id, tenantId },
    });
    if (!existing) throw new NotFoundException("Promo code not found");
    await this.prisma.promoCode.delete({ where: { id } });
  }

  /**
   * Validate a promo code against a candidate order.
   * Returns the computed discount amount but does NOT persist anything.
   * The caller increments `usedCount` when the order is created.
   */
  async validate(
    tenantId: string,
    input: ValidateInput,
  ): Promise<ValidateResult> {
    const code = (input.code ?? "").trim().toUpperCase();
    if (!code) return { valid: false, reason: "code is required" };

    const promo = await this.prisma.promoCode.findFirst({
      where: { tenantId, code },
    });
    if (!promo) return { valid: false, reason: "Promo code not found" };
    if (!promo.isActive) return { valid: false, reason: "Promo code is inactive" };

    const now = new Date();
    if (promo.startAt && promo.startAt > now) {
      return { valid: false, reason: "Promo code is not yet active" };
    }
    if (promo.expiresAt && promo.expiresAt < now) {
      return { valid: false, reason: "Promo code has expired" };
    }
    if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) {
      return { valid: false, reason: "Promo code usage limit reached" };
    }
    if (
      promo.minOrderValue !== null &&
      input.subtotal < Number(promo.minOrderValue)
    ) {
      return {
        valid: false,
        reason: `Minimum spend of £${Number(promo.minOrderValue).toFixed(2)} required`,
      };
    }
    if (
      promo.locationIds.length > 0 &&
      !promo.locationIds.includes(input.locationId)
    ) {
      return {
        valid: false,
        reason: "Promo code not valid at this location",
      };
    }
    if (promo.maxUsesPerCustomer != null) {
      const who = this.identity(input);
      if (!who) {
        if (input.requireCustomerForLimit) {
          return { valid: false, reason: "Please sign in to use this code" };
        }
      } else if ((await this.usesBy(promo.id, who)) >= promo.maxUsesPerCustomer) {
        return {
          valid: false,
          reason:
            promo.maxUsesPerCustomer === 1
              ? "You've already used this code"
              : "You've used this code the maximum number of times",
        };
      }
    }

    // Compute discount.
    let discountAmount = 0;
    let freeDelivery = false;
    if (promo.type === "PERCENTAGE") {
      discountAmount =
        Math.round(input.subtotal * Number(promo.value)) / 100;
    } else if (promo.type === "FIXED_AMOUNT") {
      discountAmount = Math.min(Number(promo.value), input.subtotal);
    } else if (promo.type === "FREE_DELIVERY") {
      freeDelivery = true;
    }

    return {
      valid: true,
      promoId: promo.id,
      code: promo.code,
      type: promo.type,
      value: Number(promo.value),
      discountAmount,
      freeDelivery,
    };
  }

  /**
   * Atomically increment usedCount when an order successfully redeems a code.
   * Safe under concurrent calls — uses Prisma's increment operator.
   */
  // ── Marketing → Promo codes page ─────────────────────────────────────────

  /**
   * Who may manage which codes. Tenant-wide roles: all. A shop-scoped user:
   * only codes limited to their own shops — a code valid at EVERY shop
   * (locationIds empty) affects shops they don't run, so it's not theirs.
   */
  async assertCanManage(
    tenantId: string,
    user: { userId?: string; role?: string },
    locationIds: string[],
  ): Promise<void> {
    const allowed = await this.wallet?.accessibleLocationIds(tenantId, user.userId, user.role);
    if (!allowed) return;
    if (!locationIds.length) {
      throw new ForbiddenException("Only an account-wide admin can manage a code valid at every shop.");
    }
    if (locationIds.some((l) => !allowed.includes(l))) {
      throw new ForbiddenException("You can only manage codes for your own shops.");
    }
  }

  async createFor(tenantId: string, user: { userId?: string; role?: string }, dto: CreatePromoCodeDto) {
    await this.assertCanManage(tenantId, user, dto.locationIds ?? []);
    if (dto.type === "PERCENTAGE" && Number(dto.value) > 100) {
      throw new BadRequestException("A percentage can't be over 100.");
    }
    return this.create(tenantId, dto);
  }

  async updateFor(tenantId: string, user: { userId?: string; role?: string }, id: string, dto: UpdatePromoCodeDto) {
    const existing = await this.prisma.promoCode.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException("Promo code not found");
    await this.assertCanManage(tenantId, user, existing.locationIds);
    if (dto.locationIds !== undefined) await this.assertCanManage(tenantId, user, dto.locationIds);
    return this.update(tenantId, id, dto);
  }

  async removeFor(tenantId: string, user: { userId?: string; role?: string }, id: string) {
    const existing = await this.prisma.promoCode.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException("Promo code not found");
    await this.assertCanManage(tenantId, user, existing.locationIds);
    return this.remove(tenantId, id);
  }

  /** Every code visible here, with its status, results and where it's used. */
  async overview(tenantId: string, user: { userId?: string; role?: string }, locationId?: string | null) {
    const allowed = await this.wallet?.accessibleLocationIds(tenantId, user.userId, user.role);
    if (locationId && allowed && !allowed.includes(locationId)) {
      throw new ForbiddenException("You don't have access to this shop.");
    }
    const codes = await this.prisma.promoCode.findMany({
      where: {
        tenantId,
        ...(locationId
          ? { OR: [{ locationIds: { isEmpty: true } }, { locationIds: { has: locationId } }] }
          : allowed
            ? { OR: [{ locationIds: { isEmpty: true } }, { locationIds: { hasSome: allowed } }] }
            : {}),
      },
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    });
    if (!codes.length) return [];

    // Results come from the orders themselves (metadata.promoCode), so till
    // orders and orders from before redemptions were recorded count too.
    const scopeSql = locationId ? `AND "locationId" = $3` : allowed ? `AND "locationId" = ANY($3::text[])` : "";
    const params: unknown[] = [tenantId, codes.map((c) => c.code)];
    if (locationId) params.push(locationId);
    else if (allowed) params.push(allowed);
    const stats = await this.prisma.$queryRawUnsafe<
      { code: string; orders: number; revenue: number; discount: number; last_at: Date | null }[]
    >(
      `SELECT upper(trim(metadata->>'promoCode')) AS code, COUNT(*)::int AS orders,
              COALESCE(SUM(total), 0)::float AS revenue, COALESCE(SUM(discount), 0)::float AS discount,
              MAX("createdAt") AS last_at
       FROM orders
       WHERE "tenantId" = $1 AND upper(trim(metadata->>'promoCode')) = ANY($2::text[])
         AND status::text NOT IN ('${NOT_REAL.join("','")}') ${scopeSql}
       GROUP BY 1`,
      ...params,
    );
    const byCode = new Map(stats.map((r) => [r.code, r]));

    // Which emails promise each code (campaign drafts/scheduled/sent and
    // automations) — so deleting or pausing one isn't a surprise.
    const usedIn = await this.prisma.$queryRawUnsafe<{ code: string; kind: string; id: string; name: string; status: string }[]>(
      // jsonb::text always prints `"code": "VALUE"` (one space after the colon).
      `SELECT c.code, 'campaign' AS kind, ec.id, ec.name, ec.status
       FROM email_campaigns ec CROSS JOIN unnest($2::text[]) AS c(code)
       WHERE ec."tenantId" = $1 AND ec."automationId" IS NULL AND ec.status <> 'CANCELLED'
         AND ec.design::text ILIKE '%"code": "' || c.code || '"%'
       UNION ALL
       SELECT c.code, 'automation' AS kind, ea.id, ea.type AS name,
              CASE WHEN ea.enabled THEN 'ON' ELSE 'OFF' END AS status
       FROM email_automations ea CROSS JOIN unnest($2::text[]) AS c(code)
       WHERE ea."tenantId" = $1 AND ea.design::text ILIKE '%"code": "' || c.code || '"%'`,
      tenantId,
      codes.map((c) => c.code),
    );

    const now = new Date();
    return codes.map((c) => {
      const r = byCode.get(c.code);
      const status = !c.isActive
        ? "PAUSED"
        : c.expiresAt && c.expiresAt < now
          ? "EXPIRED"
          : c.maxUses != null && c.usedCount >= c.maxUses
            ? "USED_UP"
            : c.startAt && c.startAt > now
              ? "SCHEDULED"
              : "ACTIVE";
      return {
        id: c.id,
        code: c.code,
        description: c.description,
        type: c.type,
        value: Number(c.value),
        minOrderValue: c.minOrderValue != null ? Number(c.minOrderValue) : null,
        maxUses: c.maxUses,
        maxUsesPerCustomer: c.maxUsesPerCustomer,
        usedCount: c.usedCount,
        startAt: c.startAt,
        expiresAt: c.expiresAt,
        isActive: c.isActive,
        locationIds: c.locationIds,
        showOnPos: c.showOnPos,
        createdAt: c.createdAt,
        status,
        // Only an account-wide admin can manage an every-shop code.
        canManage: !allowed || (c.locationIds.length > 0 && c.locationIds.every((l) => allowed.includes(l))),
        results: {
          orders: Number(r?.orders ?? 0),
          revenue: Number(r?.revenue ?? 0),
          discount: Number(r?.discount ?? 0),
          lastUsedAt: r?.last_at ?? null,
        },
        usedIn: usedIn
          .filter((u) => u.code === c.code)
          .map((u) => ({ kind: u.kind, id: u.id, name: u.name, status: u.status })),
      };
    });
  }

  /** The latest orders that used a code. */
  async recentOrders(tenantId: string, user: { userId?: string; role?: string }, id: string) {
    const promo = await this.prisma.promoCode.findFirst({ where: { id, tenantId } });
    if (!promo) throw new NotFoundException("Promo code not found");
    const allowed = await this.wallet?.accessibleLocationIds(tenantId, user.userId, user.role);
    const params: unknown[] = [tenantId, promo.code];
    let scope = "";
    if (allowed) {
      params.push(allowed);
      scope = `AND o."locationId" = ANY($3::text[])`;
    }
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT o.id, o."displayId", o."orderNumber", o."createdAt", o.total::float AS total,
              o.discount::float AS discount, o."orderSource"::text AS source, o.status::text AS status,
              o."customerName", l.name AS "locationName"
       FROM orders o LEFT JOIN locations l ON l.id = o."locationId"
       WHERE o."tenantId" = $1 AND upper(trim(o.metadata->>'promoCode')) = $2 ${scope}
       ORDER BY o."createdAt" DESC LIMIT 50`,
      ...params,
    );
    return rows.map((r) => ({
      id: r.id,
      reference: r.displayId ?? (r.orderNumber != null ? `#${r.orderNumber}` : r.id.slice(-6)),
      createdAt: r.createdAt,
      total: r.total,
      discount: r.discount,
      source: r.source,
      status: r.status,
      // A first name is enough to recognise a regular; the rest stays private.
      customer: String(r.customerName ?? "").trim().split(/\s+/)[0] || null,
      locationName: r.locationName,
    }));
  }

  private identity(input: {
    customerAccountId?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
  }): { accountId: string | null; email: string | null; phone: string | null } | null {
    const accountId = String(input.customerAccountId ?? "").trim() || null;
    const email = String(input.customerEmail ?? "").trim().toLowerCase() || null;
    const phone = String(input.customerPhone ?? "").replace(/[^\d+]/g, "") || null;
    return accountId || email || phone ? { accountId, email, phone } : null;
  }

  /** Times this customer has used the code on an order that really happened. */
  private async usesBy(
    promoCodeId: string,
    who: { accountId: string | null; email: string | null; phone: string | null },
  ): Promise<number> {
    const params: unknown[] = [promoCodeId];
    const ors: string[] = [];
    if (who.accountId) { params.push(who.accountId); ors.push(`r."customerAccountId" = $${params.length}`); }
    if (who.email) { params.push(who.email); ors.push(`r."customerEmail" = $${params.length}`); }
    if (who.phone) { params.push(who.phone); ors.push(`r."customerPhone" = $${params.length}`); }
    const rows = await this.prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n
       FROM promo_code_redemptions r
       JOIN orders o ON o.id = r."orderId"
       WHERE r."promoCodeId" = $1 AND (${ors.join(" OR ")})
         AND o.status::text NOT IN ('${NOT_REAL.join("','")}')
         AND NOT (o.status::text = 'PENDING' AND o."createdAt" < now() - interval '1 hour')`,
      ...params,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * An order was placed with this code: count it, and remember who used it so
   * a once-per-customer code can't be used twice. Idempotent per order.
   */
  async recordUse(args: {
    tenantId: string;
    code: string;
    orderId: string;
    customerAccountId?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
  }): Promise<void> {
    const code = args.code.trim().toUpperCase();
    const promo = await this.prisma.promoCode.findFirst({
      where: { tenantId: args.tenantId, code },
      select: { id: true },
    });
    if (!promo) return;
    const who = this.identity(args);
    const created = await this.prisma.promoCodeRedemption.createMany({
      data: [
        {
          tenantId: args.tenantId,
          promoCodeId: promo.id,
          orderId: args.orderId,
          customerAccountId: who?.accountId ?? null,
          customerEmail: who?.email ?? null,
          customerPhone: who?.phone ?? null,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count) {
      await this.prisma.promoCode.update({ where: { id: promo.id }, data: { usedCount: { increment: 1 } } });
    }
  }

  async incrementUsage(tenantId: string, code: string): Promise<void> {
    const normalised = code.trim().toUpperCase();
    await this.prisma.promoCode.updateMany({
      where: { tenantId, code: normalised },
      data: { usedCount: { increment: 1 } },
    });
  }
}
