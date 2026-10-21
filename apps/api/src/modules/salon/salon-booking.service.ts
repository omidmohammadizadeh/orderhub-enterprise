import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomBytes } from "crypto";
import {
  addDaysToDate,
  canStartAt,
  depositFor,
  lineBlock,
  linePrice,
  linesTotal,
  normaliseWeeklyHours,
  occupancy,
  staffDayWindows,
  teamFreeStarts,
  wallDate,
  zonedWallToUtc,
  type Interval,
  type StaffDay,
} from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";
import {
  APPOINTMENT_STATUSES,
  LIVE_APPOINTMENT_STATUSES,
  canMoveStatus,
  guestCanChange,
  makeSalonReference,
  readSalonSettings,
  type AppointmentStatus,
  type SalonSettings,
} from "./salon-settings";
import {
  buildLines,
  staffDoes,
  storedLines,
  summariseLines,
  type StoredLine,
  type WantedService,
} from "./salon-lines";
import { serviceOut, staffOut } from "./salon-catalog.service";
import { SalonNotifyService } from "./salon-notify.service";
import { SalonDepositService } from "./salon-deposit.service";

// Appointments: finding a free slot, holding it, moving it, and walking it
// through the visit (checked in → in the chair → paid).
//
// Two doors, like table reservations:
//   • staff (tenant-scoped JWT) — the diary; may squeeze someone in with
//     `force`, because barbers do.
//   • public (locationId only) — the booking page; never forced, and only
//     when the shop has online booking switched on.
//
// A booking is written under a per-staff advisory lock with the clash check
// repeated inside it, so two guests tapping 10:15 with Jay at the same
// moment can't both get it.

export interface BookInput {
  locationId: string;
  /** A staff id, or "any" / null for whoever is free (least booked first). */
  staffId?: string | null;
  startsAt: string;
  services: WantedService[];
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  notes?: string | null;
  staffNotes?: string | null;
  source?: string;
  /** Staff only: book even if it clashes or sits outside hours. */
  force?: boolean;
  /** Staff only: skip the guest confirmation email. */
  silent?: boolean;
  queueEntryId?: string | null;
}

const SOURCES = ["ONLINE", "STAFF", "PHONE", "WALK_IN", "WHATSAPP", "VOICE"];
const MIN = 60_000;

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

@Injectable()
export class SalonBookingService {
  private readonly logger = new Logger(SalonBookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
    private readonly notify: SalonNotifyService,
    private readonly deposits: SalonDepositService,
  ) {}

  // ── Loading ─────────────────────────────────────────────────────────

