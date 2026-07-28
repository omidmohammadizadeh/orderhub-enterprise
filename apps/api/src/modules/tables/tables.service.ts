import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Table Tabs (dine-in) — physical tables at a location and their open/free
// state. A "tab" is one growing DINE_IN order per table (created lazily on the
// first "send to kitchen"); Table.currentOrderId points at it and status flips
// FREE↔OCCUPIED. Settling/closing is done through the existing payment path and
// then `free()`s the table. All methods are tenant-scoped (tenantId from JWT).

interface UpsertTableInput {
  locationId: string;
  name: string;
  seats?: number | null;
  area?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  // Floor plan
  posX?: number | null;
  posY?: number | null;
  shape?: string;
  width?: number;
  height?: number;
  // Availability
  bookableOnline?: boolean;
  outOfService?: boolean;
  outOfServiceNote?: string | null;
  // QR at table
  qrEnabled?: boolean;
}

/** One tile's position, as the floor-plan editor saves them in bulk. */
export interface LayoutNode {
  id: string;
  posX: number;
  posY: number;
  shape?: string;
  width?: number;
  height?: number;
  area?: string | null;
}

const SHAPES = new Set(["SQUARE", "ROUND", "RECT"]);

// QR tokens are guessable-proof but readable enough to support over the
// phone. No l/1/0/O.
const TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomToken(len = 12): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
  }
  return out;
}

