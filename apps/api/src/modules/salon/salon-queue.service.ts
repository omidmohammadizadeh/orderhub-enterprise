import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "crypto";
import {
  estimateQueue,
  lineBlock,
  occupancy,
  wallDate,
  zonedWallToUtc,
} from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";
import { SalonBookingService } from "./salon-booking.service";
import { SalonNotifyService } from "./salon-notify.service";
import { storedLines } from "./salon-lines";

// The barber's walk-in queue.
//
// Walk-ins wait in order; each barber's chair frees up when their current
// client is done; and nobody is squeezed in front of a booked appointment
// they'd run into. The estimate is recalculated on every read, so it moves
// as the floor moves — a no-show, a quick line-up, a barber back from lunch.

const OPEN = ["WAITING", "CALLED", "IN_SERVICE"];

@Injectable()
export class SalonQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
    private readonly booking: SalonBookingService,
    private readonly notify: SalonNotifyService,
  ) {}

  private emit(locationId: string) {
    this.socket.emitToLocation(locationId, "salon:queue" as any, { at: Date.now() } as any);
  }

  /** The live queue with each person's estimated wait and likely barber. */
  async board(locationId: string, now: number = Date.now()) {
    const loc = await this.booking.loadLocation(locationId);
    const date = wallDate(now, loc.tz);
    const dayStart = zonedWallToUtc(date, "00:00", loc.tz);
    const entries = await this.prisma.salonQueueEntry.findMany({
      where: { locationId, status: { in: OPEN }, createdAt: { gte: new Date(dayStart - 6 * 3600_000) } },
      orderBy: { createdAt: "asc" },
    });
    const barbers = await this.prisma.salonStaff.findMany({
      where: { locationId, isActive: true, acceptsWalkIns: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    const ctx = await this.booking.dayContext({
      locationId,
      date,
      tz: loc.tz,
      shopHours: loc.shopHours,
      staff: barbers,
    });
    // Whoever is in the chair now holds it until their appointment ends —
    // or for their walk-in estimate if they came off the queue.
    for (const e of entries) {
      if (e.status === "IN_SERVICE" && e.staffId && !e.appointmentId) {
        const day = ctx.get(e.staffId);
        const start = (e.startedAt ?? new Date(now)).getTime();
        day?.busy.push({ start, end: Math.max(now, start + e.estimatedMins * 60_000) });
      }
    }
    // An appointment still in the chair past its booked end keeps the chair.
    const inChair = await this.prisma.salonAppointment.findMany({
      where: { locationId, status: "IN_SERVICE", startsAt: { gte: new Date(dayStart) } },
      select: { staffId: true, startsAt: true, services: true },
    });
    for (const a of inChair) {
      if (!a.staffId) continue;
      const occ = occupancy(a.startsAt.getTime(), storedLines(a.services).map(lineBlock));
      if (occ.endMs < now + 5 * 60_000) ctx.get(a.staffId)?.busy.push({ start: now, end: now + 5 * 60_000 });
    }

    const waiting = entries.filter((e) => e.status === "WAITING");
    const est = estimateQueue({
      now,
      barbers: barbers.map((b) => ({
        staffId: b.id,
        windows: ctx.get(b.id)?.windows ?? [],
        busy: ctx.get(b.id)?.busy ?? [],
      })),
      // A phantom walk-in at the back: "if you walked in now, ~N minutes".
      queue: [
        ...waiting.map((e) => ({ id: e.id, mins: e.estimatedMins, preferredStaffId: e.preferredStaffId })),
        { id: "__next", mins: 30 },
      ],
    });
    const byId = new Map(est.map((x) => [x.id, x]));
    const names = new Map(barbers.map((b) => [b.id, b.name]));
    const allStaff = await this.prisma.salonStaff.findMany({ where: { locationId }, select: { id: true, name: true } });
    for (const s of allStaff) if (!names.has(s.id)) names.set(s.id, s.name);

    let position = 0;
    return {
      nextWaitMins: byId.get("__next")?.waitMins ?? null,
      locationId,
      locationName: loc.name,
      timezone: loc.tz,
      queueEnabled: loc.salon.queueEnabled,
      onlineJoin: loc.salon.queueEnabled && loc.salon.queueOnlineJoin,
      barbersOn: barbers.filter((b) => (ctx.get(b.id)?.windows ?? []).some((w) => w.end > now)).map((b) => ({ id: b.id, name: b.name, colour: b.colour })),
      entries: entries.map((e) => {
        const x = byId.get(e.id);
        if (e.status === "WAITING") position += 1;
        return {
          id: e.id,
          customerName: e.customerName,
          customerPhone: e.customerPhone,
          serviceSummary: e.serviceSummary,
          serviceIds: e.serviceIds,
          estimatedMins: e.estimatedMins,
          preferredStaffId: e.preferredStaffId,
          preferredStaffName: e.preferredStaffId ? names.get(e.preferredStaffId) ?? null : null,
          staffId: e.staffId,
          staffName: e.staffId ? names.get(e.staffId) ?? null : null,
          status: e.status,
          source: e.source,
          appointmentId: e.appointmentId,
          createdAt: e.createdAt,
          calledAt: e.calledAt,
          position: e.status === "WAITING" ? position : null,
          waitMins: x?.waitMins ?? null,
          likelyStaffId: x?.staffId ?? null,
          likelyStaffName: x?.staffId ? names.get(x.staffId) ?? null : null,
          publicToken: e.publicToken,
        };
      }),
    };
  }

  private async summarise(locationId: string, serviceIds: string[]) {
    if (!serviceIds.length) return { summary: null as string | null, mins: 30, ids: [] as string[] };
    const rows = await this.prisma.salonService.findMany({
      where: { locationId, id: { in: serviceIds }, isActive: true },
    });
    const ids = serviceIds.filter((id) => rows.some((r) => r.id === id));
    const ordered = ids.map((id) => rows.find((r) => r.id === id)!);
    return {
      summary: ordered.map((r) => r.name).join(" + ") || null,
      mins: Math.max(5, ordered.reduce((s, r) => s + r.durationMins + r.bufferMins, 0) || 30),
      ids,
    };
  }

  async join(
    input: {
      locationId: string;
      customerName: string;
      customerPhone?: string | null;
      serviceIds?: string[];
      preferredStaffId?: string | null;
    },
    opts: { tenantId?: string; source: "STAFF" | "ONLINE" | "KIOSK" },
  ) {
    const loc = await this.booking.loadLocation(input.locationId);
    if (opts.tenantId && loc.tenantId !== opts.tenantId) throw new NotFoundException("Location not found");
    if (!loc.salon.queueEnabled) throw new BadRequestException("This shop isn't running a walk-in queue");
    if (opts.source === "ONLINE" && !loc.salon.queueOnlineJoin) {
      throw new BadRequestException("Join the queue at the shop");
    }
    const name = String(input.customerName ?? "").trim().slice(0, 80);
    if (!name) throw new BadRequestException("Please enter a name");
    const phone = String(input.customerPhone ?? "").trim().slice(0, 40) || null;
    if (opts.source === "ONLINE") {
      if (!phone) throw new BadRequestException("Please enter a phone number");
      // One place per phone — refreshing the page mustn't queue them twice.
      const dupe = await this.prisma.salonQueueEntry.findFirst({
        where: { locationId: loc.id, customerPhone: phone, status: { in: OPEN } },
      });
      if (dupe) return { entry: dupe, already: true };
      const open = await this.prisma.salonQueueEntry.count({ where: { locationId: loc.id, status: "WAITING" } });
      if (open >= 40) throw new BadRequestException("The queue is full right now — please try again later");
    }
    let preferred: string | null = null;
    if (input.preferredStaffId && input.preferredStaffId !== "any") {
      const s = await this.prisma.salonStaff.findFirst({
        where: { id: input.preferredStaffId, locationId: loc.id, isActive: true, acceptsWalkIns: true },
      });
      if (!s) throw new BadRequestException("That barber isn't taking walk-ins");
      preferred = s.id;
    }
    const svc = await this.summarise(loc.id, Array.isArray(input.serviceIds) ? input.serviceIds.map(String) : []);
    const entry = await this.prisma.salonQueueEntry.create({
      data: {
        tenantId: loc.tenantId,
        locationId: loc.id,
        customerName: name,
        customerPhone: phone,
        serviceIds: svc.ids,
        serviceSummary: svc.summary,
        estimatedMins: svc.mins,
        preferredStaffId: preferred,
        source: opts.source,
        publicToken: randomBytes(12).toString("base64url"),
      },
    });
    this.emit(loc.id);
    return { entry, already: false };
  }

  private async entryFor(tenantId: string, id: string) {
    const e = await this.prisma.salonQueueEntry.findFirst({ where: { id, tenantId } });
    if (!e) throw new NotFoundException("Not in the queue");
    return e;
  }

  /** Call them up. Picks the barber if not given: their preference, else the estimate's. */
  async call(tenantId: string, id: string, staffId?: string | null) {
    const e = await this.entryFor(tenantId, id);
    if (e.status !== "WAITING" && e.status !== "CALLED") throw new BadRequestException("They've already been seen");
    let who = staffId || e.preferredStaffId || null;
    if (!who) {
      const b = await this.board(e.locationId);
      who = b.entries.find((x) => x.id === e.id)?.likelyStaffId ?? null;
    }
    await this.prisma.salonQueueEntry.update({
      where: { id: e.id },
      data: { status: "CALLED", calledAt: new Date(), staffId: who },
    });
    const loc = await this.booking.loadLocation(e.locationId);
    if (loc.salon.queueCallSms && e.customerPhone) void this.notify.queueCalled(e.id);
    this.emit(e.locationId);
    return this.board(e.locationId);
  }

  /**
   * Into the chair: an appointment is made for them right now with this
   * barber (so checkout, takings and commission treat it like any visit).
   */
  async start(tenantId: string, id: string, body: { staffId: string; serviceIds?: string[] }) {
    const e = await this.entryFor(tenantId, id);
    if (!["WAITING", "CALLED"].includes(e.status)) throw new BadRequestException("They've already been seen");
    const staffId = body.staffId || e.staffId || e.preferredStaffId;
    if (!staffId) throw new BadRequestException("Pick the barber");
    const serviceIds = body.serviceIds?.length ? body.serviceIds : e.serviceIds;
    if (!serviceIds.length) throw new BadRequestException("Pick what they're having");
    const appt = await this.booking.book(
      {
        locationId: e.locationId,
        staffId,
        startsAt: new Date().toISOString(),
        services: serviceIds.map((serviceId) => ({ serviceId })),
        customerName: e.customerName,
        customerPhone: e.customerPhone,
        source: "WALK_IN",
        force: true,
        silent: true,
        queueEntryId: e.id,
      },
      { tenantId, online: false },
    );
    await this.prisma.salonAppointment.update({
      where: { id: appt.id },
      data: { status: "IN_SERVICE", startedAt: new Date(), checkedInAt: e.createdAt },
    });
    await this.prisma.salonQueueEntry.update({
      where: { id: e.id },
      data: { status: "IN_SERVICE", startedAt: new Date(), staffId, appointmentId: appt.id },
    });
    this.emit(e.locationId);
    this.booking.emit(e.locationId, "created", appt.id);
    return { appointmentId: appt.id, board: await this.board(e.locationId) };
  }

  async finish(tenantId: string, id: string, status: "DONE" | "LEFT") {
    const e = await this.entryFor(tenantId, id);
    await this.prisma.salonQueueEntry.update({
      where: { id: e.id },
      data: { status, finishedAt: new Date() },
    });
    this.emit(e.locationId);
    return this.board(e.locationId);
  }

  /** Send someone back to the end of the waiting list (didn't answer the call). */
  async requeue(tenantId: string, id: string) {
    const e = await this.entryFor(tenantId, id);
    await this.prisma.salonQueueEntry.update({
      where: { id: e.id },
      data: { status: "WAITING", calledAt: null, staffId: null, createdAt: new Date() },
    });
    this.emit(e.locationId);
    return this.board(e.locationId);
  }

  // ── Public ──────────────────────────────────────────────────────────

  /** "You're 3rd — about 25 minutes." */
  async publicStatus(token: string) {
    const e = await this.prisma.salonQueueEntry.findUnique({ where: { publicToken: String(token ?? "") } });
    if (!e) throw new NotFoundException("Not found");
    const b = await this.board(e.locationId);
    const mine = b.entries.find((x) => x.id === e.id);
    return {
      status: e.status,
      customerName: e.customerName,
      serviceSummary: e.serviceSummary,
      position: mine?.position ?? null,
      waitMins: mine?.waitMins ?? null,
      staffName: mine?.staffName ?? mine?.likelyStaffName ?? null,
      locationId: e.locationId,
      locationName: b.locationName,
      ahead: mine?.position ? mine.position - 1 : 0,
    };
  }

  async publicLeave(token: string) {
    const e = await this.prisma.salonQueueEntry.findUnique({ where: { publicToken: String(token ?? "") } });
    if (!e) throw new NotFoundException("Not found");
    if (e.status === "WAITING" || e.status === "CALLED") {
      await this.prisma.salonQueueEntry.update({ where: { id: e.id }, data: { status: "LEFT", finishedAt: new Date() } });
      this.emit(e.locationId);
    }
    return this.publicStatus(token);
  }

  /** The TV by the door: first names only, never phone numbers. */
  async publicBoard(locationId: string) {
    const b = await this.board(locationId);
    const firstName = (n: string) => {
      const parts = n.trim().split(/\s+/);
      return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]}.` : parts[0] ?? "Guest";
    };
    const waiting = b.entries.filter((e) => e.status === "WAITING");
    return {
      locationName: b.locationName,
      queueEnabled: b.queueEnabled,
      onlineJoin: b.onlineJoin,
      barbersOn: b.barbersOn.map((x) => ({ name: x.name, colour: x.colour })),
      nowServing: b.entries
        .filter((e) => e.status === "CALLED" || e.status === "IN_SERVICE")
        .map((e) => ({ name: firstName(e.customerName), staffName: e.staffName, status: e.status })),
      waiting: waiting.map((e) => ({
        position: e.position,
        name: firstName(e.customerName),
        waitMins: e.waitMins,
        staffName: e.preferredStaffName,
      })),
      nextWaitMins: b.nextWaitMins,
    };
  }
}