  async loadLocation(locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null },
      select: {
        id: true,
        name: true,
        timezone: true,
        currency: true,
        settings: true,
        businessType: true,
        openingHours: true,
        phone: true,
        logoUrl: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        postcode: true,
        about: true,
        latitude: true,
        longitude: true,
        googleReviewUrl: true,
        brand: { select: { tenantId: true, logoUrl: true, name: true } },
      },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return {
      ...loc,
      tenantId: loc.brand.tenantId,
      tz: loc.timezone || "Europe/London",
      salon: readSalonSettings(loc.settings),
      shopHours: normaliseWeeklyHours(loc.openingHours),
    };
  }

  private async assertTenantLocation(tenantId: string, locationId: string) {
    const loc = await this.loadLocation(locationId);
    if (loc.tenantId !== tenantId) throw new NotFoundException("Location not found");
    return loc;
  }

  /**
   * Every staff member's working windows and busy time for one shop day.
   * Busy = live appointments (with their buffer, minus any processing gap)
   * + time off.
   */
  async dayContext(opts: {
    locationId: string;
    date: string;
    tz: string;
    shopHours: ReturnType<typeof normaliseWeeklyHours>;
    staff: Array<{ id: string; weeklyHours: unknown }>;
    ignoreAppointmentId?: string;
  }): Promise<Map<string, StaffDay>> {
    const dayStart = zonedWallToUtc(opts.date, "00:00", opts.tz);
    const dayEnd = zonedWallToUtc(addDaysToDate(opts.date, 1), "00:00", opts.tz);
    const ids = opts.staff.map((s) => s.id);
    const [appts, offs] = await Promise.all([
      this.prisma.salonAppointment.findMany({
        where: {
          locationId: opts.locationId,
          staffId: { in: ids },
          status: { in: [...LIVE_APPOINTMENT_STATUSES] },
          startsAt: { lt: new Date(dayEnd + 12 * 3600_000) },
          endsAt: { gt: new Date(dayStart - 12 * 3600_000) },
          ...(opts.ignoreAppointmentId ? { id: { not: opts.ignoreAppointmentId } } : {}),
        },
        select: { id: true, staffId: true, startsAt: true, services: true },
      }),
      this.prisma.salonTimeOff.findMany({
        where: { staffId: { in: ids }, startsAt: { lt: new Date(dayEnd) }, endsAt: { gt: new Date(dayStart) } },
        select: { staffId: true, startsAt: true, endsAt: true },
      }),
    ]);
    const map = new Map<string, StaffDay>();
    for (const s of opts.staff) {
      map.set(s.id, {
        staffId: s.id,
        windows: staffDayWindows({
          staffHours: normaliseWeeklyHours(s.weeklyHours),
          shopHours: opts.shopHours,
          date: opts.date,
          tz: opts.tz,
        }),
        busy: [],
        bookedCount: 0,
      });
    }
    for (const a of appts) {
      const day = a.staffId ? map.get(a.staffId) : undefined;
      if (!day) continue;
      const occ = occupancy(a.startsAt.getTime(), storedLines(a.services).map(lineBlock));
      day.busy.push(...occ.busy);
      if (a.startsAt.getTime() >= dayStart && a.startsAt.getTime() < dayEnd) {
        day.bookedCount = (day.bookedCount ?? 0) + 1;
      }
    }
    for (const o of offs) {
      map.get(o.staffId)?.busy.push({ start: o.startsAt.getTime(), end: o.endsAt.getTime() });
    }
    return map;
  }

  private async servicesFor(locationId: string) {
    return this.prisma.salonService.findMany({ where: { locationId } });
  }

  private async staffFor(locationId: string, opts: { online: boolean }) {
    return this.prisma.salonStaff.findMany({
      where: { locationId, isActive: true, ...(opts.online ? { bookableOnline: true } : {}) },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  }

  // ── Availability ────────────────────────────────────────────────────

  /**
   * Free start times on one shop day for these services.
   * staffId = a person, or "any"/null for the whole (eligible) team.
   */
  async availability(opts: {
    locationId: string;
    date: string;
    services: WantedService[];
    staffId?: string | null;
    online: boolean;
    ignoreAppointmentId?: string;
    now?: number;
  }) {
    const loc = await this.loadLocation(opts.locationId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date ?? "")) throw new BadRequestException("Pick a day");
    const now = opts.now ?? Date.now();
    const services = await this.servicesFor(loc.id);
    let lines: StoredLine[];
    try {
      lines = buildLines({ wanted: opts.services, services, online: opts.online });
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
    const serviceIds = lines.map((l) => l.serviceId);
    const allStaff = await this.staffFor(loc.id, { online: opts.online });
    const wantAny = !opts.staffId || opts.staffId === "any";
    const eligible = allStaff.filter(
      (s) => staffDoes(s, serviceIds) && (wantAny || s.id === opts.staffId),
    );
    if (!wantAny && eligible.length === 0) {
      throw new BadRequestException("That team member doesn't do all of those services");
    }
    const ctx = await this.dayContext({
      locationId: loc.id,
      date: opts.date,
      tz: loc.tz,
      shopHours: loc.shopHours,
      staff: eligible,
      ignoreAppointmentId: opts.ignoreAppointmentId,
    });
    const blocks = lines.map(lineBlock);
    const notBefore = opts.online ? now + loc.salon.leadTimeMins * MIN : undefined;
    const notAfter = opts.online ? now + loc.salon.maxDaysAhead * 86_400_000 : undefined;
    const slots = teamFreeStarts({
      staff: Array.from(ctx.values()),
      blocks,
      stepMins: loc.salon.slotStepMins,
      notBefore,
      notAfter,
      tz: loc.tz,
    });
    // Someone the guest picked has their own price; "anyone" shows the list
    // price and the person's own price lands when they're assigned.
    const priceFor = (staffId: string | null) => {
      const s = staffId ? eligible.find((x) => x.id === staffId) : null;
      return linesTotal(buildLines({ wanted: opts.services, services, staff: s as any, online: false }));
    };
    return {
      date: opts.date,
      timezone: loc.tz,
      durationMins: blocks.reduce((s, b) => s + b.durationMins, 0),
      total: priceFor(wantAny ? null : (opts.staffId as string)),
      deposit: depositFor(lines),
      slots: slots.map((s) => ({
        startsAt: new Date(s.startMs).toISOString(),
        staffIds: s.staffIds,
      })),
    };
  }

  /** Days in a range that have at least one slot — the guest's date strip. */
  async availableDays(opts: {
    locationId: string;
    from: string;
    days: number;
    services: WantedService[];
    staffId?: string | null;
  }) {
    const out: Array<{ date: string; slots: number }> = [];
    const n = Math.min(31, Math.max(1, Math.round(opts.days || 14)));
    for (let i = 0; i < n; i++) {
      const date = addDaysToDate(opts.from, i);
      try {
        const a = await this.availability({ ...opts, date, online: true });
        out.push({ date, slots: a.slots.length });
      } catch (e) {
        if (i === 0) throw e;
        out.push({ date, slots: 0 });
      }
    }
    return { days: out };
  }

  // ── Booking ─────────────────────────────────────────────────────────

  private cleanContact(input: BookInput, online: boolean) {
    const customerName = String(input.customerName ?? "").trim().slice(0, 120);
    if (!customerName) throw new BadRequestException("Please enter a name");
    const customerPhone = String(input.customerPhone ?? "").trim().slice(0, 40) || null;
    const customerEmail = String(input.customerEmail ?? "").trim().toLowerCase().slice(0, 200) || null;
    if (customerEmail && !isEmail(customerEmail)) throw new BadRequestException("That email address doesn't look right");
    if (online && !customerPhone) throw new BadRequestException("Please enter a phone number so the shop can reach you");
    if (online && !customerEmail) throw new BadRequestException("Please enter an email address for your confirmation");
    return { customerName, customerPhone, customerEmail };
  }

  /**
   * Make an appointment. Shared by the diary, the booking page, the walk-in
   * queue, and the phone/WhatsApp channels.
   */
  async book(
    input: BookInput,
    opts: { tenantId?: string; online: boolean; actorUserId?: string | null },
  ) {
    const loc = opts.tenantId
      ? await this.assertTenantLocation(opts.tenantId, input.locationId)
      : await this.loadLocation(input.locationId);
    if (opts.online && (!loc.salon.onlineBookingEnabled || loc.businessType !== "SALON")) {
      throw new BadRequestException("This shop isn't taking online bookings right now");
    }
    const force = !opts.online && input.force === true;
    const contact = this.cleanContact(input, opts.online);
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) throw new BadRequestException("Pick a time");
    const now = Date.now();
    if (opts.online) {
      if (startsAt.getTime() < now + loc.salon.leadTimeMins * MIN) {
        throw new BadRequestException("That time is too soon to book online — pick a later slot");
      }
      if (startsAt.getTime() > now + loc.salon.maxDaysAhead * 86_400_000) {
        throw new BadRequestException("That's further ahead than the shop takes bookings");
      }
    }

    const services = await this.servicesFor(loc.id);
    let probe: StoredLine[];
    try {
      probe = buildLines({ wanted: input.services, services, online: opts.online });
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
    const serviceIds = probe.map((l) => l.serviceId);
    const team = await this.staffFor(loc.id, { online: opts.online });
    const date = wallDate(startsAt.getTime(), loc.tz);

    // Who? A named person, or the quietest person free at that time.
    const wantAny = !input.staffId || input.staffId === "any";
    let candidates = team.filter((s) => (wantAny || s.id === input.staffId) && (force || staffDoes(s, serviceIds)));
    if (!wantAny && candidates.length === 0) {
      // Staff may book an archived/offline member only by naming them.
      const named = !opts.online
        ? await this.prisma.salonStaff.findFirst({ where: { id: String(input.staffId), locationId: loc.id } })
        : null;
      if (!named) throw new BadRequestException("That team member can't take this booking");
      candidates = [named];
    }
    if (candidates.length === 0) throw new BadRequestException("Nobody here does all of those services");

    const ctx = await this.dayContext({
      locationId: loc.id,
      date,
      tz: loc.tz,
      shopHours: loc.shopHours,
      staff: candidates,
    });
    const blocks = probe.map(lineBlock);
    const ordered = candidates
      .slice()
      .sort((a, b) => (ctx.get(a.id)?.bookedCount ?? 0) - (ctx.get(b.id)?.bookedCount ?? 0));

    for (const staff of ordered) {
      const day = ctx.get(staff.id)!;
      if (!force && !canStartAt({ startMs: startsAt.getTime(), windows: day.windows, busy: day.busy, blocks })) {
        continue;
      }
      const lines = buildLines({ wanted: input.services, services, staff: staff as any, online: opts.online });
      const created = await this.writeUnderLock({
        loc,
        staff,
        startsAt,
        lines,
        contact,
        input,
        force,
        online: opts.online,
        anyStaff: wantAny,
      });
      if (!created) continue; // someone beat us to it inside the lock
      await this.afterCreate(created, { online: opts.online, silent: input.silent === true });
      return created;
    }
    throw new BadRequestException(
      wantAny
        ? "Sorry — that time has just gone. Please pick another."
        : "Sorry — that time isn't free with them any more. Please pick another.",
    );
  }

  private async writeUnderLock(args: {
    loc: Awaited<ReturnType<SalonBookingService["loadLocation"]>>;
    staff: { id: string; name: string; weeklyHours: unknown };
    startsAt: Date;
    lines: StoredLine[];
    contact: { customerName: string; customerPhone: string | null; customerEmail: string | null };
    input: BookInput;
    force: boolean;
    online: boolean;
    anyStaff: boolean;
  }) {
    const { loc, staff, startsAt, lines, contact, input } = args;
    const blocks = lines.map(lineBlock);
    const occ = occupancy(startsAt.getTime(), blocks);
    const deposit = args.online ? depositFor(lines) : 0;
    const source = SOURCES.includes(String(input.source ?? "").toUpperCase())
      ? String(input.source).toUpperCase()
      : args.online
        ? "ONLINE"
        : "STAFF";

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `salon-staff:${staff.id}`);
      if (!args.force) {
        const clash = await tx.salonAppointment.findMany({
          where: {
            staffId: staff.id,
            status: { in: [...LIVE_APPOINTMENT_STATUSES] },
            startsAt: { lt: new Date(occ.endMs + 12 * 3600_000) },
            endsAt: { gt: new Date(startsAt.getTime() - 12 * 3600_000) },
          },
          select: { startsAt: true, services: true },
        });
        const offs = await tx.salonTimeOff.findMany({
          where: { staffId: staff.id, startsAt: { lt: new Date(occ.endMs + 3600_000) }, endsAt: { gt: startsAt } },
          select: { startsAt: true, endsAt: true },
        });
        const busy: Interval[] = [
          ...clash.flatMap((c) => occupancy(c.startsAt.getTime(), storedLines(c.services).map(lineBlock)).busy),
          ...offs.map((o) => ({ start: o.startsAt.getTime(), end: o.endsAt.getTime() })),
        ];
        const windows = staffDayWindows({
          staffHours: normaliseWeeklyHours(staff.weeklyHours),
          shopHours: loc.shopHours,
          date: wallDate(startsAt.getTime(), loc.tz),
          tz: loc.tz,
        });
        if (!canStartAt({ startMs: startsAt.getTime(), windows, busy, blocks })) return null;
      }
      let reference = makeSalonReference();
      for (let i = 0; i < 5; i++) {
        const taken = await tx.salonAppointment.findUnique({ where: { reference }, select: { id: true } });
        if (!taken) break;
        reference = makeSalonReference();
      }
      return tx.salonAppointment.create({
        data: {
          tenantId: loc.tenantId,
          locationId: loc.id,
          staffId: staff.id,
          customerName: contact.customerName,
          customerPhone: contact.customerPhone,
          customerEmail: contact.customerEmail,
          startsAt,
          endsAt: new Date(occ.endMs),
          status: deposit > 0 ? "PENDING_PAYMENT" : "CONFIRMED",
          source,
          anyStaff: args.anyStaff,
          services: lines as any,
          totalPrice: linesTotal(lines),
          notes: input.notes ? String(input.notes).slice(0, 1000) : null,
          staffNotes: !args.online && input.staffNotes ? String(input.staffNotes).slice(0, 1000) : null,
          reference,
          manageToken: randomBytes(18).toString("base64url"),
          depositAmount: deposit,
          depositStatus: deposit > 0 ? "PENDING" : "NONE",
          queueEntryId: args.online ? null : (input.queueEntryId ?? null),
        },
      });
    });
  }

  private async afterCreate(appt: { id: string; locationId: string; status: string; customerEmail: string | null }, opts: { online: boolean; silent: boolean }) {
    this.emit(appt.locationId, "created", appt.id);
    // A deposit booking is confirmed (and emailed) once the card clears.
    if (appt.status === "CONFIRMED" && !opts.silent) this.notify.appointment("confirmed", appt.id);
    // A deposit booking beeps when the deposit clears (SalonDepositService).
    if (opts.online && appt.status === "CONFIRMED") void this.alertGuest("NEW_APPOINTMENT", appt.id).catch(() => undefined);
  }

  /** Public booking: book, then send them to pay the deposit if there is one. */
  async bookOnline(input: BookInput) {
    // Only what a guest may choose. Never trust internal fields from the
    // public door (queue links, silent, staff notes, force).
    const guest: BookInput = {
      locationId: input.locationId,
      staffId: input.staffId,
      startsAt: input.startsAt,
      services: input.services,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      customerEmail: input.customerEmail,
      notes: input.notes,
      source: "ONLINE",
      force: false,
    };
    const appt = await this.book(guest, { online: true });
    if (appt.status !== "PENDING_PAYMENT") {
      return { appointment: await this.publicView(appt.manageToken), checkoutUrl: null };
    }
    try {
      const { url } = await this.deposits.start(appt.id);
      return { appointment: await this.publicView(appt.manageToken), checkoutUrl: url };
    } catch (e: any) {
      // The shop asked for a deposit but can't take cards online yet. The
      // guest still gets their slot — losing the booking is worse for the
      // shop than losing the deposit — and the diary says why.
      this.logger.warn(`Deposit for ${appt.id} couldn't start: ${e?.message}`);
      await this.prisma.salonAppointment.update({
        where: { id: appt.id },
        data: {
          status: "CONFIRMED",
          depositStatus: "NONE",
          depositAmount: 0,
          staffNotes: "Deposit not taken — card payments aren't set up for online bookings yet.",
        },
      });
      this.notify.appointment("confirmed", appt.id);
      this.emit(appt.locationId, "updated", appt.id);
      void this.alertGuest("NEW_APPOINTMENT", appt.id).catch(() => undefined);
      return { appointment: await this.publicView(appt.manageToken), checkoutUrl: null };
    }
  }

  // ── Diary ───────────────────────────────────────────────────────────

  async list(tenantId: string, q: { locationId: string; from?: string; to?: string; staffId?: string }) {
    await this.assertTenantLocation(tenantId, q.locationId);
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 86_400_000);
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + 2 * 86_400_000);
    if (to.getTime() - from.getTime() > 45 * 86_400_000) throw new BadRequestException("Ask for at most 45 days");
    const rows = await this.prisma.salonAppointment.findMany({
      where: {
        tenantId,
        locationId: q.locationId,
        startsAt: { gte: from, lt: to },
        ...(q.staffId ? { staffId: q.staffId } : {}),
      },
      orderBy: { startsAt: "asc" },
      include: { staff: { select: { id: true, name: true, colour: true } } },
    });
    return rows.map(appointmentOut);
  }

  async get(tenantId: string, id: string) {
    const row = await this.prisma.salonAppointment.findFirst({
      where: { id, tenantId },
      include: { staff: { select: { id: true, name: true, colour: true, commissionPercent: true } } },
    });
    if (!row) throw new NotFoundException("Appointment not found");
    const history = await this.clientHistory(tenantId, row.locationId, {
      phone: row.customerPhone,
      email: row.customerEmail,
      excludeId: row.id,
    });
    const order = row.orderId
      ? await this.prisma.order.findUnique({
          where: { id: row.orderId },
          select: { id: true, orderNumber: true, total: true, paymentStatus: true, paymentMethod: true, status: true },
        })
      : null;
    return { ...appointmentOut(row), history, order: order ? { ...order, total: Number(order.total) } : null };
  }

  /** Past visits for the same phone or email at this shop. */
  async clientHistory(
    tenantId: string,
    locationId: string,
    who: { phone?: string | null; email?: string | null; excludeId?: string },
  ) {
    const or: any[] = [];
    if (who.phone) or.push({ customerPhone: who.phone });
    if (who.email) or.push({ customerEmail: who.email });
    if (!or.length) return { visits: 0, noShows: 0, spent: 0, last: null, recent: [] };
    const rows = await this.prisma.salonAppointment.findMany({
      where: { tenantId, locationId, OR: or, ...(who.excludeId ? { id: { not: who.excludeId } } : {}) },
      orderBy: { startsAt: "desc" },
      take: 50,
      include: { staff: { select: { name: true } } },
    });
    const done = rows.filter((r) => r.status === "COMPLETED");
    return {
      visits: done.length,
      noShows: rows.filter((r) => r.status === "NO_SHOW").length,
      spent: done.reduce((s, r) => s + Number(r.totalPrice), 0),
      last: done[0] ? { startsAt: done[0].startsAt, staffName: done[0].staff?.name ?? null, summary: summariseLines(storedLines(done[0].services)) } : null,
      recent: rows.slice(0, 8).map((r) => ({
        id: r.id,
        startsAt: r.startsAt,
        status: r.status,
        staffName: r.staff?.name ?? null,
        summary: summariseLines(storedLines(r.services)),
        totalPrice: Number(r.totalPrice),
      })),
    };
  }

  /** Clients search for the "new appointment" form. */
  async searchClients(tenantId: string, locationId: string, q: string) {
    await this.assertTenantLocation(tenantId, locationId);
    const term = String(q ?? "").trim();
    if (term.length < 2) return [];
    const rows = await this.prisma.salonAppointment.findMany({
      where: {
        tenantId,
        locationId,
        OR: [
          { customerName: { contains: term, mode: "insensitive" } },
          { customerPhone: { contains: term.replace(/\s+/g, "") } },
          { customerEmail: { contains: term, mode: "insensitive" } },
        ],
      },
      orderBy: { startsAt: "desc" },
      take: 60,
      select: { customerName: true, customerPhone: true, customerEmail: true, startsAt: true },
    });
    const seen = new Map<string, { name: string; phone: string | null; email: string | null; lastVisit: Date }>();
    for (const r of rows) {
      const key = clientKey(r.customerPhone, r.customerEmail, r.customerName);
      if (!seen.has(key)) {
        seen.set(key, { name: r.customerName, phone: r.customerPhone, email: r.customerEmail, lastVisit: r.startsAt });
      }
    }
    // The business's customer list too — clients brought across from the
    // old system, and anyone who has ordered — so a regular is findable
    // before their first booking here.
    if (seen.size < 10) {
      const digits = term.replace(/\D/g, "");
      const words = term.split(/\s+/).filter(Boolean);
      const crm = await this.prisma.customer.findMany({
        where: {
          tenantId,
          isActive: true,
          OR: [
            ...words.flatMap((w) => [
              { firstName: { contains: w, mode: "insensitive" as const } },
              { lastName: { contains: w, mode: "insensitive" as const } },
            ]),
            { email: { contains: term, mode: "insensitive" as const } },
            ...(digits.length >= 4 ? [{ phone: { contains: digits.replace(/^0/, "") } }] : []),
          ],
        },
        take: 10,
        orderBy: { updatedAt: "desc" },
        select: { firstName: true, lastName: true, phone: true, email: true, updatedAt: true },
      });
      for (const c of crm) {
        const key = clientKey(c.phone, c.email, `${c.firstName} ${c.lastName}`);
        if (seen.has(key)) continue;
        const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
        if (!name) continue;
        seen.set(key, { name, phone: c.phone, email: c.email, lastVisit: c.updatedAt });
      }
    }
    return Array.from(seen.values()).slice(0, 10);
  }

  /**
   * Move / edit. Time, person, services, contact, notes. Clash-checked
   * unless forced. The guest hears about a change of time or person.
   */
  async update(
    tenantId: string,
    id: string,
    patch: {
      startsAt?: string;
      staffId?: string;
      services?: WantedService[];
      customerName?: string;
      customerPhone?: string | null;
      customerEmail?: string | null;
      notes?: string | null;
      staffNotes?: string | null;
      force?: boolean;
      notifyGuest?: boolean;
    },
  ) {
    const row = await this.prisma.salonAppointment.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Appointment not found");
    if (["COMPLETED", "CANCELLED", "NO_SHOW"].includes(row.status) && (patch.startsAt || patch.staffId || patch.services)) {
      throw new BadRequestException("This appointment is closed — book a new one instead");
    }
    const loc = await this.loadLocation(row.locationId);
    const startsAt = patch.startsAt ? new Date(patch.startsAt) : row.startsAt;
    if (Number.isNaN(startsAt.getTime())) throw new BadRequestException("Pick a time");
    const staffId = patch.staffId ?? row.staffId;
    if (!staffId) throw new BadRequestException("Pick who it's with");
    const staff = await this.prisma.salonStaff.findFirst({ where: { id: staffId, locationId: row.locationId } });
    if (!staff) throw new BadRequestException("Team member not found");

    let lines = storedLines(row.services);
    if (patch.services) {
      const services = await this.servicesFor(row.locationId);
      try {
        lines = buildLines({ wanted: patch.services, services, staff: staff as any, online: false });
      } catch (e: any) {
        throw new BadRequestException(e.message);
      }
    } else if (patch.staffId && patch.staffId !== row.staffId) {
      // Someone else's prices apply to the same services.
      const services = await this.servicesFor(row.locationId);
      try {
        lines = buildLines({
          wanted: lines.map((l) => ({ serviceId: l.serviceId, addonIds: (l.addons ?? []).map((a) => a.id) })),
          services,
          staff: staff as any,
          online: false,
        });
      } catch {
        // A service that has since been deleted keeps its old line.
      }
    }
    const blocks = lines.map(lineBlock);
    const timeChanged = startsAt.getTime() !== row.startsAt.getTime() || staffId !== row.staffId || !!patch.services;

    const occ = occupancy(startsAt.getTime(), blocks);
    const data: Record<string, unknown> = {
      startsAt,
      endsAt: new Date(occ.endMs),
      staffId,
      services: lines as any,
      totalPrice: linesTotal(lines),
    };
    if (patch.customerName !== undefined) {
      const n = String(patch.customerName).trim();
      if (!n) throw new BadRequestException("Please enter a name");
      data.customerName = n.slice(0, 120);
    }
    if (patch.customerPhone !== undefined) data.customerPhone = patch.customerPhone ? String(patch.customerPhone).trim().slice(0, 40) : null;
    if (patch.customerEmail !== undefined) {
      const e = patch.customerEmail ? String(patch.customerEmail).trim().toLowerCase() : "";
      if (e && !isEmail(e)) throw new BadRequestException("That email address doesn't look right");
      data.customerEmail = e || null;
    }
    if (patch.notes !== undefined) data.notes = patch.notes ? String(patch.notes).slice(0, 1000) : null;
    if (patch.staffNotes !== undefined) data.staffNotes = patch.staffNotes ? String(patch.staffNotes).slice(0, 1000) : null;
    if (patch.staffId && patch.staffId !== row.staffId) data.anyStaff = false;
    // A moved appointment gets a fresh reminder.
    if (startsAt.getTime() !== row.startsAt.getTime()) data.reminderSentAt = null;

    // The clash check and the write happen under the same per-staff lock as
    // a new booking, so a move can't race an online guest into the slot.
    const updated = await this.prisma.$transaction(async (tx) => {
      if (timeChanged && !patch.force) {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `salon-staff:${staff.id}`);
        const ctx = await this.dayContext({
          locationId: row.locationId,
          date: wallDate(startsAt.getTime(), loc.tz),
          tz: loc.tz,
          shopHours: loc.shopHours,
          staff: [staff],
          ignoreAppointmentId: row.id,
        });
        const day = ctx.get(staff.id)!;
        if (!canStartAt({ startMs: startsAt.getTime(), windows: day.windows, busy: day.busy, blocks })) {
          throw new BadRequestException(`${staff.name} isn't free then — pick another time, or tick "book it anyway"`);
        }
      }
      return tx.salonAppointment.update({ where: { id }, data: data as any });
    });
    this.emit(row.locationId, "updated", id);
    const guestVisible = startsAt.getTime() !== row.startsAt.getTime() || staffId !== row.staffId;
    if (guestVisible && patch.notifyGuest !== false && ["CONFIRMED", "CHECKED_IN"].includes(updated.status)) {
      this.notify.appointment("updated", id);
    }
    return this.get(tenantId, id);
  }

  /**
   * Status changes from the diary. Cancel refunds a paid deposit unless
   * told to keep it; a no-show keeps it when the shop's policy says so.
   */
  async setStatus(
    tenantId: string,
    id: string,
    body: { status: string; reason?: string; refundDeposit?: boolean; notifyGuest?: boolean },
  ) {
    const row = await this.prisma.salonAppointment.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Appointment not found");
    const to = String(body.status ?? "").toUpperCase() as AppointmentStatus;
    if (!(APPOINTMENT_STATUSES as readonly string[]).includes(to)) throw new BadRequestException("Unknown status");
    if (!canMoveStatus(row.status, to)) {
      throw new BadRequestException(`Can't go from ${label(row.status)} to ${label(to)}`);
    }
    if (to === "COMPLETED" && Number(row.totalPrice) > 0) {
      const bill = row.orderId
        ? await this.prisma.order.findUnique({ where: { id: row.orderId }, select: { paymentStatus: true } })
        : null;
      if (bill?.paymentStatus !== "PAID") {
        throw new BadRequestException("Take payment with Checkout — that marks it done");
      }
    }
    const loc = await this.loadLocation(row.locationId);
    const now = new Date();
    const data: Record<string, unknown> = { status: to };
    if (to === "CHECKED_IN") data.checkedInAt = row.checkedInAt ?? now;
    if (to === "IN_SERVICE") data.startedAt = row.startedAt ?? now;
    if (to === "COMPLETED") data.completedAt = now;
    if (to === "CANCELLED") {
      data.cancelledAt = now;
      data.cancelReason = body.reason ? String(body.reason).slice(0, 300) : "Cancelled by the shop";
    }
    if (to === "CONFIRMED" && (row.status === "CANCELLED" || row.status === "NO_SHOW")) {
      // Re-instating: make sure the time is still free.
      const staff = row.staffId ? await this.prisma.salonStaff.findUnique({ where: { id: row.staffId } }) : null;
      if (staff) {
        const ctx = await this.dayContext({
          locationId: row.locationId,
          date: wallDate(row.startsAt.getTime(), loc.tz),
          tz: loc.tz,
          shopHours: loc.shopHours,
          staff: [staff],
          ignoreAppointmentId: row.id,
        });
        const day = ctx.get(staff.id)!;
        const busy = day.busy;
        const occ = occupancy(row.startsAt.getTime(), storedLines(row.services).map(lineBlock));
        if (busy.some((b) => occ.busy.some((n) => n.start < b.end && b.start < n.end))) {
          throw new BadRequestException("That time has been taken since — move it instead");
        }
      }
      data.cancelledAt = null;
      data.cancelReason = null;
      // Undoing a no-show / kept-deposit cancel gives the deposit back to the
      // booking, or checkout would charge it twice.
      if (row.depositStatus === "FORFEITED") data.depositStatus = "PAID";
    }
    const updated = await this.prisma.salonAppointment.update({ where: { id }, data: data as any });

    // Deposit consequences.
    if (row.depositStatus === "PAID") {
      if (to === "CANCELLED" && body.refundDeposit !== false) {
        await this.deposits.refund(row.id, "Cancelled by the shop");
      } else if (to === "CANCELLED" || (to === "NO_SHOW" && loc.salon.forfeitDepositOnNoShow)) {
        await this.prisma.salonAppointment.update({ where: { id }, data: { depositStatus: "FORFEITED" } });
      } else if (to === "NO_SHOW") {
        // The shop doesn't keep deposits for no-shows: give it back.
        await this.deposits.refund(row.id, "No-show — shop doesn't keep deposits");
      }
    }
    // A bill started at checkout and never paid is closed with the visit,
    // so a payment link sent earlier can't be paid for a cancelled visit.
    if ((to === "CANCELLED" || to === "NO_SHOW") && row.orderId) {
      await this.prisma.order.updateMany({
        where: { id: row.orderId, paymentStatus: { not: "PAID" }, status: { not: "CANCELLED" } },
        data: { status: "CANCELLED" },
      });
    }
    if (to === "CANCELLED" && body.notifyGuest !== false) this.notify.appointment("cancelled", id);
    // The walk-in it came from moves with it.
    if (row.queueEntryId && (to === "CANCELLED" || to === "NO_SHOW")) {
      await this.prisma.salonQueueEntry.updateMany({
        where: { id: row.queueEntryId, locationId: row.locationId, status: { in: ["CALLED", "IN_SERVICE"] } },
        data: { status: "LEFT", finishedAt: now },
      });
    }
    this.emit(row.locationId, "updated", id);
    return this.get(tenantId, updated.id);
  }

  async resend(tenantId: string, id: string) {
    const row = await this.prisma.salonAppointment.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Appointment not found");
    if (!row.customerEmail) throw new BadRequestException("No email address on this booking");
    const ok = await this.notify.appointmentNow("confirmed", id);
    return { sent: ok };
  }

  // ── Guest self-service (manage link) ───────────────────────────────

  private async byToken(token: string) {
    const row = await this.prisma.salonAppointment.findUnique({
      where: { manageToken: String(token ?? "") },
      include: { staff: { select: { id: true, name: true, avatarUrl: true } } },
    });
    if (!row) throw new NotFoundException("Booking not found");
    return row;
  }

  /** What the guest sees on their manage page — nothing staff-only. */
  async publicView(token: string) {
    let row = await this.byToken(token);
    if (row.status === "PENDING_PAYMENT") {
      // Back from Stripe before the webhook landed: check the deposit order.
      await this.deposits.sync(row.id);
      row = await this.byToken(token);
    }
    const loc = await this.loadLocation(row.locationId);
    const change = guestCanChange(loc.salon, row.startsAt);
    const lines = storedLines(row.services);
    return {
      reference: row.reference,
      token: row.manageToken,
      status: row.status,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      staff: row.staff ? { id: row.staff.id, name: row.staff.name, avatarUrl: row.staff.avatarUrl } : null,
      // The line's price with its extras, so the lines add up to the total.
      services: lines.map((l) => ({ name: l.name, price: linePrice(l), priceFrom: !!l.priceFrom, durationMins: lineBlock(l).durationMins, addons: (l.addons ?? []).map((a) => a.name) })),
      summary: summariseLines(lines),
      totalPrice: Number(row.totalPrice),
      depositAmount: Number(row.depositAmount),
      depositStatus: row.depositStatus,
      customerName: row.customerName,
      notes: row.notes,
      patchTest: lines.some((l) => l.requiresPatchTest),
      canChange: change.allowed && ["CONFIRMED", "PENDING_PAYMENT"].includes(row.status),
      freeChange: change.free,
      cancellationWindowHours: loc.salon.cancellationWindowHours,
      loyalty: await this.loyaltyFor(loc.id).catch(() => null),
      shop: {
        locationId: loc.id,
        name: loc.name,
        phone: loc.phone,
        timezone: loc.tz,
        currency: loc.currency,
        logoUrl: loc.logoUrl ?? loc.brand.logoUrl ?? null,
        address: [loc.addressLine1, loc.city, loc.postcode].filter(Boolean).join(", ") || null,
        trade: loc.salon.trade,
      },
    };
  }

  async cancelByGuest(token: string) {
    const row = await this.byToken(token);
    const loc = await this.loadLocation(row.locationId);
    const change = guestCanChange(loc.salon, row.startsAt);
    if (!change.allowed || !["CONFIRMED", "PENDING_PAYMENT"].includes(row.status)) {
      throw new BadRequestException("This booking can't be cancelled online — please call the shop");
    }
    await this.prisma.salonAppointment.update({
      where: { id: row.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "Cancelled by the guest" },
    });
    if (row.depositStatus === "PAID") {
      if (change.free) await this.deposits.refund(row.id, "Cancelled by the guest in time");
      else await this.prisma.salonAppointment.update({ where: { id: row.id }, data: { depositStatus: "FORFEITED" } });
    } else if (row.depositStatus === "PENDING") {
      await this.prisma.salonAppointment.update({ where: { id: row.id }, data: { depositStatus: "EXPIRED" } });
      if (row.depositOrderId) {
        await this.prisma.order.updateMany({
          where: { id: row.depositOrderId, paymentStatus: { not: "PAID" }, status: "PENDING" },
          data: { status: "CANCELLED" },
        });
      }
    }
    this.notify.appointment("cancelled", row.id);
    this.emit(row.locationId, "updated", row.id);
    if (row.status === "CONFIRMED") void this.alertGuest("APPOINTMENT_CANCELLED", row.id).catch(() => undefined);
    return this.publicView(token);
  }

  /** Guest moves their own booking — same person, same services, new time. */
  async rescheduleByGuest(token: string, body: { startsAt: string; staffId?: string | null }) {
    const row = await this.byToken(token);
    const loc = await this.loadLocation(row.locationId);
    const change = guestCanChange(loc.salon, row.startsAt);
    if (!change.allowed || !change.free || row.status !== "CONFIRMED") {
      throw new BadRequestException(
        `Bookings can only be moved online up to ${loc.salon.cancellationWindowHours} hours before — please call the shop`,
      );
    }
    const startsAt = new Date(body.startsAt);
    if (Number.isNaN(startsAt.getTime())) throw new BadRequestException("Pick a time");
    if (startsAt.getTime() < Date.now() + loc.salon.leadTimeMins * MIN) {
      throw new BadRequestException("That time is too soon — pick a later slot");
    }
    // Same person, same services, same price — only the time moves. A guest
    // changing who it's with goes through a fresh booking (prices and who
    // does what differ per person).
    const staff = row.staffId
      ? await this.prisma.salonStaff.findFirst({ where: { id: row.staffId, locationId: row.locationId, isActive: true } })
      : null;
    if (!staff) throw new BadRequestException("Please call the shop to move this booking");
    const lines = storedLines(row.services);
    const blocks = lines.map(lineBlock);
    const ok = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `salon-staff:${staff.id}`);
      const ctx = await this.dayContext({
        locationId: row.locationId,
        date: wallDate(startsAt.getTime(), loc.tz),
        tz: loc.tz,
        shopHours: loc.shopHours,
        staff: [staff],
        ignoreAppointmentId: row.id,
      });
      const day = ctx.get(staff.id)!;
      if (!canStartAt({ startMs: startsAt.getTime(), windows: day.windows, busy: day.busy, blocks })) return false;
      const occ = occupancy(startsAt.getTime(), blocks);
      await tx.salonAppointment.update({
        where: { id: row.id },
        data: { startsAt, endsAt: new Date(occ.endMs), staffId: staff.id, reminderSentAt: null },
      });
      return true;
    });
    if (!ok) throw new BadRequestException("Sorry — that time has just gone. Please pick another.");
    this.notify.appointment("updated", row.id);
    this.emit(row.locationId, "updated", row.id);
    return this.publicView(token);
  }

  /** Free slots for the guest moving their own booking. */
  async guestRescheduleSlots(token: string, date: string) {
    const row = await this.byToken(token);
    const lines = storedLines(row.services);
    return this.availability({
      locationId: row.locationId,
      date,
      services: lines.map((l) => ({ serviceId: l.serviceId, addonIds: (l.addons ?? []).map((a) => a.id) })),
      staffId: row.staffId,
      online: true,
      ignoreAppointmentId: row.id,
    });
  }

  /**
   * The shop's in-store loyalty card, if it runs one: what a guest needs to
   * join from their booking (stamps needed, the reward, the join link).
   */
  async loyaltyFor(locationId: string) {
    const card = await this.prisma.loyaltyCard.findUnique({
      where: { locationId },
      select: { isActive: true, walkInEnabled: true, stampsRequired: true, rewardLabel: true, stampIcon: true, cardColor: true },
    });
    if (!card?.isActive || !card.walkInEnabled) return null;
    const loc = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { onlineOrderingSlug: true, slug: true },
    });
    return {
      stampsRequired: card.stampsRequired,
      rewardLabel: card.rewardLabel,
      stampIcon: card.stampIcon,
      cardColor: card.cardColor,
      joinUrl: `${this.notify.webUrl()}/loyalty/join/${loc?.onlineOrderingSlug ?? loc?.slug ?? locationId}`,
    };
  }

  // ── Public shop info ────────────────────────────────────────────────

  async publicShop(locationId: string) {
    const loc = await this.loadLocation(locationId);
    const isSalon = loc.businessType === "SALON";
    const enabled = isSalon && loc.salon.onlineBookingEnabled;
    // The page (price list, team, hours, map) shows for every salon; only
    // the booking buttons depend on online booking being switched on.
    const [services, staff] = isSalon
      ? await Promise.all([
          this.prisma.salonService.findMany({
            where: { locationId, isActive: true, bookableOnline: true },
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          }),
          this.staffFor(locationId, { online: true }),
        ])
      : [[], []];
    return {
      locationId: loc.id,
      name: loc.name,
      phone: loc.phone,
      timezone: loc.tz,
      currency: loc.currency,
      logoUrl: loc.logoUrl ?? loc.brand.logoUrl ?? null,
      address: [loc.addressLine1, loc.city, loc.postcode].filter(Boolean).join(", ") || null,
      onlineBookingEnabled: enabled,
      queueOnlineJoin: loc.businessType === "SALON" && loc.salon.queueEnabled && loc.salon.queueOnlineJoin,
      trade: loc.salon.trade,
      bookingPolicy: loc.salon.bookingPolicy,
      cancellationWindowHours: loc.salon.cancellationWindowHours,
      offerAnyStaff: loc.salon.offerAnyStaff,
      loyalty: isSalon ? await this.loyaltyFor(loc.id).catch(() => null) : null,
      // ── The shop's page ──
      about: loc.salon.about || loc.about || null,
      coverImageUrl: loc.salon.coverImageUrl,
      gallery: loc.salon.gallery,
      instagram: loc.salon.instagram || null,
      googleReviewUrl: loc.googleReviewUrl ?? null,
      addressLines: [loc.addressLine1, loc.addressLine2, [loc.city, loc.postcode].filter(Boolean).join(" ")]
        .map((x) => (x ?? "").trim())
        .filter(Boolean),
      latitude: loc.latitude ?? null,
      longitude: loc.longitude ?? null,
      hours: weekHoursFor(loc.shopHours, staff),
      leadTimeMins: loc.salon.leadTimeMins,
      maxDaysAhead: loc.salon.maxDaysAhead,
      services: services.map((s) => {
        const o = serviceOut(s);
        return {
          id: o.id,
          category: o.category,
          name: o.name,
          description: o.description,
          price: o.price,
          priceFrom: o.priceFrom,
          durationMins: o.durationMins,
          imageUrl: o.imageUrl,
          requiresPatchTest: o.requiresPatchTest,
          depositType: o.depositType,
          depositValue: o.depositValue,
          addons: o.addons,
        };
      }),
      staff: staff.map((s) => {
        const o = staffOut(s);
        return {
          id: o.id,
          name: o.name,
          title: o.title,
          bio: o.bio,
          avatarUrl: o.avatarUrl,
          serviceIds: o.serviceIds,
          priceOverrides: o.priceOverrides,
        };
      }),
    };
  }

  /**
   * Make the tills beep: a guest booked or cancelled on their own. Staff
   * bookings stay quiet — whoever made them already knows. Plays through
   * the same Alerts rules (sound, repeats) as a new order.
   */
  async alertGuest(trigger: "NEW_APPOINTMENT" | "APPOINTMENT_CANCELLED", appointmentId: string) {
    const a = await this.prisma.salonAppointment.findUnique({
      where: { id: appointmentId },
      select: { locationId: true, customerName: true, startsAt: true, services: true, staff: { select: { name: true } } },
    });
    if (!a) return;
    this.socket.emitToLocation(a.locationId, "salon:alert" as any, {
      trigger,
      locationId: a.locationId,
      appointmentId,
      customerName: a.customerName,
      startsAt: a.startsAt.toISOString(),
      summary: summariseLines(storedLines(a.services)),
      staffName: a.staff?.name ?? null,
    } as any);
  }

  emit(locationId: string, kind: string, appointmentId: string) {
    this.socket.emitToLocation(locationId, "salon:changed" as any, { kind, appointmentId } as any);
  }
}

