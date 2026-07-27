import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
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
  constructor(private readonly prisma: PrismaService) {}

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
}
