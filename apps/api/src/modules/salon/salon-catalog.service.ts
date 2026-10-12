import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { normaliseWeeklyHours, round2 } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { mergeSalonSettings, readSalonSettings, tradeDefaults } from "./salon-settings";

// The salon's set-up: settings, the price list (services) and the team.
//
// Everything is tenant-scoped through the location's brand — a Location has
// no tenantId of its own.

export interface SalonServiceInput {
  category?: string;
  name?: string;
  description?: string | null;
  price?: number;
  priceFrom?: boolean;
  durationMins?: number;
  bufferMins?: number;
  processingStartMins?: number | null;
  processingMins?: number | null;
  depositType?: string;
  depositValue?: number | null;
  requiresPatchTest?: boolean;
  bookableOnline?: boolean;
  isActive?: boolean;
  sortOrder?: number;
  imageUrl?: string | null;
  addons?: Array<{ id?: string; name?: string; price?: number; durationMins?: number }>;
}

export interface SalonStaffInput {
  name?: string;
  title?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  colour?: string;
  userId?: string | null;
  bookableOnline?: boolean;
  acceptsWalkIns?: boolean;
  isActive?: boolean;
  sortOrder?: number;
  weeklyHours?: unknown;
  serviceIds?: string[];
  priceOverrides?: Record<string, number>;
  commissionPercent?: number | null;
}

const DEPOSIT_TYPES = ["NONE", "FIXED", "PERCENT", "FULL"];
const COLOURS = ["#f97316", "#0ea5e9", "#22c55e", "#a855f7", "#ef4444", "#eab308", "#14b8a6", "#ec4899"];

// A starter price list per trade, so a new shop can take a booking in the
// first minute and edit prices after. Prices are typical UK high-street.
const STARTERS: Record<string, Array<Omit<SalonServiceInput, "addons"> & { addons?: SalonServiceInput["addons"] }>> = {
  BARBER: [
    { category: "Haircuts", name: "Haircut", price: 18, durationMins: 30 },
    { category: "Haircuts", name: "Skin fade", price: 22, durationMins: 30, addons: [{ name: "Beard trim", price: 8, durationMins: 15 }, { name: "Hot towel", price: 5, durationMins: 10 }] },
    { category: "Haircuts", name: "Scissor cut", price: 22, durationMins: 40 },
    { category: "Haircuts", name: "Kids cut (under 12)", price: 14, durationMins: 20 },
    { category: "Haircuts", name: "Buzz cut", price: 12, durationMins: 15 },
    { category: "Beard", name: "Beard trim & shape", price: 12, durationMins: 20 },
    { category: "Beard", name: "Hot towel shave", price: 20, durationMins: 30 },
    { category: "Extras", name: "Line up", price: 8, durationMins: 10 },
  ],
  HAIR: [
    { category: "Cut & style", name: "Ladies cut & blow dry", price: 45, priceFrom: true, durationMins: 60 },
    { category: "Cut & style", name: "Blow dry", price: 28, durationMins: 45 },
    { category: "Cut & style", name: "Gents cut", price: 25, durationMins: 30 },
    { category: "Colour", name: "Full head colour", price: 65, priceFrom: true, durationMins: 120, processingStartMins: 30, processingMins: 40, requiresPatchTest: true, depositType: "FIXED", depositValue: 20 },
    { category: "Colour", name: "Root tint", price: 50, durationMins: 90, processingStartMins: 25, processingMins: 35, requiresPatchTest: true, depositType: "FIXED", depositValue: 15 },
    { category: "Colour", name: "Half head highlights", price: 85, priceFrom: true, durationMins: 150, processingStartMins: 60, processingMins: 35, depositType: "FIXED", depositValue: 25 },
    { category: "Treatments", name: "Olaplex treatment", price: 25, durationMins: 20 },
  ],
  NAILS: [
    { category: "Manicure", name: "Gel manicure", price: 28, durationMins: 45, addons: [{ name: "Gel removal", price: 5, durationMins: 15 }, { name: "Nail art (per nail)", price: 2, durationMins: 5 }] },
    { category: "Manicure", name: "Classic manicure", price: 20, durationMins: 30 },
    { category: "Extensions", name: "Acrylic full set", price: 40, durationMins: 90, depositType: "FIXED", depositValue: 10 },
    { category: "Extensions", name: "Acrylic infill", price: 30, durationMins: 60 },
    { category: "Extensions", name: "BIAB full set", price: 38, durationMins: 75 },
    { category: "Pedicure", name: "Gel pedicure", price: 32, durationMins: 50 },
  ],
  BEAUTY: [
    { category: "Brows & lashes", name: "Brow shape", price: 12, durationMins: 15 },
    { category: "Brows & lashes", name: "Lash lift & tint", price: 45, durationMins: 60, requiresPatchTest: true },
    { category: "Waxing", name: "Full leg wax", price: 30, durationMins: 40 },
    { category: "Facials", name: "Express facial", price: 35, durationMins: 30 },
  ],
};

