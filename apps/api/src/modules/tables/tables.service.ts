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
      },
    });
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
  async seat(tenantId: string, id: string) {
    const t = await this.assertTable(tenantId, id);
    if (t.status === "OCCUPIED") return t; // idempotent
    return this.prisma.table.update({
      where: { id },
      data: { status: "OCCUPIED", openedAt: new Date() },
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
      data: { status: "FREE", currentOrderId: null, openedAt: null },
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
        },
      }),
      this.prisma.table.update({
        where: { id: fromId },
        data: { status: "FREE", currentOrderId: null, openedAt: null },
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
      this.prisma.table.update({
        where: { id: fromId },
        data: { status: "FREE", currentOrderId: null, openedAt: null },
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
