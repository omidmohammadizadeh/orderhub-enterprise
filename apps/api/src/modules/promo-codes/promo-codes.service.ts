import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import type { PromoCodeType } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";

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
  constructor(private readonly prisma: PrismaService) {}

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
