import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { DriverAssignmentStatus } from "@orderhub/database";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Phase BG — driver pay + cash-up.
//
// Earning for a period = startupFee (once per distinct day worked) + the
// matched per-postcode fee for each delivery. Postcode matching is
// longest-prefix over the driver's configured rules, normalised to
// upper-case with spaces removed ("DH2" covers "DH2 1DD"; an exact "DH21DD"
// rule beats the "DH2" rule).
//
// Cash-up settles the OUTSTANDING period (since the driver's last cash-up)
// and advances the cleared marker, so deliveries are never double-counted.
// cashHandover = cash collected - driver earning; negative = the RESTAURANT
// owes the driver.

export interface PostcodeFee {
  postcode: string;
  fee: number;
}

export interface EarningsBreakdown {
  deliveries: number;
  cashOrders: number;
  cashCollected: number;
  cardOrders: number;
  cardCollected: number;
  daysWorked: number;
  startupFeeTotal: number;
  deliveryFeeTotal: number;
  driverEarning: number;
  cashHandover: number; // cashCollected - driverEarning (negative = owed to driver)
}

const CASH_METHODS = ["CASH", "CASH_ON_DELIVERY", "COD"];

export function normalizePostcode(pc: unknown): string {
  return String(pc ?? "").toUpperCase().replace(/\s+/g, "");
}

/** Longest-prefix match of an order postcode against the driver's rules. */
export function matchPostcodeFee(rules: PostcodeFee[], orderPostcode: unknown): number {
  const n = normalizePostcode(orderPostcode);
  if (!n) return 0;
  let best = 0;
  let bestLen = -1;
  for (const r of rules) {
    const p = normalizePostcode(r.postcode);
    if (!p) continue;
    if (n.startsWith(p) && p.length > bestLen) {
      best = Number(r.fee) || 0;
      bestLen = p.length;
    }
  }
  return best;
}

export function coercePostcodeFees(value: unknown): PostcodeFee[] {
  if (!Array.isArray(value)) return [];
  const out: PostcodeFee[] = [];
  for (const row of value) {
    const postcode = String((row as any)?.postcode ?? "").trim();
    const fee = Number((row as any)?.fee);
    if (postcode && Number.isFinite(fee) && fee >= 0) out.push({ postcode, fee });
  }
  return out;
}

