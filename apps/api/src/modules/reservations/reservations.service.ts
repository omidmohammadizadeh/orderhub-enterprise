import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";
import { hoursConfigured, isCurrentlyOpen } from "../../common/opening-hours.util";
import { ReservationEmailService } from "./reservation-email.service";

// Table reservations (Phase 3 of table service).
//
// A booking may or may not name a table. Most restaurants take the
// booking first and decide the actual table on the day, so `tableId` is
// optional — an unassigned reservation still consumes a seat's worth of
// capacity for its slot, which is what availability() counts.
//
// Two doors into this service:
//   • staff (tenant-scoped, JWT)  — the diary
//   • public (locationId only)    — the storefront booking form, gated
//     on the location having BOTH table service and online reservations
//     switched on.

export type ReservationStatus =
  | "PENDING"
  | "CONFIRMED"
  | "SEATED"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW";

// Statuses that still occupy a table for its slot. A cancelled or
// no-show booking must free its capacity immediately, or one cancelled
// party blocks the slot all night.
const LIVE_STATUSES: ReservationStatus[] = [
  "PENDING",
  "CONFIRMED",
  "SEATED",
];

export interface CreateReservationInput {
  locationId: string;
  tableId?: string | null;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  partySize: number;
  startsAt: string | Date;
  durationMins?: number;
  notes?: string | null;
  source?: "ONLINE" | "STAFF" | "PHONE";
}

