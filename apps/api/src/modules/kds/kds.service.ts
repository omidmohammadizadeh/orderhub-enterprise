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
    // Every screen that ever served an order has KdsTicket rows pointing at
    // it, and the FK has no cascade — a bare delete 500s with
    // kds_tickets_kdsScreenId_fkey. Tickets are per-screen working state
    // (the order itself is untouched), so drop them with the screen.
    await this.prisma.$transaction([
      this.prisma.kdsTicket.deleteMany({ where: { kdsScreenId: screenId } }),
      this.prisma.kdsScreen.delete({ where: { id: screenId } }),
    ]);
  }

  // ── Tickets ────────────────────────────────────────────────────────────────

  async getActiveTickets(screenId: string, tenantId: string) {
    await this.assertScreenAccess(screenId, tenantId);
    const rows = await this.prisma.kdsTicket.findMany({
      where: {
        kdsScreenId: screenId,
        bumpedAt: null,
        order: { status: { in: [...ACTIVE_ORDER_STATUSES] } },
      },
      include: TICKET_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
    return this.attachTableNames(rows);
  }

  /** Recently bumped tickets — the recall rail. */
  async getRecentBumped(screenId: string, tenantId: string, take = 8) {
    await this.assertScreenAccess(screenId, tenantId);
    const rows = await this.prisma.kdsTicket.findMany({
      where: { kdsScreenId: screenId, bumpedAt: { not: null } },
      include: TICKET_INCLUDE,
      orderBy: { bumpedAt: "desc" },
      take,
    });
    return this.attachTableNames(rows);
  }

  /** Table Tabs — dine-in tickets show WHICH table on the kitchen screen.
   *  Order.tableId is a plain column (no Prisma relation), so resolve the
   *  table names in one indexed lookup and stamp them onto order.tableName. */
  private async attachTableNames<T extends { order: any }>(
    tickets: T[],
  ): Promise<T[]> {
    const ids = [
      ...new Set(
        tickets
          .map((t) => t.order?.tableId as string | null | undefined)
          .filter((id): id is string => !!id),
      ),
    ];
    if (!ids.length) return tickets;
    const tables = await this.prisma.table.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const byId = new Map(tables.map((t) => [t.id, t.name]));
    for (const t of tickets) {
      if (t.order?.tableId) {
        t.order.tableName = byId.get(t.order.tableId) ?? null;
      }
    }
    return tickets;
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
   * Tick/untick a single line OR one of its modifiers on a station ticket.
   * State keys: the OrderItem id for the line, `${orderItemId}::${modIdx}`
   * for a modifier — so a cook can confirm every component individually and
   * nothing is missed. First tick moves an ACCEPTED order to PREPARING; when
   * EVERY routed line and all its modifiers are ticked, the ticket
   * auto-completes (same progression as a manual bump → order READY).
   */
  async setItemState(
    screenId: string,
    orderId: string,
    orderItemId: string,
    done: boolean,
    tenantId: string,
    modifierIndex?: number,
  ) {
    const screen = await this.assertScreenAccess(screenId, tenantId);
    const ticket = await this.prisma.kdsTicket.findUnique({
      where: { kdsScreenId_orderId: { kdsScreenId: screenId, orderId } },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const key =
      modifierIndex != null ? `${orderItemId}::${modifierIndex}` : orderItemId;

    // Cross-screen sync: a line ticked done on ANY station is done for the
    // whole kitchen — the grill striking "12\" Vegetarian" must show struck on
    // the wrapping/expo screens that carry the same line too. So write the
    // state onto EVERY ticket of this order (each screen still renders only
    // its own routed items, so unrelated stations are unaffected).
    const siblings = await this.prisma.kdsTicket.findMany({
      where: { orderId },
      select: { id: true, kdsScreenId: true, metadata: true },
    });
    let itemStates: Record<string, string> = {};
    for (const t of siblings) {
      const meta = (t.metadata ?? {}) as Record<string, any>;
      const states = { ...(meta.itemStates ?? {}) };
      if (done) states[key] = new Date().toISOString();
      else delete states[key];
      await this.prisma.kdsTicket.update({
        where: { id: t.id },
        data: {
          metadata: { ...meta, itemStates: states } as Prisma.InputJsonValue,
        },
      });
      if (t.kdsScreenId === screenId) itemStates = states;
    }

    this.socket.emitToLocation(screen.locationId, "kds:item:state", {
      screenId,
      orderId,
      orderItemId,
      done,
    });

    // Ticking is progress tracking only — the first tick moves the order to
    // PREPARING, but the ticket leaves the screen ONLY on an explicit BUMP
    // (or when the order is marked READY from the order tab). This keeps the
    // cook in control of when the bag is actually done.
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
    return this.applyBump(screen, orderId);
  }

  /** Bump core — shared by manual bump and auto-complete. */
  private async applyBump(
    screen: { id: string; locationId: string; settings: unknown },
    orderId: string,
  ) {
    const settings = (screen.settings ?? {}) as KdsScreenSettings;
    const now = new Date();

    const ticket = await this.prisma.kdsTicket.update({
      where: { kdsScreenId_orderId: { kdsScreenId: screen.id, orderId } },
      data: { bumpedAt: now },
      include: TICKET_INCLUDE,
    });

    this.socket.emitToLocation(screen.locationId, "kds:ticket:bumped", {
      screenId: screen.id,
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

  /**
   * Re-sync an order's tickets after a POS edit changed its items. The edit
   * deletes + recreates OrderItems (new ids), so we re-resolve routing per
   * screen, refresh each ticket's routed-item set, drop tick states that no
   * longer apply, un-bump (the kitchen must re-check the changed order), and
   * flag the ticket updated so the display shows an "updated" alert. If the
   * order now has no ticket on a screen (didn't before, or newly matches),
   * dispatch fills the gap.
   */
  async resyncOrderTickets(orderId: string, locationId: string) {
    const existing = await this.prisma.kdsTicket.findMany({
      where: { orderId },
      include: { screen: true },
    });
    // No tickets at all. For a PENDING order that's normal (dispatch happens
    // on accept). But an ACTIVE order with zero tickets means its original
    // dispatch was LOST (e.g. the API restarted mid-accept during a deploy)
    // — without this, every later round/edit succeeds on the server yet
    // never reaches any screen. Heal it: run the full dispatch now.
    if (existing.length === 0) {
      const orderRow = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      if (
        orderRow &&
        ["ACCEPTED", "PREPARING", "READY"].includes(String(orderRow.status))
      ) {
        this.logger.warn(
          `KDS resync: order ${orderId} is ${orderRow.status} with NO tickets — running full dispatch to heal`,
        );
        const healed = await this.dispatchOrderToScreens(orderId, locationId);
        this.socket.emitToLocation(locationId, "kds:order:updated", { orderId });
        return { updated: healed.created };
      }
      return { updated: 0 };
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) return { updated: 0 };

    const routingByScreen = await this.computeRouting(order);
    const now = new Date().toISOString();
    let updated = 0;
    for (const ticket of existing) {
      const routed = routingByScreen.get(ticket.kdsScreenId);
      // Station no longer receives anything from this order → void its ticket.
      if (routed === null) {
        await this.prisma.kdsTicket.delete({ where: { id: ticket.id } });
        continue;
      }
      const meta = (ticket.metadata ?? {}) as Record<string, any>;
      const validIds = new Set(order.items.map((i) => i.id));
      const prunedStates: Record<string, string> = {};
      for (const [k, v] of Object.entries(meta.itemStates ?? {})) {
        const itemId = k.split("::")[0]!;
        if (validIds.has(itemId)) prunedStates[k] = v as string;
      }
      await this.prisma.kdsTicket.update({
        where: { id: ticket.id },
        data: {
          bumpedAt: null, // re-open so the kitchen re-checks the edit
          metadata: {
            ...meta,
            itemIds: routed ?? [],
            itemStates: prunedStates,
            updatedAt: now,
          } as Prisma.InputJsonValue,
        },
      });
      updated++;
    }

    // Screens that route items from this order but have NO ticket yet — e.g.
    // a dine-in round adds the first drinks line for the bar screen, or a
    // POS edit adds an item for a station that had nothing in round 1. The
    // docstring always promised "dispatch fills the gap"; now it does.
    const existingScreenIds = new Set(existing.map((t) => t.kdsScreenId));
    for (const [screenId, routed] of routingByScreen) {
      if (routed === null || existingScreenIds.has(screenId)) continue;
      try {
        const ticket = await this.prisma.kdsTicket.upsert({
          where: { kdsScreenId_orderId: { kdsScreenId: screenId, orderId } },
          create: {
            kdsScreenId: screenId,
            orderId,
            metadata: {
              itemIds: routed ?? [],
              itemStates: {},
              updatedAt: now,
            } as Prisma.InputJsonValue,
          },
          update: {},
          include: TICKET_INCLUDE,
        });
        updated++;
        this.socket.emitToLocation(locationId, "kds:ticket:new", ticket as any);
      } catch (err: any) {
        this.logger.warn(
          `KDS resync ticket create failed (screen ${screenId}, order ${orderId}): ${err?.message}`,
        );
      }
    }

    this.socket.emitToLocation(locationId, "kds:order:updated", { orderId });
    return { updated };
  }

  /**
   * Compute, per active screen at the order's location, which OrderItem ids
   * route there: [] = whole order, string[] = subset, null = nothing (no
   * ticket). Shared by dispatch + resync. Channel-filtered screens that
   * exclude this order also return null.
   */
  private async computeRouting(order: {
    locationId: string;
    orderSource: string;
    items: Array<{ id: string; menuItemId: string | null; modifiers: unknown }>;
  }): Promise<Map<string, string[] | null>> {
    const screens = await this.prisma.kdsScreen.findMany({
      where: { locationId: order.locationId, isActive: true },
    });
    const menuItemIds = order.items
      .map((i) => i.menuItemId)
      .filter((v): v is string => !!v);
    const categoryLinks = menuItemIds.length
      ? await this.prisma.menuItemOnCategory.findMany({
          where: { itemId: { in: menuItemIds } },
          select: { itemId: true, categoryId: true },
        })
      : [];
    const catsByItem = new Map<string, Set<string>>();
    for (const link of categoryLinks) {
      const set = catsByItem.get(link.itemId) ?? new Set();
      set.add(link.categoryId);
      catsByItem.set(link.itemId, set);
    }

    const out = new Map<string, string[] | null>();
    for (const screen of screens) {
      const settings = (screen.settings ?? {}) as KdsScreenSettings;
      const channels = settings.channels ?? [];
      if (channels.length && !channels.includes(order.orderSource)) {
        out.set(screen.id, null);
        continue;
      }
      const isExpo = settings.stationType === "EXPO";
      const catRules = settings.categoryIds ?? [];
      const itemRules = settings.itemIds ?? [];
      const modRules = (settings.modifierNames ?? []).map((m) =>
        m.trim().toLowerCase(),
      );
      if (isExpo || (!catRules.length && !itemRules.length && !modRules.length)) {
        out.set(screen.id, []); // whole order
        continue;
      }
      const routedIds = order.items
        .filter((it) => {
          if (it.menuItemId && itemRules.includes(it.menuItemId)) return true;
          const cats = it.menuItemId ? catsByItem.get(it.menuItemId) : undefined;
          if (cats && catRules.some((c) => cats.has(c))) return true;
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
      out.set(screen.id, routedIds.length ? routedIds : null);
    }
    return out;
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
