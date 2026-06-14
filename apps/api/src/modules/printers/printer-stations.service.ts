// Phase AS-1 — PrinterStation CRUD.
//
// First-class station rows per location. Pizza Uno Pelton has its
// own Pizza / Grill / Drinks stations; Pizza Uno Newcastle has its
// own. Each station can point to a default printer that catches
// jobs routed to it.

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export interface CreateStationDto {
  locationId: string;
  name: string;
  kind?:
    | "KITCHEN"
    | "FRONT_COUNTER"
    | "BAR"
    | "LABELS"
    | "DISPATCH"
    | "EXPO"
    | "OTHER";
  defaultPrinterId?: string | null;
  sortOrder?: number;
}

export interface UpdateStationDto {
  name?: string;
  kind?:
    | "KITCHEN"
    | "FRONT_COUNTER"
    | "BAR"
    | "LABELS"
    | "DISPATCH"
    | "EXPO"
    | "OTHER";
  defaultPrinterId?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

@Injectable()
export class PrinterStationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, locationId?: string) {
    return (this.prisma as any).printerStation.findMany({
      where: {
        tenantId,
        ...(locationId && { locationId }),
        isActive: true,
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: {
        defaultPrinter: {
          select: { id: true, name: true, kind: true, connectionType: true },
        },
      },
    });
  }

  async create(tenantId: string, dto: CreateStationDto) {
    // Verify the location belongs to this tenant.
    const loc = await this.prisma.location.findFirst({
      where: { id: dto.locationId, brand: { tenantId } },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found");

    if (dto.defaultPrinterId) {
      await this.assertPrinterBelongsToLocation(
        tenantId,
        dto.locationId,
        dto.defaultPrinterId,
      );
    }

    return (this.prisma as any).printerStation.create({
      data: {
        tenantId,
        locationId: dto.locationId,
        name: dto.name,
        kind: dto.kind ?? "KITCHEN",
        defaultPrinterId: dto.defaultPrinterId ?? null,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async update(tenantId: string, id: string, dto: UpdateStationDto) {
    const station = await (this.prisma as any).printerStation.findUnique({
      where: { id },
    });
    if (!station || station.tenantId !== tenantId) {
      throw new NotFoundException("Station not found");
    }
    if (dto.defaultPrinterId) {
      await this.assertPrinterBelongsToLocation(
        tenantId,
        station.locationId,
        dto.defaultPrinterId,
      );
    }
    return (this.prisma as any).printerStation.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.kind !== undefined && { kind: dto.kind }),
        ...(dto.defaultPrinterId !== undefined && {
          defaultPrinterId: dto.defaultPrinterId,
        }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    const station = await (this.prisma as any).printerStation.findUnique({
      where: { id },
    });
    if (!station || station.tenantId !== tenantId) {
      throw new NotFoundException("Station not found");
    }
    await (this.prisma as any).printerStation.delete({ where: { id } });
    return { ok: true };
  }

  // ── Routing rule management (MenuItem / Category / ModifierGroup) ──

  async setMenuItemRoutes(
    tenantId: string,
    menuItemId: string,
    stationIds: string[],
  ) {
    await this.assertItemBelongsToTenant(tenantId, menuItemId);
    await (this.prisma as any).menuItemStation.deleteMany({
      where: { menuItemId },
    });
    if (stationIds.length) {
      await (this.prisma as any).menuItemStation.createMany({
        data: stationIds.map((stationId: string) => ({
          menuItemId,
          stationId,
        })),
      });
    }
    return { ok: true };
  }

  async setCategoryRoutes(
    tenantId: string,
    categoryId: string,
    stationIds: string[],
  ) {
    await (this.prisma as any).menuCategoryStation.deleteMany({
      where: { categoryId },
    });
    if (stationIds.length) {
      await (this.prisma as any).menuCategoryStation.createMany({
        data: stationIds.map((stationId: string) => ({
          categoryId,
          stationId,
        })),
      });
    }
    return { ok: true };
  }

  async setModifierGroupRoutes(
    tenantId: string,
    modifierGroupId: string,
    stationIds: string[],
  ) {
    await (this.prisma as any).modifierGroupStation.deleteMany({
      where: { modifierGroupId },
    });
    if (stationIds.length) {
      await (this.prisma as any).modifierGroupStation.createMany({
        data: stationIds.map((stationId: string) => ({
          modifierGroupId,
          stationId,
        })),
      });
    }
    return { ok: true };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private async assertPrinterBelongsToLocation(
    tenantId: string,
    locationId: string,
    printerId: string,
  ) {
    const printer = await (this.prisma as any).printer.findFirst({
      where: { id: printerId, tenantId, locationId },
      select: { id: true },
    });
    if (!printer) {
      throw new BadRequestException(
        "Printer doesn't belong to this location.",
      );
    }
  }

  private async assertItemBelongsToTenant(
    tenantId: string,
    menuItemId: string,
  ) {
    const item = await this.prisma.menuItem.findFirst({
      where: {
        id: menuItemId,
        brandId: {
          in: (
            await this.prisma.brand.findMany({
              where: { tenantId },
              select: { id: true },
            })
          ).map((b) => b.id),
        },
      },
      select: { id: true },
    });
    if (!item) throw new NotFoundException("Menu item not found");
  }
}