@Injectable()
export class DriverEarningsService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveAccessibleLocationIds(user: AuthenticatedUser): Promise<string[]> {
    if (["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER"].includes(String(user.role))) {
      const locs = await this.prisma.location.findMany({
        where: { brand: { tenantId: user.tenantId }, deletedAt: null },
        select: { id: true },
      });
      return locs.map((l) => l.id);
    }
    const rows = await (this.prisma as any).userLocation.findMany({
      where: { userId: user.userId },
      select: { locationId: true },
    });
    return rows.map((r: any) => r.locationId);
  }

  private async getDriverForTenant(driverId: string, tenantId: string) {
    const driver = await this.prisma.driver.findFirst({
      where: { id: driverId, tenantId },
    });
    if (!driver) throw new NotFoundException("Driver not found");
    return driver;
  }

  /** Save a driver's home location + pay config. */
  async updateEarningsConfig(
    user: AuthenticatedUser,
    driverId: string,
    dto: { locationId?: string | null; startupFee?: number; postcodeFees?: PostcodeFee[] },
  ) {
    const driver = await this.getDriverForTenant(driverId, user.tenantId);
    if (dto.locationId) {
      const accessible = await this.resolveAccessibleLocationIds(user);
      if (!accessible.includes(dto.locationId)) {
        throw new ForbiddenException("No access to that location");
      }
    }
    const startupFee =
      dto.startupFee != null && Number.isFinite(Number(dto.startupFee)) && Number(dto.startupFee) >= 0
        ? Number(dto.startupFee)
        : Number(driver.startupFee);
    return this.prisma.driver.update({
      where: { id: driver.id },
      data: {
        ...(dto.locationId !== undefined && { locationId: dto.locationId || null }),
        startupFee,
        ...(dto.postcodeFees !== undefined && {
          postcodeFees: coercePostcodeFees(dto.postcodeFees) as any,
        }),
      },
    });
  }

  /** When the driver's outstanding (uncashed) period starts — the last
   *  cash-up's periodEnd, or null if they've never been cashed up. */
  private async lastCashUpEnd(driverId: string): Promise<Date | null> {
    const last = await (this.prisma as any).driverCashUp.findFirst({
      where: { driverId },
      orderBy: { periodEnd: "desc" },
      select: { periodEnd: true },
    });
    return last?.periodEnd ?? null;
  }

  private async compute(
    driver: { startupFee: any; postcodeFees: any },
    driverId: string,
    from: Date | null,
    to: Date,
  ): Promise<EarningsBreakdown> {
    const rules = coercePostcodeFees(driver.postcodeFees);
    const assignments = await this.prisma.driverAssignment.findMany({
      where: {
        driverId,
        status: DriverAssignmentStatus.DELIVERED,
        deliveredAt: { ...(from ? { gt: from } : {}), lte: to },
      },
      select: {
        deliveredAt: true,
        order: { select: { total: true, paymentMethod: true, postcode: true } },
      },
    });

    let cashOrders = 0;
    let cashCollected = 0;
    let cardOrders = 0;
    let cardCollected = 0;
    let deliveryFeeTotal = 0;
    const days = new Set<string>();

    for (const a of assignments) {
      const total = Number(a.order.total) || 0;
      const method = (a.order.paymentMethod ?? "").toUpperCase();
      const isCash = CASH_METHODS.some((m) => method.includes(m)) || method === "";
      if (isCash) {
        cashOrders += 1;
        cashCollected += total;
      } else {
        cardOrders += 1;
        cardCollected += total;
      }
      deliveryFeeTotal += matchPostcodeFee(rules, a.order.postcode);
      if (a.deliveredAt) days.add(a.deliveredAt.toISOString().slice(0, 10));
    }

    const daysWorked = days.size;
    const startupFeeTotal = Number(driver.startupFee) * daysWorked;
    const driverEarning = round2(startupFeeTotal + deliveryFeeTotal);
    const cashHandover = round2(cashCollected - driverEarning);
    return {
      deliveries: assignments.length,
      cashOrders,
      cashCollected: round2(cashCollected),
      cardOrders,
      cardCollected: round2(cardCollected),
      daysWorked,
      startupFeeTotal: round2(startupFeeTotal),
      deliveryFeeTotal: round2(deliveryFeeTotal),
      driverEarning,
      cashHandover,
    };
  }

  /**
   * Cash-up view. With no from/to → the OUTSTANDING period (since the last
   * cash-up). With an explicit range → that window (read-only history view).
   */
  async cashUpView(
    user: AuthenticatedUser,
    driverId: string,
    range?: { from?: string; to?: string },
  ) {
    const driver = await this.getDriverForTenant(driverId, user.tenantId);
    let from: Date | null;
    let to: Date;
    let outstanding: boolean;
    if (range?.from || range?.to) {
      from = range.from ? new Date(range.from) : null;
      to = range.to ? new Date(range.to) : new Date();
      outstanding = false;
    } else {
      from = await this.lastCashUpEnd(driverId);
      to = new Date();
      outstanding = true;
    }
    const breakdown = await this.compute(driver, driverId, from, to);
    return {
      driverId,
      driverName: `${driver.firstName} ${driver.lastName}`.trim(),
      periodStart: from ? from.toISOString() : null,
      periodEnd: to.toISOString(),
      outstanding,
      startupFee: Number(driver.startupFee),
      ...breakdown,
    };
  }

  /** Settle the outstanding period: snapshot it and advance the cleared marker. */
  async settleCashUp(user: AuthenticatedUser, driverId: string) {
    const driver = await this.getDriverForTenant(driverId, user.tenantId);
    const from = await this.lastCashUpEnd(driverId);
    const to = new Date();
    const b = await this.compute(driver, driverId, from, to);
    if (b.deliveries === 0) {
      throw new BadRequestException("Nothing to cash up — no deliveries since the last cash-up.");
    }
    const first = await this.prisma.driverAssignment.findFirst({
      where: {
        driverId,
        status: DriverAssignmentStatus.DELIVERED,
        deliveredAt: { ...(from ? { gt: from } : {}), lte: to },
      },
      orderBy: { deliveredAt: "asc" },
      select: { deliveredAt: true },
    });
    const periodStart = from ?? first?.deliveredAt ?? to;
    return (this.prisma as any).driverCashUp.create({
      data: {
        tenantId: user.tenantId,
        driverId,
        locationId: driver.locationId ?? null,
        periodStart,
        periodEnd: to,
        cashOrders: b.cashOrders,
        cashCollected: b.cashCollected,
        cardOrders: b.cardOrders,
        cardCollected: b.cardCollected,
        deliveries: b.deliveries,
        driverEarning: b.driverEarning,
        cashHandover: b.cashHandover,
        createdBy: user.userId,
      },
    });
  }

  async listCashUps(user: AuthenticatedUser, driverId: string) {
    await this.getDriverForTenant(driverId, user.tenantId);
    return (this.prisma as any).driverCashUp.findMany({
      where: { tenantId: user.tenantId, driverId },
      orderBy: { periodEnd: "desc" },
      take: 60,
    });
  }
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