/**
 * The hours to show guests: the shop's own when set, otherwise the span the
 * team works each day (earliest start to latest finish), otherwise none.
 */
function weekHoursFor(
  shopHours: ReturnType<typeof normaliseWeeklyHours>,
  staff: Array<{ weeklyHours: unknown }>,
): Record<string, Array<{ from: string; to: string }>> {
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
  const out: Record<string, Array<{ from: string; to: string }>> = {};
  const shopSet = days.some((d) => (shopHours[d]?.length ?? 0) > 0);
  if (shopSet) {
    for (const d of days) out[d] = shopHours[d] ?? [];
    return out;
  }
  const team = staff.map((s) => normaliseWeeklyHours(s.weeklyHours));
  if (!team.some((h) => days.some((d) => (h[d]?.length ?? 0) > 0))) return out;
  for (const d of days) {
    const slots = team.flatMap((h) => h[d] ?? []);
    if (!slots.length) {
      out[d] = [];
      continue;
    }
    const from = slots.map((x) => x.from).sort()[0]!;
    const to = slots.map((x) => x.to).sort().at(-1)!;
    out[d] = [{ from, to }];
  }
  return out;
}

/** One client however their number was typed: 07700 900123 = +447700900123. */
function clientKey(phone: string | null, email: string | null, name: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length >= 7) return `p:${digits.slice(-9)}`;
  if (email) return `e:${email.toLowerCase()}`;
  return `n:${name.trim().toLowerCase()}`;
}

function label(s: string): string {
  return s.replace(/_/g, " ").toLowerCase();
}

export function appointmentOut(r: any) {
  const lines = storedLines(r.services);
  return {
    ...r,
    services: lines,
    summary: summariseLines(lines),
    totalPrice: Number(r.totalPrice),
    depositAmount: Number(r.depositAmount),
    tipAmount: r.tipAmount == null ? null : Number(r.tipAmount),
    staff: r.staff
      ? { ...r.staff, commissionPercent: r.staff.commissionPercent == null ? null : Number(r.staff.commissionPercent) }
      : null,
  };
}
