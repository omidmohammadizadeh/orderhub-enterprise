import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";

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
  ) {}

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
      select: { id: true, name: true, settings: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return { locationId: loc.id, locationName: loc.name, ...this.readSettings(loc.settings) };
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
    const available = free.slice(unassignedOverlaps);

    return {
      startsAt,
      endsAt,
      partySize,
      available: available.map((t) => ({
        id: t.id,
        name: t.name,
        seats: t.seats,
        area: t.area,
      })),
      // Useful for the staff diary: what's booked, not just what's free.
      takenCount: takenTableIds.size + unassignedOverlaps,
      totalConsidered: bigEnough.length,
    };
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
    return this.createInternal(
      tenantId,
      input,
      this.readSettings(loc.settings),
      { onlineOnly: false },
    );
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
    const created = await this.createInternal(
      loc.brand.tenantId,
      { ...input, source: "ONLINE" },
      settings,
      { onlineOnly: true },
    );

    // Nobody is watching the diary at 9pm on a Friday. Push the booking to
    // every till at this location so it can chime and print, the same way a
    // new online ORDER already announces itself.
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
    input: Partial<CreateReservationInput> & { status?: ReservationStatus },
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

    return this.prisma.tableReservation.update({
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
      include: { table: { select: { id: true, name: true } } },
    });
  }

  async setStatus(tenantId: string, id: string, status: ReservationStatus) {
    await this.assertReservation(tenantId, id);
    return this.prisma.tableReservation.update({
      where: { id },
      data: {
        status,
        ...(status === "CANCELLED" || status === "NO_SHOW"
          ? { cancelledAt: new Date() }
          : {}),
      },
      include: { table: { select: { id: true, name: true } } },
    });
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
