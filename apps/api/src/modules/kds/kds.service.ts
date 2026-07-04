// Phase KD — franchise-grade kitchen display.
//
// Screens are STATIONS (Grill / Fryer / Pizza / …) or EXPO. Routing rules
// live on KdsScreen.settings; an order splits into per-station tickets that
// carry only the lines that station cooks (KdsTicket.metadata.itemIds).
// Bumping drives the order lifecycle:
//   first activity on any station  → order PREPARING
//   all station tickets bumped     → order READY (when no expo screen)
//   expo bump                      → order READY (+ lingering stations bumped)
// KdsDispatchService listens to order.status_changed and calls
// dispatchOrderToScreens on ACCEPTED (scheduled orders fire later via
// KdsFireCron); cancels void the tickets.

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";

export interface KdsScreenSettings {
  /** STATION cooks a subset; EXPO sees whole orders and serves them. */
  stationType?: "STATION" | "EXPO";
  /** Menu category ids routed to this station. Empty = everything. */
  categoryIds?: string[];
  /** Extra menu item ids routed here regardless of category. */
  itemIds?: string[];
  /** Modifier option names routed here — any order line carrying a matching
   *  modifier lands on this station (e.g. "Extra Halloumi fries" → fryer),
   *  regardless of the line's own category. Matched case-insensitively. */
  modifierNames?: string[];
  /** Order sources shown (ONLINE/POS/UBER_EATS/…). Empty = all. */
  channels?: string[];
  /** SLA thresholds in minutes: green < warn ≤ amber < late ≤ red. */
  slaWarnMinutes?: number;
  slaLateMinutes?: number;
  sound?: boolean;
  fontScale?: number;
  columns?: number;
}

export interface CreateKdsScreenDto {
  name: string;
  station: string;
  settings?: KdsScreenSettings;
}

export interface UpdateKdsScreenDto {
  name?: string;
  station?: string;
  isActive?: boolean;
  settings?: KdsScreenSettings;
}

const TICKET_INCLUDE = {
  order: {
    include: {
      items: true,
      location: { select: { id: true, name: true } },
      brand: { select: { id: true, name: true } },
    },
  },
  screen: { select: { id: true, name: true, station: true, settings: true } },
} satisfies Prisma.KdsTicketInclude;

// A ticket is "active" (shown on the rail) while its order hasn't finished.
// READY is included so a recalled ticket reappears even after a single-
// station bump already moved the order to READY; COMPLETED/CANCELLED/
// REJECTED/FAILED tickets are bumped or voided, so they never show.
const ACTIVE_ORDER_STATUSES = ["ACCEPTED", "PREPARING", "READY"] as const;

@Injectable()
export class KdsService {
  private readonly logger = new Logger(KdsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
  ) {}

  // ── Screen management ──────────────────────────────────────────────────────

  async findScreensByLocation(locationId: string, tenantId: string) {
    await this.assertLocationAccess(locationId, tenantId);
    return this.prisma.kdsScreen.findMany({
      where: { locationId },
      include: {
        _count: { select: { tickets: { where: { bumpedAt: null } } } },
      },
      orderBy: { name: "asc" },
    });
  }

  async getScreen(screenId: string, tenantId: string) {
    return this.assertScreenAccess(screenId, tenantId);
  }