const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeReference(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  }
  return `R-${out}`;
}

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
    private readonly emails?: ReservationEmailService,
  ) {}

  /** Guest email, never awaited — see ReservationEmailService. */
  private notify(kind: "confirmed" | "updated" | "cancelled", r: { id: string; customerEmail?: string | null }) {
    if (!r?.customerEmail) return;
    void this.emails?.send(kind, r.id);
  }

  private async assertLocation(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true, name: true, settings: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc;
  }

  /**
   * Reservation settings live on Location.settings.tableService, next to
   * the existing `enabled` flag — no schema change, same shallow-merge
   * PATCH the toggle already uses.
   */
  private readSettings(settings: any) {
    const ts = (settings ?? {})?.tableService ?? {};
    const res = ts?.reservations ?? {};
    return {
      tableServiceEnabled: !!ts.enabled,
      onlineEnabled: !!res.onlineEnabled,
      // Guests can't book beyond this horizon, or closer than the lead time.
      maxPartySize: Number(res.maxPartySize) > 0 ? Number(res.maxPartySize) : 12,
      slotMinutes: Number(res.slotMinutes) > 0 ? Number(res.slotMinutes) : 90,
      leadTimeMins: Number(res.leadTimeMins) >= 0 ? Number(res.leadTimeMins) : 60,
      maxDaysAhead: Number(res.maxDaysAhead) > 0 ? Number(res.maxDaysAhead) : 60,
    };
  }

  async settingsFor(locationId: string) {
    const loc = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: {
        id: true,
        name: true,
        settings: true,
        phone: true,
        logoUrl: true,
        addressLine1: true,
        city: true,
        postcode: true,
        brand: { select: { logoUrl: true } },
      },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return {
      locationId: loc.id,
      locationName: loc.name,
      // Public anyway (it's on the shop's door) — lets the booking page look
      // like the restaurant rather than like us.
      logoUrl: loc.logoUrl ?? loc.brand?.logoUrl ?? null,
      phone: loc.phone ?? null,
      address:
        [loc.addressLine1, loc.city, loc.postcode]
          .map((p) => (p ?? "").trim())
          .filter(Boolean)
          .join(", ") || null,
      ...this.readSettings(loc.settings),
    };
  }

  // ── Diary ───────────────────────────────────────────────────────────

  async list(
    tenantId: string,
    query: { locationId?: string; from?: string; to?: string; status?: string },
  ) {
    const from = query.from ? new Date(query.from) : startOfDay(new Date());
    const to = query.to ? new Date(query.to) : addDays(from, 1);
    return this.prisma.tableReservation.findMany({
      where: {
        tenantId,
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.status ? { status: query.status } : {}),
        startsAt: { gte: from, lt: to },
      },
      orderBy: { startsAt: "asc" },
      include: { table: { select: { id: true, name: true, area: true } } },
    });
  }

  /**
   * Which tables can actually take a party of N at this time.
   *
   * A table is available when it is active, in service, big enough, and
   * has no overlapping live booking. `bookableOnline` only filters the
   * public door — staff can always seat a party anywhere.
   */
  async availability(
    locationId: string,
    startsAt: Date,
    partySize: number,
    durationMins: number,
    opts?: { onlineOnly?: boolean; ignoreReservationId?: string },
  ) {
    const endsAt = new Date(startsAt.getTime() + durationMins * 60_000);

    const tables = await this.prisma.table.findMany({
      where: {
        locationId,
        isActive: true,
        outOfService: false,
        ...(opts?.onlineOnly ? { bookableOnline: true } : {}),
      },
      orderBy: [{ seats: "asc" }, { sortOrder: "asc" }],
    });

    // Pull every live booking in a window wide enough to catch anything
    // that could overlap, then filter precisely in memory — cheaper than
    // an interval query and the day's volume is tiny.
    const dayFrom = new Date(startsAt.getTime() - 12 * 3600_000);
    const dayTo = new Date(endsAt.getTime() + 12 * 3600_000);
    const bookings = await this.prisma.tableReservation.findMany({
      where: {
        locationId,
        status: { in: LIVE_STATUSES },
        startsAt: { gte: dayFrom, lte: dayTo },
        ...(opts?.ignoreReservationId
          ? { id: { not: opts.ignoreReservationId } }
          : {}),
      },
    });

    const fit = freeTables(tables, bookings, startsAt, endsAt, partySize);

    return {
      startsAt,
      endsAt,
      partySize,
      available: fit.available.map((t) => ({
        id: t.id,
        name: t.name,
        seats: t.seats,
        area: t.area,
      })),
      // Useful for the staff diary: what's booked, not just what's free.
      takenCount: fit.takenCount,
      totalConsidered: fit.totalConsidered,
    };
  }

  /**
   * Every bookable start time on one day, for the guest's time picker.
   *
   * One read of the tables and one of the day's bookings, then each
   * candidate is checked in memory with the same rule availability() uses —
   * asking /availability once per slot would be 40+ round trips per day the
   * guest taps.
   *
   * `from`/`to` are the guest's local midnight bounds (their browser is in
   * the restaurant's town); opening hours are checked in the LOCATION's
   * timezone, the same way the phone line checks them.
   */
  async publicSlots(locationId: string, from: Date, to: Date, partySize: number) {
    const loc = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { id: true, settings: true, openingHours: true, timezone: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
    const settings = this.readSettings(loc.settings);
    if (!settings.tableServiceEnabled || !settings.onlineEnabled) return { slots: [] };
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      throw new BadRequestException("Invalid day");
    }
    // A day is at most 25 hours (clocks going back); refuse anything wider.
    if (to.getTime() - from.getTime() > 26 * 3600_000) {
      throw new BadRequestException("Ask for one day at a time");
    }
    const party = Math.max(1, Math.round(partySize) || 2);
    if (party > settings.maxPartySize) return { slots: [] };

    const tz = loc.timezone || "Europe/London";
    const hasHours = hoursConfigured(loc.openingHours);
    const earliest = Date.now() + settings.leadTimeMins * 60_000;
    const latest = addDays(new Date(), settings.maxDaysAhead).getTime();

    const tables = await this.prisma.table.findMany({
      where: { locationId, isActive: true, outOfService: false, bookableOnline: true },
      orderBy: [{ seats: "asc" }, { sortOrder: "asc" }],
    });
    const bookings = await this.prisma.tableReservation.findMany({
      where: {
        locationId,
        status: { in: LIVE_STATUSES },
        startsAt: {
          gte: new Date(from.getTime() - 12 * 3600_000),
          lte: new Date(to.getTime() + 12 * 3600_000),
        },
      },
    });

    const STEP = 15;
    const slots: { startsAt: string; available: boolean }[] = [];
    for (let t = from.getTime(); t < to.getTime(); t += STEP * 60_000) {
      const at = new Date(t);
      const wall = new Date(at.toLocaleString("en-US", { timeZone: tz }));
      const mins = wall.getHours() * 60 + wall.getMinutes();
      // With hours set, the shop's own hours decide. Without them, offer a
      // sensible dining window instead of 3am.
      const open = hasHours
        ? isCurrentlyOpen(loc.openingHours, tz, at)
        : mins >= 12 * 60 && mins <= 21 * 60 + 30;
      if (!open) continue;
      if (t < earliest || t > latest) continue;
      const end = new Date(t + settings.slotMinutes * 60_000);
      const fit = freeTables(tables, bookings, at, end, party);
      slots.push({ startsAt: at.toISOString(), available: fit.available.length > 0 });
    }
    return { slots };
  }

  // ── Create ──────────────────────────────────────────────────────────

  private async createInternal(
    tenantId: string,
    input: CreateReservationInput,
    settings: ReturnType<ReservationsService["readSettings"]>,
    opts: { onlineOnly: boolean },
  ) {
    const name = input.customerName?.trim();
    if (!name) throw new BadRequestException("A name is required");
    const partySize = Math.round(Number(input.partySize));
    if (!Number.isFinite(partySize) || partySize < 1) {
      throw new BadRequestException("Party size must be at least 1");
    }
    const startsAt = new Date(input.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException("Invalid date and time");
    }
    const durationMins =
      Number(input.durationMins) > 0
        ? Math.round(Number(input.durationMins))
        : settings.slotMinutes;

    if (opts.onlineOnly) {
      if (partySize > settings.maxPartySize) {
        throw new BadRequestException(
          `For parties over ${settings.maxPartySize} please call us directly.`,
        );
      }
      const earliest = new Date(Date.now() + settings.leadTimeMins * 60_000);
      if (startsAt < earliest) {
        throw new BadRequestException(
          `Bookings need at least ${settings.leadTimeMins} minutes' notice.`,
        );
      }
      if (startsAt > addDays(new Date(), settings.maxDaysAhead)) {
        throw new BadRequestException("That date is too far ahead.");
      }
    }

    // If a specific table was asked for, prove it's actually free.
    // Otherwise just prove SOMETHING is free, and leave the assignment to
    // the floor on the day.
    const avail = await this.availability(
      input.locationId,
      startsAt,
      partySize,
      durationMins,
      { onlineOnly: opts.onlineOnly },
    );
    let tableId = input.tableId ?? null;
    if (tableId) {
      if (!avail.available.some((t) => t.id === tableId)) {
        throw new BadRequestException(
          "That table isn't free at this time — pick another table or time.",
        );
      }
    } else if (!avail.available.length) {
      throw new BadRequestException(
        "We're fully booked at that time — please try another slot.",
      );
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.prisma.tableReservation.create({
          data: {
            tenantId,
            locationId: input.locationId,
            tableId,
            customerName: name,
            customerPhone: input.customerPhone?.trim() || null,
            customerEmail: input.customerEmail?.trim() || null,
            partySize,
            startsAt,
            durationMins,
            notes: input.notes?.trim() || null,
            source: input.source ?? (opts.onlineOnly ? "ONLINE" : "STAFF"),
            status: "CONFIRMED",
            reference: makeReference(),
          },
          include: { table: { select: { id: true, name: true } } },
        });
      } catch (e: any) {
        // Reference collision only — anything else is a real failure.
        if (e?.code !== "P2002" || attempt === 4) throw e;
      }
    }
    throw new BadRequestException("Could not save the booking, please retry");
  }

  async create(tenantId: string, input: CreateReservationInput) {
    const loc = await this.assertLocation(tenantId, input.locationId);
    const created = await this.createInternal(
      tenantId,
      input,
      this.readSettings(loc.settings),
      { onlineOnly: false },
    );
    // Taken over the phone by staff: the guest still gets it in writing
    // when they gave an email.
    this.notify("confirmed", created);
    return created;
  }

  /** Storefront booking form. No JWT — the location id is the only key. */
  async createPublic(input: CreateReservationInput) {
    const loc = await this.prisma.location.findUnique({
      where: { id: input.locationId },
      select: { id: true, settings: true, brand: { select: { tenantId: true } } },
    });
    if (!loc?.brand?.tenantId) throw new NotFoundException("Location not found");
    const settings = this.readSettings(loc.settings);
    if (!settings.tableServiceEnabled || !settings.onlineEnabled) {
      throw new BadRequestException(
        "This restaurant isn't taking online bookings at the moment.",
      );
    }
    // The confirmation goes by email, so an online booking needs an address
    // that can take one.
    const email = String(input.customerEmail ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException(
        "Please enter your email so we can send your confirmation.",
      );
    }
    const created = await this.createInternal(
      loc.brand.tenantId,
      { ...input, source: "ONLINE" },
      settings,
      { onlineOnly: true },
    );

    this.announce(created);
    this.notify("confirmed", created);
    // Never leak the internal table assignment to the guest.
    return {
      reference: created.reference,
      customerName: created.customerName,
      partySize: created.partySize,
      startsAt: created.startsAt,
      durationMins: created.durationMins,
      status: created.status,
    };
  }

  /**
   * Tell the shop a booking just arrived on its own.
   *
   * Nobody is watching the diary at 9pm on a Friday. Push it to every till at
   * this location so it can chime and print, the same way a new online ORDER
   * already announces itself — and the same bell for a booking the phone line
   * took, because "the AI answered it" is not a reason for the floor to find
   * out later.
   */
  private announce(created: any) {
    this.socket.emitToLocation(created.locationId, "reservation:new" as any, {
      id: created.id,
      reference: created.reference,
      locationId: created.locationId,
      customerName: created.customerName,
      customerPhone: created.customerPhone,
      partySize: created.partySize,
      startsAt: created.startsAt.toISOString(),
      durationMins: created.durationMins,
      tableName: created.table?.name ?? null,
      notes: created.notes,
      source: created.source,
    } as any);
  }

  // ── The phone ───────────────────────────────────────────────────────
  //
  // The third door, and the only one where nobody is in the room: an AI
  // answers the line and speaks for the shop. Everything here is gated on
  // THIS location having table service switched on, so a takeaway's phone
  // line can never take a booking for tables it does not have — checked in
  // the service and not in a prompt, because a prompt is a request.
  //
  // Treated as the internet, not as staff: a table held back from online
  // booking is held back from the phone line too. A shop keeping a table for
  // walk-ins wants a person deciding it, and the AI is not a person.

  /** What this location allows on the phone, or null if it takes no bookings. */
  async phoneSettings(locationId: string): Promise<
    | (ReturnType<ReservationsService["readSettings"]> & { tenantId: string })
    | null
  > {
    const loc = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { id: true, settings: true, brand: { select: { tenantId: true } } },
    });
    if (!loc?.brand?.tenantId) return null;
    const settings = this.readSettings(loc.settings);
    if (!settings.tableServiceEnabled) return null;
    // A shop can shut the phone line out of the diary on its own, without
    // giving up table service or online booking.
    const phone = (loc.settings as any)?.tableService?.reservations?.phoneEnabled;
    if (phone === false) return null;
    return { ...settings, tenantId: loc.brand.tenantId };
  }

  /**
   * Is that slot free, and if not, what is?
   *
   * Gated like everything else on this door, even though it only reads: one
   * rule for the whole phone side is worth more than one saved query, and a
   * shop that does not do table service should not answer questions about
   * its tables either.
   */
  async phoneAvailability(
    locationId: string,
    startsAt: Date,
    partySize: number,
    durationMins: number,
    ignoreReservationId?: string,
  ) {
    if (!(await this.phoneSettings(locationId))) {
      return { available: [], tables: [], capacityLeft: 0 } as any;
    }
    return this.availability(locationId, startsAt, partySize, durationMins, {
      onlineOnly: true,
      ...(ignoreReservationId ? { ignoreReservationId } : {}),
    });
  }

  /**
   * Take a booking over the phone.
   *
   * Every limit the storefront obeys, with one difference: a party too big
   * for the online form is told to ring the shop, and this caller already
   * has. So an oversized party is refused in a way the line can act on — a
   * person takes it — rather than being told to do what it is doing.
   */
  async createFromPhone(input: CreateReservationInput) {
    const settings = await this.phoneSettings(input.locationId);
    if (!settings) {
      throw new BadRequestException("This location does not take table bookings.");
    }
    const partySize = Math.round(Number(input.partySize));
    if (Number.isFinite(partySize) && partySize > settings.maxPartySize) {
      throw new BadRequestException(
        `A party of ${partySize} is bigger than this line can book — the shop takes those itself.`,
      );
    }
    const created = await this.createInternal(
      settings.tenantId,
      { ...input, source: "PHONE" },
      settings,
      { onlineOnly: true },
    );
    this.announce(created);
    this.notify("confirmed", created);
    return created;
  }

  /**
   * The bookings this caller can talk about.
   *
   * Their own number, live bookings, still to come — the same shape of
   * question the order line already answers for "where's my order". A
   * reference is accepted too, because a caller who has the confirmation in
   * front of them may read it out, but nobody is asked for one.
   */
  async phoneLookup(
    locationId: string,
    opts: { phone?: string | null; reference?: string | null },
  ) {
    const settings = await this.phoneSettings(locationId);
    if (!settings) return [];
    const ref = String(opts.reference ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const digits = String(opts.phone ?? "").replace(/\D/g, "");
    const upcoming = {
      locationId,
      status: { in: LIVE_STATUSES },
      startsAt: { gte: new Date(Date.now() - 60 * 60_000) },
    };
    if (ref) {
      const all = await this.prisma.tableReservation.findMany({
        where: upcoming,
        orderBy: { startsAt: "asc" },
        include: { table: { select: { id: true, name: true } } },
      });
      // Said down a phone, "R-7QK4M2" arrives as "r seven q k four m two"
      // with the punctuation gone, so it is compared with everything but the
      // letters and digits stripped out.
      const hit = all.filter(
        (r) => r.reference.toUpperCase().replace(/[^A-Z0-9]/g, "") === ref,
      );
      if (hit.length) return hit;
    }
    if (!digits) return [];
    const all = await this.prisma.tableReservation.findMany({
      where: upcoming,
      orderBy: { startsAt: "asc" },
      include: { table: { select: { id: true, name: true } } },
    });
    // Numbers are stored as they arrived — +44, 0044, or plain — so they are
    // compared by their last nine digits, which is what identifies a UK
    // subscriber whichever way the front of it was written.
    const tail = digits.slice(-9);
    return all.filter((r) => {
      const theirs = String(r.customerPhone ?? "").replace(/\D/g, "");
      return theirs.length >= 9 && theirs.slice(-9) === tail;
    });
  }

  /** Move a booking, or change its size, over the phone. */
  async updateFromPhone(
    locationId: string,
    id: string,
    input: { startsAt?: Date; partySize?: number; notes?: string | null },
  ) {
    const settings = await this.phoneSettings(locationId);
    if (!settings) {
      throw new BadRequestException("This location does not take table bookings.");
    }
    const existing = await this.prisma.tableReservation.findFirst({
      where: { id, locationId, status: { in: LIVE_STATUSES } },
    });
    if (!existing) throw new NotFoundException("Reservation not found");
    const startsAt = input.startsAt ?? existing.startsAt;
    const partySize = input.partySize ?? existing.partySize;
    if (partySize > settings.maxPartySize) {
      throw new BadRequestException(
        `A party of ${partySize} is bigger than this line can book — the shop takes those itself.`,
      );
    }
    if (input.startsAt) {
      const earliest = new Date(Date.now() + settings.leadTimeMins * 60_000);
      if (startsAt < earliest) {
        throw new BadRequestException(
          `Bookings need at least ${settings.leadTimeMins} minutes' notice.`,
        );
      }
    }
    // The new slot has to be free without counting this booking against
    // itself, or moving a table by half an hour would collide with the very
    // booking being moved.
    const avail = await this.phoneAvailability(
      locationId,
      startsAt,
      partySize,
      existing.durationMins,
      existing.id,
    );
    if (!avail.available.length) {
      throw new BadRequestException("There is nothing free at that time.");
    }
    return this.update(existing.tenantId, id, {
      ...(input.startsAt ? { startsAt } : {}),
      ...(input.partySize !== undefined ? { partySize } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      // A table chosen for the old time may be taken at the new one.
      ...(input.startsAt && !avail.available.some((t: any) => t.id === existing.tableId)
        ? { tableId: avail.available[0]!.id }
        : {}),
    });
  }

  /** Cancel a booking over the phone. */
  async cancelFromPhone(locationId: string, id: string) {
    const settings = await this.phoneSettings(locationId);
    if (!settings) {
      throw new BadRequestException("This location does not take table bookings.");
    }
    const existing = await this.prisma.tableReservation.findFirst({
      where: { id, locationId, status: { in: LIVE_STATUSES } },
    });
    if (!existing) throw new NotFoundException("Reservation not found");
    return this.setStatus(existing.tenantId, id, "CANCELLED");
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  private async assertReservation(tenantId: string, id: string) {
    const r = await this.prisma.tableReservation.findFirst({
      where: { id, tenantId },
    });
    if (!r) throw new NotFoundException("Reservation not found");
    return r;
  }

  async update(
    tenantId: string,
    id: string,
    input: Partial<CreateReservationInput> & {
      status?: ReservationStatus;
      /** Email the guest about a new time / party size. Default: yes. */
      notifyCustomer?: boolean;
    },
  ) {
    const r = await this.assertReservation(tenantId, id);
    const startsAt = input.startsAt ? new Date(input.startsAt) : r.startsAt;
    const durationMins = input.durationMins ?? r.durationMins;
    const partySize = input.partySize ?? r.partySize;
    const tableId = input.tableId !== undefined ? input.tableId : r.tableId;

    // Re-check the slot whenever the booking moves in time, grows, or
    // lands on a specific table — otherwise a staff edit could
    // double-book a table the availability check already gave away.
    const movedOrGrew =
      startsAt.getTime() !== r.startsAt.getTime() ||
      durationMins !== r.durationMins ||
      partySize !== r.partySize ||
      tableId !== r.tableId;
    if (movedOrGrew && tableId) {
      const avail = await this.availability(
        r.locationId,
        startsAt,
        partySize,
        durationMins,
        { ignoreReservationId: r.id },
      );
      if (!avail.available.some((t) => t.id === tableId)) {
        throw new BadRequestException(
          "That table isn't free at the new time — pick another.",
        );
      }
    }

    const updated = await this.prisma.tableReservation.update({
      where: { id },
      data: {
        ...(input.customerName !== undefined
          ? { customerName: input.customerName.trim() }
          : {}),
        ...(input.customerPhone !== undefined
          ? { customerPhone: input.customerPhone?.trim() || null }
          : {}),
        ...(input.customerEmail !== undefined
          ? { customerEmail: input.customerEmail?.trim() || null }
          : {}),
        ...(input.partySize !== undefined ? { partySize } : {}),
        ...(input.startsAt !== undefined ? { startsAt } : {}),
        ...(input.durationMins !== undefined ? { durationMins } : {}),
        ...(input.tableId !== undefined ? { tableId } : {}),
        ...(input.notes !== undefined
          ? { notes: input.notes?.trim() || null }
          : {}),
        ...(input.status !== undefined
          ? {
              status: input.status,
              ...(input.status === "CANCELLED" || input.status === "NO_SHOW"
                ? { cancelledAt: new Date() }
                : {}),
            }
          : {}),
      },
      include: { table: { select: { id: true, name: true, area: true } } },
    });

    // The guest hears about what THEY see: the time, the day, how many.
    // Which table the floor put them on is not their business, so a table
    // shuffle sends nothing.
    if (input.notifyCustomer !== false && LIVE_STATUSES.includes(updated.status as ReservationStatus)) {
      const guestFacingChange =
        updated.startsAt.getTime() !== r.startsAt.getTime() ||
        updated.partySize !== r.partySize;
      if (guestFacingChange) this.notify("updated", updated);
    }
    if (
      input.notifyCustomer !== false &&
      input.status === "CANCELLED" &&
      r.status !== "CANCELLED"
    ) {
      this.notify("cancelled", updated);
    }
    return updated;
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: ReservationStatus,
    opts?: { notifyCustomer?: boolean },
  ) {
    const before = await this.assertReservation(tenantId, id);
    const updated = await this.prisma.tableReservation.update({
      where: { id },
      data: {
        status,
        ...(status === "CANCELLED" || status === "NO_SHOW"
          ? { cancelledAt: new Date() }
          : {}),
      },
      include: { table: { select: { id: true, name: true, area: true } } },
    });
    if (
      status === "CANCELLED" &&
      before.status !== "CANCELLED" &&
      opts?.notifyCustomer !== false
    ) {
      this.notify("cancelled", updated);
    }
    return updated;
  }

  /**
   * One booking, plus this guest's other bookings at the same shop — the
   * details drawer shows "3rd visit, 1 no-show" so the floor knows who is
   * walking in. Matched by email, or the last nine digits of the phone
   * (numbers arrive as +44, 0044 or 07…).
   */
  async get(tenantId: string, id: string) {
    const r = await this.prisma.tableReservation.findFirst({
      where: { id, tenantId },
      include: { table: { select: { id: true, name: true, area: true } } },
    });
    if (!r) throw new NotFoundException("Reservation not found");
    const email = r.customerEmail?.trim().toLowerCase() || null;
    const tail = String(r.customerPhone ?? "").replace(/\D/g, "").slice(-9);
    let history: any[] = [];
    if (email || tail.length === 9) {
      const others = await this.prisma.tableReservation.findMany({
        where: {
          tenantId,
          locationId: r.locationId,
          id: { not: r.id },
          OR: [
            ...(email ? [{ customerEmail: { equals: email, mode: "insensitive" as const } }] : []),
            ...(tail.length === 9 ? [{ customerPhone: { contains: tail.slice(-6) } }] : []),
          ],
        },
        orderBy: { startsAt: "desc" },
        take: 50,
        select: {
          id: true,
          startsAt: true,
          partySize: true,
          status: true,
          customerEmail: true,
          customerPhone: true,
          reference: true,
        },
      });
      // `contains` on six digits is only a pre-filter; confirm on nine.
      history = others
        .filter(
          (o) =>
            (email && o.customerEmail?.trim().toLowerCase() === email) ||
            (tail.length === 9 &&
              String(o.customerPhone ?? "").replace(/\D/g, "").slice(-9) === tail),
        )
        .slice(0, 12)
        .map(({ customerEmail: _e, customerPhone: _p, ...rest }) => rest);
    }
    return { ...r, history };
  }

  /** Staff "resend confirmation" from the details drawer. */
  async resendConfirmation(tenantId: string, id: string) {
    const r = await this.assertReservation(tenantId, id);
    if (!r.customerEmail) {
      throw new BadRequestException("This booking has no email address.");
    }
    const kind = r.status === "CANCELLED" ? "cancelled" : "confirmed";
    const sent = (await this.emails?.send(kind, r.id)) ?? false;
    if (!sent) throw new BadRequestException("Couldn't send the email — check the address.");
    return { ok: true, to: r.customerEmail };
  }

  /**
   * The party walked in. Seats their table (opening its tab) and marks
   * the booking SEATED so it stops eating capacity as a future booking
   * and starts showing as a live sitting.
   *
   * The table's covers are pre-filled from the party size — the number
   * the guest already told us — so the floor doesn't retype it.
   */
  async seat(tenantId: string, id: string, tableId?: string) {
    const r = await this.assertReservation(tenantId, id);
    const targetId = tableId ?? r.tableId;
    if (!targetId) {
      throw new BadRequestException(
        "Pick a table for this booking before seating it.",
      );
    }
    const table = await this.prisma.table.findFirst({
      where: { id: targetId, tenantId },
    });
    if (!table) throw new NotFoundException("Table not found");
    if (table.outOfService) {
      throw new BadRequestException(`${table.name} is out of service`);
    }
    if (table.currentOrderId) {
      throw new BadRequestException(
        `${table.name} already has an open tab — settle or pick another table.`,
      );
    }

    const [, updated] = await this.prisma.$transaction([
      this.prisma.table.update({
        where: { id: targetId },
        data: {
          status: "OCCUPIED",
          openedAt: new Date(),
          covers: r.partySize,
        },
      }),
      this.prisma.tableReservation.update({
        where: { id },
        data: { status: "SEATED", seatedAt: new Date(), tableId: targetId },
        include: { table: { select: { id: true, name: true } } },
      }),
    ]);
    return updated;
  }

  async remove(tenantId: string, id: string) {
    await this.assertReservation(tenantId, id);
    await this.prisma.tableReservation.delete({ where: { id } });
    return { ok: true };
  }
}

/**
 * Which tables can take a party for [startsAt, endsAt), given the live
 * bookings around it. Pure, so the guest slot grid can run it 50 times
 * against one read.
 */
function freeTables<T extends { id: string; seats: number | null }>(
  tables: T[],
  bookings: { tableId: string | null; startsAt: Date; durationMins: number }[],
  startsAt: Date,
  endsAt: Date,
  partySize: number,
) {
  const overlaps = bookings.filter((b) => {
    const bStart = b.startsAt.getTime();
    const bEnd = bStart + b.durationMins * 60_000;
    return bStart < endsAt.getTime() && bEnd > startsAt.getTime();
  });
  const takenTableIds = new Set(
    overlaps.map((b) => b.tableId).filter(Boolean) as string[],
  );
  // Bookings with no table assigned still eat capacity — count them so
  // we never promise more tables than we actually have free.
  const unassignedOverlaps = overlaps.filter((b) => !b.tableId).length;

  const bigEnough = tables.filter((t) => (t.seats ?? 99) >= partySize);
  const free = bigEnough.filter((t) => !takenTableIds.has(t.id));
  // Hold back one table per unassigned booking, smallest first, so the
  // floor keeps the flexibility it already promised away.
  return {
    available: free.slice(unassignedOverlaps),
    takenCount: takenTableIds.size + unassignedOverlaps,
    totalConsidered: bigEnough.length,
  };
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