@Injectable()
export class TablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // A location belongs to the tenant only via its brand (Location has no
  // tenantId column) — mirror the check used across menus/signage.
  private async assertLocation(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc;
  }

  private async assertTable(tenantId: string, id: string) {
    const t = await this.prisma.table.findFirst({ where: { id, tenantId } });
    if (!t) throw new NotFoundException("Table not found");
    return t;
  }

  async list(tenantId: string, locationId?: string) {
    return this.prisma.table.findMany({
      where: { tenantId, ...(locationId ? { locationId } : {}) },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  }

  async create(tenantId: string, input: UpsertTableInput) {
    if (!input.name?.trim()) throw new BadRequestException("Name is required");
    await this.assertLocation(tenantId, input.locationId);
    return this.prisma.table.create({
      data: {
        tenantId,
        locationId: input.locationId,
        name: input.name.trim(),
        seats: input.seats ?? null,
        area: input.area?.trim() || null,
        sortOrder: input.sortOrder ?? 0,
        isActive: input.isActive ?? true,
      },
    });
  }

  async update(tenantId: string, id: string, input: Partial<UpsertTableInput>) {
    await this.assertTable(tenantId, id);
    return this.prisma.table.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.seats !== undefined ? { seats: input.seats } : {}),
        ...(input.area !== undefined
          ? { area: input.area?.trim() || null }
          : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.posX !== undefined ? { posX: input.posX } : {}),
        ...(input.posY !== undefined ? { posY: input.posY } : {}),
        ...(input.shape !== undefined && SHAPES.has(input.shape)
          ? { shape: input.shape }
          : {}),
        ...(input.width !== undefined
          ? { width: Math.max(1, Math.min(6, Math.round(input.width))) }
          : {}),
        ...(input.height !== undefined
          ? { height: Math.max(1, Math.min(6, Math.round(input.height))) }
          : {}),
        ...(input.bookableOnline !== undefined
          ? { bookableOnline: input.bookableOnline }
          : {}),
        ...(input.outOfService !== undefined
          ? { outOfService: input.outOfService }
          : {}),
        ...(input.outOfServiceNote !== undefined
          ? { outOfServiceNote: input.outOfServiceNote?.trim() || null }
          : {}),
        ...(input.qrEnabled !== undefined ? { qrEnabled: input.qrEnabled } : {}),
      },
    });
  }

  /**
   * Save the whole floor plan in one go. The editor is drag-and-drop, so
   * it sends every tile's final position at once rather than a PATCH per
   * nudge — one round trip, and the layout can never be left half-saved
   * with two tables sitting on the same cell.
   */
  async saveLayout(tenantId: string, locationId: string, nodes: LayoutNode[]) {
    await this.assertLocation(tenantId, locationId);
    const owned = await this.prisma.table.findMany({
      where: { tenantId, locationId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((t) => t.id));
    const clean = (nodes ?? []).filter((n) => n?.id && ownedIds.has(n.id));
    if (!clean.length) return this.list(tenantId, locationId);

    await this.prisma.$transaction(
      clean.map((n) =>
        this.prisma.table.update({
          where: { id: n.id },
          data: {
            posX: Math.max(0, Math.round(Number(n.posX) || 0)),
            posY: Math.max(0, Math.round(Number(n.posY) || 0)),
            ...(n.shape && SHAPES.has(n.shape) ? { shape: n.shape } : {}),
            ...(n.width
              ? { width: Math.max(1, Math.min(6, Math.round(n.width))) }
              : {}),
            ...(n.height
              ? { height: Math.max(1, Math.min(6, Math.round(n.height))) }
              : {}),
            ...(n.area !== undefined ? { area: n.area?.trim() || null } : {}),
          },
        }),
      ),
    );
    return this.list(tenantId, locationId);
  }

  /**
   * Take a table out of service (or put it back). Blocks BOTH walk-in
   * seating and online booking — this is the "it's broken / we're
   * holding it back" switch, distinct from bookableOnline which only
   * stops the internet from taking it.
   *
   * Refuses while a tab is open: pulling a table with live food on it
   * would strand the bill.
   */
  async setOutOfService(
    tenantId: string,
    id: string,
    outOfService: boolean,
    note?: string | null,
  ) {
    const t = await this.assertTable(tenantId, id);
    if (outOfService && t.currentOrderId) {
      throw new BadRequestException(
        "This table has an open tab — settle it before taking the table out of service.",
      );
    }
    return this.prisma.table.update({
      where: { id },
      data: {
        outOfService,
        outOfServiceNote: outOfService ? note?.trim() || null : null,
      },
    });
  }

  /** Allow / stop guests reserving this table online. */
  async setBookableOnline(tenantId: string, id: string, bookable: boolean) {
    await this.assertTable(tenantId, id);
    return this.prisma.table.update({
      where: { id },
      data: { bookableOnline: bookable },
    });
  }

  /**
   * Covers (how many guests) + who's serving. Covers also lands on the
   * order so spend-per-head survives the table being freed and re-seated
   * later the same night.
   */
  async setSitting(
    tenantId: string,
    id: string,
    input: { covers?: number | null; serverId?: string | null; serverName?: string | null },
  ) {
    const t = await this.assertTable(tenantId, id);
    const covers =
      input.covers === null || input.covers === undefined
        ? input.covers === null
          ? null
          : undefined
        : Math.max(0, Math.min(200, Math.round(Number(input.covers))));

    const table = await this.prisma.table.update({
      where: { id },
      data: {
        ...(covers !== undefined ? { covers } : {}),
        ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
        ...(input.serverName !== undefined
          ? { serverName: input.serverName?.trim() || null }
          : {}),
      },
    });
    if (covers !== undefined && t.currentOrderId) {
      await this.prisma.order
        .update({ where: { id: t.currentOrderId }, data: { covers } })
        .catch(() => undefined);
    }
    return table;
  }

  /**
   * Mint (or rotate) this table's QR token. Rotating invalidates any
   * sticker already on the table — that's the point: a photographed code
   * can be killed without renaming the table or losing its history.
   */
  async rotateQrToken(tenantId: string, id: string) {
    await this.assertTable(tenantId, id);
    // Retry on the (vanishingly unlikely) unique collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.prisma.table.update({
          where: { id },
          data: { qrToken: randomToken(), qrEnabled: true },
        });
      } catch (e: any) {
        if (e?.code !== "P2002" || attempt === 4) throw e;
      }
    }
    throw new BadRequestException("Could not allocate a QR code, try again");
  }

  async remove(tenantId: string, id: string) {
    const t = await this.assertTable(tenantId, id);
    if (t.status === "OCCUPIED") {
      throw new BadRequestException(
        "This table has an open tab — settle or clear it before deleting.",
      );
    }
    await this.prisma.table.delete({ where: { id } });
    return { ok: true };
  }

  /** Seat a free table (opens the tab; the order is created on first send). */
  async seat(
    tenantId: string,
    id: string,
    input?: { covers?: number | null; serverId?: string | null; serverName?: string | null },
  ) {
    const t = await this.assertTable(tenantId, id);
    if (t.outOfService) {
      throw new BadRequestException(
        t.outOfServiceNote
          ? `${t.name} is out of service — ${t.outOfServiceNote}`
          : `${t.name} is out of service`,
      );
    }
    if (t.status === "OCCUPIED" && !input) return t; // idempotent
    return this.prisma.table.update({
      where: { id },
      data: {
        status: "OCCUPIED",
        openedAt: t.openedAt ?? new Date(),
        ...(input?.covers !== undefined
          ? { covers: Math.max(0, Math.min(200, Math.round(Number(input.covers) || 0))) }
          : {}),
        ...(input?.serverId !== undefined ? { serverId: input.serverId } : {}),
        ...(input?.serverName !== undefined
          ? { serverName: input.serverName?.trim() || null }
          : {}),
      },
    });
  }

  /** Attach the tab's order to the table (called when the first round creates it). */
  async linkOrder(tenantId: string, id: string, orderId: string) {
    await this.assertTable(tenantId, id);
    return this.prisma.table.update({
      where: { id },
      data: { status: "OCCUPIED", currentOrderId: orderId },
    });
  }

  /** Free a table after the tab is settled/closed (or cancelled). */
  async free(tenantId: string, id: string) {
    await this.assertTable(tenantId, id);
    return this.prisma.table.update({
      where: { id },
      data: {
        status: "FREE",
        currentOrderId: null,
        openedAt: null,
        // The next party is a new sitting — never inherit the last one's
        // guest count or server.
        covers: null,
        serverId: null,
        serverName: null,
      },
    });
  }

  /**
   * MOVE a tab to another table — the party changed seats. The order follows
   * (Order.tableId + the new table's currentOrderId); the old table frees.
   * The destination must be free, otherwise use merge().
   */
  async moveTab(tenantId: string, fromId: string, toId: string) {
    if (fromId === toId) throw new BadRequestException("Same table");
    const from = await this.assertTable(tenantId, fromId);
    const to = await this.assertTable(tenantId, toId);
    if (from.locationId !== to.locationId) {
      throw new BadRequestException("Tables are at different locations");
    }
    if (!from.currentOrderId) {
      throw new BadRequestException("That table has no open tab to move");
    }
    if (to.currentOrderId) {
      throw new BadRequestException(
        `${to.name} already has an open tab — use merge instead`,
      );
    }
    const orderId = from.currentOrderId;
    const [, movedTo] = await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id: orderId },
        data: { tableId: toId },
      }),
      this.prisma.table.update({
        where: { id: toId },
        data: {
          status: "OCCUPIED",
          currentOrderId: orderId,
          openedAt: from.openedAt ?? new Date(),
          // The same party, in different seats — their guest count and
          // server move with them.
          covers: from.covers,
          serverId: from.serverId,
          serverName: from.serverName,
        },
      }),
      this.prisma.table.update({
        where: { id: fromId },
        data: {
          status: "FREE",
          currentOrderId: null,
          openedAt: null,
          covers: null,
          serverId: null,
          serverName: null,
        },
      }),
    ]);
    return movedTo;
  }

  /**
   * MERGE two tabs — two tables became one party. Every item on the source
   * tab moves onto the destination order, the destination's money is lifted
   * by the source total, the source order is CANCELLED (it never existed as
   * a separate bill) and the source table frees.
   */
  async mergeTabs(tenantId: string, fromId: string, intoId: string) {
    if (fromId === intoId) throw new BadRequestException("Same table");
    const from = await this.assertTable(tenantId, fromId);
    const into = await this.assertTable(tenantId, intoId);
    if (!from.currentOrderId || !into.currentOrderId) {
      throw new BadRequestException("Both tables need an open tab to merge");
    }
    const [src, dst] = await Promise.all([
      this.prisma.order.findFirst({
        where: { id: from.currentOrderId, tenantId },
        include: { items: true },
      }),
      this.prisma.order.findFirst({
        where: { id: into.currentOrderId, tenantId },
      }),
    ]);
    if (!src || !dst) throw new NotFoundException("Tab order not found");
    if (src.paymentStatus === "PAID" || dst.paymentStatus === "PAID") {
      throw new BadRequestException("Can't merge a tab that's already settled");
    }

    await this.prisma.$transaction([
      // Re-point the items rather than copying, so KDS tick-states and any
      // history that references the item ids stay valid.
      this.prisma.orderItem.updateMany({
        where: { orderId: src.id },
        data: { orderId: dst.id },
      }),
      this.prisma.order.update({
        where: { id: dst.id },
        data: {
          subtotal: Number(dst.subtotal) + Number(src.subtotal),
          total: Number(dst.total) + Number(src.total),
          updatedAt: new Date(),
        },
      }),
      this.prisma.order.update({
        where: { id: src.id },
        data: { status: "CANCELLED", tableId: null },
      }),
      // Two tables became one party: their covers add up.
      this.prisma.table.update({
        where: { id: intoId },
        data: {
          covers:
            from.covers != null || into.covers != null
              ? (from.covers ?? 0) + (into.covers ?? 0)
              : null,
        },
      }),
      this.prisma.table.update({
        where: { id: fromId },
        data: {
          status: "FREE",
          currentOrderId: null,
          openedAt: null,
          covers: null,
          serverId: null,
          serverName: null,
        },
      }),
    ]);

    // Kitchen screens must re-render the destination ticket with the merged
    // lines, and drop the cancelled source ticket.
    this.events.emit("order.items_edited", {
      orderId: dst.id,
      locationId: dst.locationId,
    });
    this.events.emit("order.cancelled", {
      orderId: src.id,
      locationId: src.locationId,
    });
    return this.prisma.table.findUnique({ where: { id: intoId } });
  }
}