  async createScreen(
    locationId: string,
    tenantId: string,
    dto: CreateKdsScreenDto,
  ) {
    await this.assertLocationAccess(locationId, tenantId);
    return this.prisma.kdsScreen.create({
      data: {
        tenantId,
        locationId,
        name: dto.name,
        station: dto.station,
        settings: (dto.settings ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async updateScreen(
    screenId: string,
    tenantId: string,
    dto: UpdateKdsScreenDto,
  ) {
    const screen = await this.assertScreenAccess(screenId, tenantId);
    return this.prisma.kdsScreen.update({
      where: { id: screenId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.station !== undefined && { station: dto.station }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.settings !== undefined && {
          // Merge so partial settings updates don't wipe routing rules.
          settings: {
            ...((screen.settings ?? {}) as Record<string, unknown>),
            ...dto.settings,
          } as Prisma.InputJsonValue,
        }),
      },
    });
  }

  async removeScreen(screenId: string, tenantId: string) {
    await this.assertScreenAccess(screenId, tenantId);
    await this.prisma.kdsScreen.delete({ where: { id: screenId } });
  }

  // ── Tickets ────────────────────────────────────────────────────────────────

  async getActiveTickets(screenId: string, tenantId: string) {
    await this.assertScreenAccess(screenId, tenantId);
    return this.prisma.kdsTicket.findMany({
      where: {
        kdsScreenId: screenId,
        bumpedAt: null,
        order: { status: { in: [...ACTIVE_ORDER_STATUSES] } },
      },
      include: TICKET_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
  }

  /** Recently bumped tickets — the recall rail. */
  async getRecentBumped(screenId: string, tenantId: string, take = 8) {
    await this.assertScreenAccess(screenId, tenantId);
    return this.prisma.kdsTicket.findMany({
      where: { kdsScreenId: screenId, bumpedAt: { not: null } },
      include: TICKET_INCLUDE,
      orderBy: { bumpedAt: "desc" },
      take,
    });
  }

  /** Today's speed-of-service numbers for the screen header. */
  async getStats(screenId: string, tenantId: string) {
    const screen = await this.assertScreenAccess(screenId, tenantId);
    const settings = (screen.settings ?? {}) as KdsScreenSettings;
    const lateMs = (settings.slaLateMinutes ?? 10) * 60_000;
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    const [open, done] = await Promise.all([
      this.prisma.kdsTicket.findMany({
        where: {
          kdsScreenId: screenId,
          bumpedAt: null,
          order: { status: { in: [...ACTIVE_ORDER_STATUSES] } },
        },
        select: { createdAt: true },
      }),
      this.prisma.kdsTicket.findMany({
        where: { kdsScreenId: screenId, bumpedAt: { gte: dayStart } },
        select: { createdAt: true, bumpedAt: true },
      }),
    ]);

    const now = Date.now();
    const lateOpen = open.filter(
      (t) => now - t.createdAt.getTime() > lateMs,
    ).length;
    const durations = done.map(
      (t) => (t.bumpedAt!.getTime() - t.createdAt.getTime()) / 1000,
    );
    const avgSeconds = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

    return {
      openCount: open.length,
      lateCount: lateOpen,
      doneToday: done.length,
      avgBumpSeconds: avgSeconds,
    };
  }

  /**
   * Mark one item line cooked/uncooked on a station ticket. First activity
   * on an ACCEPTED order advances it to PREPARING.
   */
  async setItemState(
    screenId: string,
    orderId: string,
    orderItemId: string,
    done: boolean,
    tenantId: string,
  ) {
    const screen = await this.assertScreenAccess(screenId, tenantId);
    const ticket = await this.prisma.kdsTicket.findUnique({
      where: { kdsScreenId_orderId: { kdsScreenId: screenId, orderId } },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const meta = (ticket.metadata ?? {}) as Record<string, any>;
    const itemStates = { ...(meta.itemStates ?? {}) };
    if (done) itemStates[orderItemId] = new Date().toISOString();
    else delete itemStates[orderItemId];

    await this.prisma.kdsTicket.update({
      where: { id: ticket.id },
      data: {
        metadata: { ...meta, itemStates } as Prisma.InputJsonValue,
      },
    });

    this.socket.emitToLocation(screen.locationId, "kds:item:state", {
      screenId,
      orderId,
      orderItemId,
      done,
    });

    if (done) await this.markPreparing(orderId);
    return { ok: true, itemStates };
  }

  /**
   * Bump a ticket. Station bumps advance the order (PREPARING on first,
   * READY when every station ticket is done and there's no expo). An expo
   * bump serves the order: READY + any lingering station tickets bumped.
   */
  async bumpTicket(screenId: string, orderId: string, tenantId: string) {
    const screen = await this.assertScreenAccess(screenId, tenantId);
    const settings = (screen.settings ?? {}) as KdsScreenSettings;
    const now = new Date();

    const ticket = await this.prisma.kdsTicket.update({
      where: { kdsScreenId_orderId: { kdsScreenId: screenId, orderId } },
      data: { bumpedAt: now },
      include: TICKET_INCLUDE,
    });

    this.socket.emitToLocation(screen.locationId, "kds:ticket:bumped", {
      screenId,
      orderId,
      bumpedAt: now.toISOString(),
    });

    if (settings.stationType === "EXPO") {
      await this.serveOrder(orderId);
    } else {
      await this.markPreparing(orderId);
      await this.maybeReadyAfterStationBump(orderId);
    }

    return ticket;
  }

  async recallTicket(screenId: string, orderId: string, tenantId: string) {
    const screen = await this.assertScreenAccess(screenId, tenantId);
    const ticket = await this.prisma.kdsTicket.update({
      where: { kdsScreenId_orderId: { kdsScreenId: screenId, orderId } },
      data: { bumpedAt: null, recalledAt: new Date() },
      include: TICKET_INCLUDE,
    });
    this.socket.emitToLocation(screen.locationId, "kds:ticket:recalled", {
      screenId,
      orderId,
    });
    return ticket;
  }

  // ── Dispatch (called by KdsDispatchService / KdsFireCron) ──────────────────

  /**
   * Split an order into station tickets by each active screen's routing
   * rules. A screen with no rules shows the whole order; a screen whose
   * rules match nothing gets no ticket. Channel filters apply per screen.
   */
  async dispatchOrderToScreens(orderId: string, locationId: string) {
    const [screens, order] = await Promise.all([
      this.prisma.kdsScreen.findMany({
        where: { locationId, isActive: true },
      }),
      this.prisma.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      }),
    ]);
    if (!order || screens.length === 0) return { created: 0 };

    // Resolve each order item's menu categories once (routing by category).
    const menuItemIds = order.items
      .map((i) => i.menuItemId)
      .filter((v): v is string => !!v);
    const categoryLinks = menuItemIds.length
      ? await this.prisma.menuItemOnCategory.findMany({
          where: { itemId: { in: menuItemIds } },
          select: { itemId: true, categoryId: true },
        })
      : [];
    const categoriesByMenuItem = new Map<string, Set<string>>();
    for (const link of categoryLinks) {
      const set = categoriesByMenuItem.get(link.itemId) ?? new Set();
      set.add(link.categoryId);
      categoriesByMenuItem.set(link.itemId, set);
    }

    let created = 0;
    for (const screen of screens) {
      const settings = (screen.settings ?? {}) as KdsScreenSettings;

      // Channel filter.
      const channels = settings.channels ?? [];
      if (channels.length && !channels.includes(order.orderSource)) continue;

      // Item routing (expo + rule-less screens always show everything).
      const isExpo = settings.stationType === "EXPO";
      const catRules = settings.categoryIds ?? [];
      const itemRules = settings.itemIds ?? [];
      const modRules = (settings.modifierNames ?? []).map((m) =>
        m.trim().toLowerCase(),
      );
      let routedItemIds: string[] = [];
      if (!isExpo && (catRules.length || itemRules.length || modRules.length)) {
        routedItemIds = order.items
          .filter((it) => {
            if (it.menuItemId && itemRules.includes(it.menuItemId)) return true;
            const cats = it.menuItemId
              ? categoriesByMenuItem.get(it.menuItemId)
              : undefined;
            if (cats && catRules.some((c) => cats.has(c))) return true;
            // Modifier routing — match any of the line's modifier names.
            if (modRules.length) {
              const mods = Array.isArray(it.modifiers)
                ? (it.modifiers as any[])
                : [];
              return mods.some((m) =>
                modRules.includes(String(m?.name ?? "").trim().toLowerCase()),
              );
            }
            return false;
          })
          .map((it) => it.id);
        if (routedItemIds.length === 0) continue; // nothing for this station
      }

      try {
        const ticket = await this.prisma.kdsTicket.upsert({
          where: {
            kdsScreenId_orderId: { kdsScreenId: screen.id, orderId },
          },
          create: {
            kdsScreenId: screen.id,
            orderId,
            metadata: {
              itemIds: routedItemIds,
              itemStates: {},
            } as Prisma.InputJsonValue,
          },
          update: {},
          include: TICKET_INCLUDE,
        });
        created++;
        this.socket.emitToLocation(
          locationId,
          "kds:ticket:new",
          ticket as any,
        );
      } catch (err: any) {
        this.logger.warn(
          `KDS ticket create failed (screen ${screen.id}, order ${orderId}): ${err?.message}`,
        );
      }
    }

    if (created > 0) {
      this.logger.log(
        `KDS: order ${orderId} dispatched to ${created} screen(s) at ${locationId}`,
      );
    }
    return { created };
  }

  /** Void every ticket for a cancelled order and tell the screens. */
  async voidTicketsForOrder(orderId: string, reason?: string) {
    const tickets = await this.prisma.kdsTicket.findMany({
      where: { orderId, bumpedAt: null },
      include: { screen: { select: { locationId: true } } },
    });
    if (tickets.length === 0) return;
    await this.prisma.kdsTicket.deleteMany({
      where: { id: { in: tickets.map((t) => t.id) } },
    });
    const locationId = tickets[0]!.screen.locationId;
    this.socket.emitToLocation(locationId, "kds:ticket:void", {
      orderId,
      reason,
    });
  }

  /** Bump any open tickets for an order that finished outside the KDS. */
  async bumpAllForOrder(orderId: string) {
    const open = await this.prisma.kdsTicket.findMany({
      where: { orderId, bumpedAt: null },
      include: { screen: { select: { id: true, locationId: true } } },
    });
    if (open.length === 0) return;
    const now = new Date();
    await this.prisma.kdsTicket.updateMany({
      where: { id: { in: open.map((t) => t.id) } },
      data: { bumpedAt: now },
    });
    for (const t of open) {
      this.socket.emitToLocation(t.screen.locationId, "kds:ticket:bumped", {
        screenId: t.screen.id,
        orderId,
        bumpedAt: now.toISOString(),
      });
    }
  }

  // ── Order-status side effects ───────────────────────────────────────────

  /** Hook installed by KdsDispatchService (avoids an OrdersModule cycle). */
  onOrderProgress:
    | ((orderId: string, status: "PREPARING" | "READY") => Promise<void>)
    | null = null;

  private async markPreparing(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (order?.status === "ACCEPTED" && this.onOrderProgress) {
      await this.onOrderProgress(orderId, "PREPARING").catch((e) =>
        this.logger.warn(`KDS→PREPARING failed for ${orderId}: ${e?.message}`),
      );
    }
  }

  private async maybeReadyAfterStationBump(orderId: string) {
    // Any open station tickets left? (Expo tickets don't block READY here —
    // expo serving is its own step when an expo screen exists.)
    const tickets = await this.prisma.kdsTicket.findMany({
      where: { orderId },
      include: { screen: { select: { settings: true, isActive: true } } },
    });
    const stations = tickets.filter(
      (t) =>
        ((t.screen.settings ?? {}) as KdsScreenSettings).stationType !==
        "EXPO",
    );
    const expoExists = tickets.length !== stations.length;
    const allStationsDone = stations.every((t) => t.bumpedAt != null);
    if (!allStationsDone) return;
    if (expoExists) return; // expo makes the READY call
    if (this.onOrderProgress) {
      await this.onOrderProgress(orderId, "READY").catch((e) =>
        this.logger.warn(`KDS→READY failed for ${orderId}: ${e?.message}`),
      );
    }
  }

  private async serveOrder(orderId: string) {
    // Expo served the order: bump lingering station tickets + READY.
    await this.bumpAllForOrder(orderId);
    if (this.onOrderProgress) {
      await this.onOrderProgress(orderId, "READY").catch((e) =>
        this.logger.warn(
          `KDS expo→READY failed for ${orderId}: ${e?.message}`,
        ),
      );
    }
  }

  // ── Access guards ──────────────────────────────────────────────────────────

  private async assertLocationAccess(locationId: string, tenantId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc;
  }

  private async assertScreenAccess(screenId: string, tenantId: string) {
    const screen = await this.prisma.kdsScreen.findFirst({
      where: { id: screenId, tenantId },
    });
    if (!screen) throw new NotFoundException("KDS screen not found");
    return screen;
  }
}