@Injectable()
export class SalonCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async assertLocation(tenantId: string, locationId: string) {
    if (!locationId) throw new BadRequestException("Pick a location");
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId }, deletedAt: null },
      select: {
        id: true,
        name: true,
        timezone: true,
        currency: true,
        settings: true,
        businessType: true,
        openingHours: true,
        phone: true,
      },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc;
  }

  // ── Settings ────────────────────────────────────────────────────────

  async getSettings(tenantId: string, locationId: string) {
    const loc = await this.assertLocation(tenantId, locationId);
    return {
      locationId: loc.id,
      locationName: loc.name,
      timezone: loc.timezone,
      currency: loc.currency,
      businessType: loc.businessType,
      isSalon: loc.businessType === "SALON",
      shopHours: normaliseWeeklyHours(loc.openingHours),
      settings: readSalonSettings(loc.settings),
    };
  }

  async updateSettings(tenantId: string, locationId: string, patch: Record<string, unknown>) {
    const loc = await this.assertLocation(tenantId, locationId);
    const merged = mergeSalonSettings(loc.settings, patch ?? {});
    const current = (loc.settings ?? {}) as Record<string, unknown>;
    await this.prisma.location.update({
      where: { id: loc.id },
      data: { settings: { ...current, salon: merged } as any },
    });
    return this.getSettings(tenantId, locationId);
  }

  /**
   * Turn a location into a salon: business type, trade defaults, and (when
   * the price list is empty and asked for) a starter price list and one
   * team member so the diary isn't blank.
   */
  async enable(
    tenantId: string,
    locationId: string,
    input: { trade?: string; starterServices?: boolean; firstStaffName?: string },
  ) {
    const loc = await this.assertLocation(tenantId, locationId);
    const trade = String(input.trade ?? "BARBER").toUpperCase();
    const current = (loc.settings ?? {}) as Record<string, unknown>;
    const already = current.salon && typeof current.salon === "object";
    const salon = mergeSalonSettings(
      loc.settings,
      already ? { trade } : { ...tradeDefaults(trade) },
    );
    await this.prisma.location.update({
      where: { id: loc.id },
      data: { businessType: "SALON" as any, settings: { ...current, salon } as any },
    });

    if (input.starterServices) {
      const has = await this.prisma.salonService.count({ where: { locationId } });
      if (has === 0) {
        const list = STARTERS[salon.trade] ?? STARTERS.BARBER!;
        let i = 0;
        for (const s of list) {
          await this.prisma.salonService.create({
            data: { tenantId, locationId, ...this.cleanService(s, true), sortOrder: i++ } as any,
          });
        }
      }
    }
    const name = (input.firstStaffName ?? "").trim();
    if (name) {
      const hasStaff = await this.prisma.salonStaff.count({ where: { locationId } });
      if (hasStaff === 0) {
        await this.prisma.salonStaff.create({
          data: { tenantId, locationId, name: name.slice(0, 80), colour: COLOURS[0]! },
        });
      }
    }
    return this.getSettings(tenantId, locationId);
  }

  // ── Services ────────────────────────────────────────────────────────

  async listServices(tenantId: string, locationId: string) {
    await this.assertLocation(tenantId, locationId);
    const rows = await this.prisma.salonService.findMany({
      where: { tenantId, locationId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return rows.map(serviceOut);
  }

  private cleanService(input: SalonServiceInput, creating: boolean) {
    const out: Record<string, unknown> = {};
    if (input.name !== undefined || creating) {
      const name = String(input.name ?? "").trim();
      if (!name) throw new BadRequestException("Give the service a name");
      out.name = name.slice(0, 120);
    }
    if (input.category !== undefined) out.category = String(input.category || "Services").trim().slice(0, 60) || "Services";
    if (input.description !== undefined) out.description = input.description ? String(input.description).slice(0, 1000) : null;
    if (input.price !== undefined || creating) {
      const p = Number(input.price ?? 0);
      if (!Number.isFinite(p) || p < 0) throw new BadRequestException("Price can't be negative");
      out.price = round2(p);
    }
    if (input.priceFrom !== undefined) out.priceFrom = !!input.priceFrom;
    if (input.durationMins !== undefined || creating) {
      const d = Math.round(Number(input.durationMins ?? 30));
      if (!Number.isFinite(d) || d < 5 || d > 12 * 60) throw new BadRequestException("Length must be between 5 minutes and 12 hours");
      out.durationMins = d;
    }
    if (input.bufferMins !== undefined) out.bufferMins = clampInt(input.bufferMins, 0, 120);
    if (input.processingStartMins !== undefined || input.processingMins !== undefined) {
      const ps = input.processingStartMins == null ? null : clampInt(input.processingStartMins, 0, 720);
      const pm = input.processingMins == null ? null : clampInt(input.processingMins, 0, 720);
      out.processingStartMins = ps && pm ? ps : null;
      out.processingMins = ps && pm ? pm : null;
    }
    if (input.depositType !== undefined) {
      const t = String(input.depositType).toUpperCase();
      if (!DEPOSIT_TYPES.includes(t)) throw new BadRequestException("Deposit must be NONE, FIXED, PERCENT or FULL");
      out.depositType = t;
    }
    if (input.depositValue !== undefined) {
      out.depositValue = input.depositValue == null ? null : round2(Math.max(0, Number(input.depositValue) || 0));
    }
    if (input.requiresPatchTest !== undefined) out.requiresPatchTest = !!input.requiresPatchTest;
    if (input.bookableOnline !== undefined) out.bookableOnline = !!input.bookableOnline;
    if (input.isActive !== undefined) out.isActive = !!input.isActive;
    if (input.sortOrder !== undefined) out.sortOrder = clampInt(input.sortOrder, 0, 100000);
    if (input.imageUrl !== undefined) out.imageUrl = input.imageUrl ? String(input.imageUrl).slice(0, 1000) : null;
    if (input.addons !== undefined) {
      if (!Array.isArray(input.addons)) throw new BadRequestException("Add-ons must be a list");
      out.addons = input.addons
        .map((a) => ({
          id: String(a?.id || Math.random().toString(36).slice(2, 10)),
          name: String(a?.name ?? "").trim().slice(0, 80),
          price: round2(Math.max(0, Number(a?.price) || 0)),
          durationMins: clampInt(a?.durationMins ?? 0, 0, 240),
        }))
        .filter((a) => a.name)
        .slice(0, 20);
    }
    return out;
  }

  async createService(tenantId: string, locationId: string, input: SalonServiceInput) {
    await this.assertLocation(tenantId, locationId);
    const data = this.cleanService(input, true);
    if (data.sortOrder === undefined) {
      data.sortOrder = await this.prisma.salonService.count({ where: { locationId } });
    }
    const row = await this.prisma.salonService.create({
      data: { tenantId, locationId, ...data } as any,
    });
    return serviceOut(row);
  }

  async updateService(tenantId: string, id: string, input: SalonServiceInput) {
    const row = await this.prisma.salonService.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Service not found");
    const updated = await this.prisma.salonService.update({
      where: { id },
      data: this.cleanService(input, false) as any,
    });
    return serviceOut(updated);
  }

  /** Appointments copy their services in, so a hard delete loses no history. */
  async deleteService(tenantId: string, id: string) {
    const row = await this.prisma.salonService.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Service not found");
    await this.prisma.salonService.delete({ where: { id } });
    return { ok: true };
  }

  async reorderServices(tenantId: string, locationId: string, ids: string[]) {
    await this.assertLocation(tenantId, locationId);
    if (!Array.isArray(ids)) throw new BadRequestException("ids must be a list");
    await this.prisma.$transaction(
      ids.map((id, i) =>
        this.prisma.salonService.updateMany({ where: { id, tenantId, locationId }, data: { sortOrder: i } }),
      ),
    );
    return this.listServices(tenantId, locationId);
  }

  // ── Team ────────────────────────────────────────────────────────────

  async listStaff(tenantId: string, locationId: string, opts?: { includeArchived?: boolean }) {
    await this.assertLocation(tenantId, locationId);
    const rows = await this.prisma.salonStaff.findMany({
      where: { tenantId, locationId, ...(opts?.includeArchived ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return rows.map(staffOut);
  }

  private async cleanStaff(tenantId: string, locationId: string, input: SalonStaffInput, creating: boolean) {
    const out: Record<string, unknown> = {};
    if (input.name !== undefined || creating) {
      const name = String(input.name ?? "").trim();
      if (!name) throw new BadRequestException("Give them a name");
      out.name = name.slice(0, 80);
    }
    if (input.title !== undefined) out.title = input.title ? String(input.title).slice(0, 80) : null;
    if (input.bio !== undefined) out.bio = input.bio ? String(input.bio).slice(0, 1000) : null;
    if (input.avatarUrl !== undefined) out.avatarUrl = input.avatarUrl ? String(input.avatarUrl).slice(0, 1000) : null;
    if (input.colour !== undefined) {
      const c = String(input.colour);
      out.colour = /^#[0-9a-fA-F]{6}$/.test(c) ? c : COLOURS[0];
    }
    if (input.userId !== undefined) {
      if (input.userId) {
        const user = await this.prisma.user.findFirst({
          where: { id: input.userId, tenantId },
          select: { id: true },
        });
        if (!user) throw new BadRequestException("That team login isn't in this business");
      }
      out.userId = input.userId || null;
    }
    if (input.bookableOnline !== undefined) out.bookableOnline = !!input.bookableOnline;
    if (input.acceptsWalkIns !== undefined) out.acceptsWalkIns = !!input.acceptsWalkIns;
    if (input.isActive !== undefined) out.isActive = !!input.isActive;
    if (input.sortOrder !== undefined) out.sortOrder = clampInt(input.sortOrder, 0, 100000);
    if (input.weeklyHours !== undefined) out.weeklyHours = normaliseWeeklyHours(input.weeklyHours);
    if (input.serviceIds !== undefined) {
      if (!Array.isArray(input.serviceIds)) throw new BadRequestException("serviceIds must be a list");
      const ids = Array.from(new Set(input.serviceIds.map(String)));
      if (ids.length) {
        const n = await this.prisma.salonService.count({ where: { id: { in: ids }, tenantId, locationId } });
        if (n !== ids.length) throw new BadRequestException("Some of those services aren't on this price list");
      }
      out.serviceIds = ids;
    }
    if (input.priceOverrides !== undefined) {
      const po: Record<string, number> = {};
      for (const [k, v] of Object.entries(input.priceOverrides ?? {})) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) po[k] = round2(n);
      }
      out.priceOverrides = po;
    }
    if (input.commissionPercent !== undefined) {
      out.commissionPercent =
        input.commissionPercent == null ? null : Math.min(100, Math.max(0, Number(input.commissionPercent) || 0));
    }
    return out;
  }

  async createStaff(tenantId: string, locationId: string, input: SalonStaffInput) {
    await this.assertLocation(tenantId, locationId);
    const data = await this.cleanStaff(tenantId, locationId, input, true);
    const count = await this.prisma.salonStaff.count({ where: { locationId } });
    if (data.colour === undefined) data.colour = COLOURS[count % COLOURS.length];
    if (data.sortOrder === undefined) data.sortOrder = count;
    const row = await this.prisma.salonStaff.create({ data: { tenantId, locationId, ...data } as any });
    return staffOut(row);
  }

  async updateStaff(tenantId: string, id: string, input: SalonStaffInput) {
    const row = await this.prisma.salonStaff.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Team member not found");
    const data = await this.cleanStaff(tenantId, row.locationId, input, false);
    const updated = await this.prisma.salonStaff.update({ where: { id }, data: data as any });
    return staffOut(updated);
  }

  /**
   * Archive rather than delete: their past appointments and takings still
   * need a name. Refused while they have bookings still to come.
   */
  async archiveStaff(tenantId: string, id: string) {
    const row = await this.prisma.salonStaff.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Team member not found");
    const upcoming = await this.prisma.salonAppointment.count({
      where: {
        staffId: id,
        startsAt: { gte: new Date() },
        status: { in: ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN"] },
      },
    });
    if (upcoming > 0) {
      throw new BadRequestException(
        `${row.name} still has ${upcoming} upcoming appointment${upcoming === 1 ? "" : "s"} — move them to someone else first`,
      );
    }
    await this.prisma.salonStaff.update({ where: { id }, data: { isActive: false } });
    return { ok: true };
  }

  // ── Time off ────────────────────────────────────────────────────────

  async listTimeOff(tenantId: string, locationId: string, from?: string, to?: string) {
    await this.assertLocation(tenantId, locationId);
    const f = from ? new Date(from) : new Date(Date.now() - 7 * 86_400_000);
    const t = to ? new Date(to) : new Date(Date.now() + 90 * 86_400_000);
    return this.prisma.salonTimeOff.findMany({
      where: { tenantId, staff: { locationId }, endsAt: { gt: f }, startsAt: { lt: t } },
      orderBy: { startsAt: "asc" },
      include: { staff: { select: { id: true, name: true, colour: true } } },
    });
  }

  async addTimeOff(
    tenantId: string,
    input: { staffId: string; startsAt: string; endsAt: string; reason?: string },
    opts?: { allowClash?: boolean },
  ) {
    const staff = await this.prisma.salonStaff.findFirst({ where: { id: input.staffId, tenantId } });
    if (!staff) throw new NotFoundException("Team member not found");
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      throw new BadRequestException("Time off needs a start before its end");
    }
    if (!opts?.allowClash) {
      const clash = await this.prisma.salonAppointment.count({
        where: {
          staffId: staff.id,
          status: { in: ["PENDING_PAYMENT", "CONFIRMED", "CHECKED_IN", "IN_SERVICE"] },
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
        },
      });
      if (clash > 0) {
        throw new BadRequestException(
          `${staff.name} has ${clash} appointment${clash === 1 ? "" : "s"} in that time — move ${clash === 1 ? "it" : "them"} first, or tick "book it anyway"`,
        );
      }
    }
    return this.prisma.salonTimeOff.create({
      data: {
        tenantId,
        staffId: staff.id,
        startsAt,
        endsAt,
        reason: input.reason ? String(input.reason).slice(0, 200) : null,
      },
    });
  }

  async removeTimeOff(tenantId: string, id: string) {
    const row = await this.prisma.salonTimeOff.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Not found");
    await this.prisma.salonTimeOff.delete({ where: { id } });
    return { ok: true };
  }
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function serviceOut(r: any) {
  return {
    ...r,
    price: Number(r.price),
    depositValue: r.depositValue == null ? null : Number(r.depositValue),
    addons: Array.isArray(r.addons) ? r.addons : [],
  };
}

export function staffOut(r: any) {
  return {
    ...r,
    weeklyHours: normaliseWeeklyHours(r.weeklyHours),
    priceOverrides: (r.priceOverrides ?? {}) as Record<string, number>,
    commissionPercent: r.commissionPercent == null ? null : Number(r.commissionPercent),
  };
}
