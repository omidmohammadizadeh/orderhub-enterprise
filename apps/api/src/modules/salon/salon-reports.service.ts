import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  addDaysToDate,
  commissionOn,
  lineBlock,
  normaliseWeeklyHours,
  round2,
  staffDayWindows,
  wallDate,
  zonedWallToUtc,
} from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { readSalonSettings } from "./salon-settings";
import { storedLines } from "./salon-lines";

// The salon's numbers: per barber takings, tips, commission, how full their
// day was, no-shows; and for the shop, where bookings come from and which
// services sell.
//
// Takings are what the visit was checked out at (the appointment's final
// totalPrice once paid), never a guess from the price list.

@Injectable()
export class SalonReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(tenantId: string, q: { locationId: string; from: string; to: string }) {
    const loc = await this.prisma.location.findFirst({
      where: { id: q.locationId, brand: { tenantId } },
      select: { id: true, timezone: true, currency: true, openingHours: true, settings: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from) || !/^\d{4}-\d{2}-\d{2}$/.test(q.to) || q.to < q.from) {
      throw new BadRequestException("Pick a date range");
    }
    const tz = loc.timezone || "Europe/London";
    const days: string[] = [];
    for (let d = q.from; d <= q.to && days.length < 93; d = addDaysToDate(d, 1)) days.push(d);
    if (days.length >= 93) throw new BadRequestException("Pick at most three months");
    const fromMs = zonedWallToUtc(q.from, "00:00", tz);
    const toMs = zonedWallToUtc(addDaysToDate(q.to, 1), "00:00", tz);

    const [appts, staff, offs] = await Promise.all([
      this.prisma.salonAppointment.findMany({
        where: { tenantId, locationId: loc.id, startsAt: { gte: new Date(fromMs), lt: new Date(toMs) } },
        select: {
          id: true,
          staffId: true,
          status: true,
          source: true,
          services: true,
          totalPrice: true,
          tipAmount: true,
          startsAt: true,
          depositAmount: true,
          depositStatus: true,
          customerPhone: true,
          customerEmail: true,
          anyStaff: true,
        },
      }),
      this.prisma.salonStaff.findMany({ where: { tenantId, locationId: loc.id } }),
      this.prisma.salonTimeOff.findMany({
        where: { tenantId, staff: { locationId: loc.id }, startsAt: { lt: new Date(toMs) }, endsAt: { gt: new Date(fromMs) } },
      }),
    ]);
    const shopHours = normaliseWeeklyHours(loc.openingHours);

    const perStaff = staff.map((s) => {
      const mine = appts.filter((a) => a.staffId === s.id);
      const done = mine.filter((a) => a.status === "COMPLETED");
      const takings = round2(done.reduce((t, a) => t + Number(a.totalPrice), 0));
      const tips = round2(done.reduce((t, a) => t + Number(a.tipAmount ?? 0), 0));
      // Minutes they were bookable vs minutes booked (live + done, not cancelled).
      let available = 0;
      for (const d of days) {
        for (const w of staffDayWindows({ staffHours: normaliseWeeklyHours(s.weeklyHours), shopHours, date: d, tz })) {
          available += (w.end - w.start) / 60_000;
        }
      }
      for (const o of offs.filter((x) => x.staffId === s.id)) {
        available -= Math.max(0, (Math.min(o.endsAt.getTime(), toMs) - Math.max(o.startsAt.getTime(), fromMs)) / 60_000);
      }
      const booked = mine
        .filter((a) => !["CANCELLED", "NO_SHOW"].includes(a.status))
        .reduce((t, a) => t + storedLines(a.services).reduce((m, l) => m + lineBlock(l).durationMins, 0), 0);
      return {
        staffId: s.id,
        name: s.name,
        colour: s.colour,
        isActive: s.isActive,
        appointments: mine.filter((a) => !["CANCELLED"].includes(a.status)).length,
        completed: done.length,
        walkIns: done.filter((a) => a.source === "WALK_IN").length,
        noShows: mine.filter((a) => a.status === "NO_SHOW").length,
        cancelled: mine.filter((a) => a.status === "CANCELLED").length,
        takings,
        tips,
        commissionPercent: s.commissionPercent == null ? null : Number(s.commissionPercent),
        commission: commissionOn(takings, s.commissionPercent == null ? null : Number(s.commissionPercent)),
        averageTicket: done.length ? round2(takings / done.length) : 0,
        bookedMins: Math.round(booked),
        availableMins: Math.max(0, Math.round(available)),
        utilisation: available > 0 ? Math.min(1, booked / available) : 0,
        requested: done.filter((a) => !a.anyStaff && a.source === "ONLINE").length,
      };
    });

    const services = new Map<string, { name: string; count: number; takings: number }>();
    for (const a of appts.filter((x) => x.status === "COMPLETED")) {
      for (const l of storedLines(a.services)) {
        const k = l.name;
        const cur = services.get(k) ?? { name: k, count: 0, takings: 0 };
        cur.count += 1;
        cur.takings = round2(cur.takings + l.price + (l.addons ?? []).reduce((s, x) => s + Number(x.price || 0), 0));
        services.set(k, cur);
      }
    }
    const bySource: Record<string, number> = {};
    for (const a of appts.filter((x) => x.status !== "CANCELLED")) bySource[a.source] = (bySource[a.source] ?? 0) + 1;

    const byDay = days.map((d) => {
      const list = appts.filter((a) => wallDate(a.startsAt.getTime(), tz) === d);
      const done = list.filter((a) => a.status === "COMPLETED");
      return {
        date: d,
        appointments: list.filter((a) => a.status !== "CANCELLED").length,
        takings: round2(done.reduce((t, a) => t + Number(a.totalPrice), 0)),
      };
    });

    // New vs returning: a client is "new" if this is their first completed
    // visit at the shop (matched on phone, then email).
    const doneAll = appts.filter((a) => a.status === "COMPLETED");
    const keys = Array.from(new Set(doneAll.map((a) => a.customerPhone || a.customerEmail).filter(Boolean))) as string[];
    let newClients = 0;
    if (keys.length) {
      const earlier = await this.prisma.salonAppointment.findMany({
        where: {
          tenantId,
          locationId: loc.id,
          status: "COMPLETED",
          startsAt: { lt: new Date(fromMs) },
          OR: [{ customerPhone: { in: keys } }, { customerEmail: { in: keys } }],
        },
        select: { customerPhone: true, customerEmail: true },
      });
      const seen = new Set(earlier.flatMap((e) => [e.customerPhone, e.customerEmail]).filter(Boolean));
      newClients = keys.filter((k) => !seen.has(k)).length;
    }

    const totals = {
      appointments: appts.filter((a) => a.status !== "CANCELLED").length,
      completed: doneAll.length,
      takings: round2(perStaff.reduce((t, s) => t + s.takings, 0)),
      tips: round2(perStaff.reduce((t, s) => t + s.tips, 0)),
      commission: round2(perStaff.reduce((t, s) => t + s.commission, 0)),
      noShows: appts.filter((a) => a.status === "NO_SHOW").length,
      cancelled: appts.filter((a) => a.status === "CANCELLED").length,
      depositsHeld: round2(
        appts.filter((a) => a.depositStatus === "PAID").reduce((t, a) => t + Number(a.depositAmount), 0),
      ),
      depositsKept: round2(
        appts.filter((a) => a.depositStatus === "FORFEITED").reduce((t, a) => t + Number(a.depositAmount), 0),
      ),
      clients: keys.length,
      newClients,
      onlineShare: appts.length ? (bySource.ONLINE ?? 0) / Math.max(1, totals0(bySource)) : 0,
    };

    return {
      from: q.from,
      to: q.to,
      currency: loc.currency,
      trade: readSalonSettings(loc.settings).trade,
      totals,
      staff: perStaff.filter((s) => s.isActive || s.appointments > 0).sort((a, b) => b.takings - a.takings),
      services: Array.from(services.values()).sort((a, b) => b.takings - a.takings).slice(0, 20),
      bySource,
      byDay,
    };
  }
}

function totals0(m: Record<string, number>): number {
  return Object.values(m).reduce((s, n) => s + n, 0);
}
