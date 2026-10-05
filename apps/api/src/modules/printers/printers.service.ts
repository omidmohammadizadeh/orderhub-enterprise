import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";

@Injectable()
export class PrintersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
  ) {}

  async findByLocation(locationId: string, tenantId: string) {
    const loc = await this.assertLocationAccess(locationId, tenantId);
    const printers = await this.prisma.printer.findMany({
      where: { locationId },
      orderBy: { name: "asc" },
    });
    // Surface which printer the location auto-prints receipts to, so the
    // Printers page can show the "Auto-print" badge and toggle without a
    // second round-trip. receiptPrinterId lives on Location.
    return printers.map((p) => ({
      ...p,
      isReceiptDefault: loc.receiptPrinterId === p.id,
    }));
  }

  /**
   * Everything a printer can be limited to at this shop: category names and
   * products, with each product's category names.
   *
   * Categories go out by NAME, not id. A shop running three brands has three
   * "Drinks" categories, and the bar printer wants all of them; a cloned or
   * republished menu also mints fresh ids, which would quietly empty a filter
   * kept by id. Products carry their id (order lines reference it) and name
   * (marketplace lines often arrive without a menuItemId).
   *
   * Menus in scope: built for this location, assigned to it on any channel,
   * or the location's own brand's shared (location-less) menus.
   */
  async printFilterCatalog(locationId: string, tenantId: string) {
    const loc = await this.assertLocationAccess(locationId, tenantId);
    const assigned = await this.prisma.menuChannelAssignment.findMany({
      where: { locationId },
      select: { menuId: true },
    });
    const menus = await this.prisma.menu.findMany({
      where: {
        deletedAt: null,
        brand: { tenantId },
        OR: [
          { locationId },
          { id: { in: assigned.map((a) => a.menuId) } },
          ...(loc.brandId ? [{ locationId: null, brandId: loc.brandId }] : []),
        ],
      },
      select: { id: true },
    });
    const menuIds = menus.map((m) => m.id);
    if (!menuIds.length) return { categories: [], items: [] };

    const cats = await this.prisma.menuCategory.findMany({
      where: {
        OR: [{ menuId: { in: menuIds } }, { menuIds: { hasSome: menuIds } }],
      },
      select: {
        name: true,
        items: { select: { item: { select: { id: true, name: true } } } },
      },
    });

    const catNames = new Map<string, { name: string; itemCount: number }>();
    const items = new Map<string, { id: string; name: string; categories: Set<string> }>();
    for (const c of cats) {
      const name = (c.name ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const entry = catNames.get(key) ?? { name, itemCount: 0 };
      entry.itemCount += c.items.length;
      catNames.set(key, entry);
      for (const link of c.items) {
        const it = link.item;
        if (!it) continue;
        const row = items.get(it.id) ?? { id: it.id, name: it.name, categories: new Set<string>() };
        row.categories.add(name);
        items.set(it.id, row);
      }
    }
    return {
      categories: Array.from(catNames.values()).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      items: Array.from(items.values())
        .map((i) => ({ id: i.id, name: i.name, categories: Array.from(i.categories) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Point (or unpoint) this location's auto-print receipt slot at the
   *  given printer. This is the single switch that turns automatic
   *  order printing on/off — the routing engine prints CUSTOMER_RECEIPT
   *  to Location.receiptPrinterId. */
  async setReceiptDefault(printerId: string, tenantId: string, active: boolean) {
    const printer = await this.assertPrinterAccess(printerId, tenantId);
    await this.prisma.location.update({
      where: { id: printer.locationId },
      data: { receiptPrinterId: active ? printer.id : null },
    });
    return { ok: true, receiptPrinterId: active ? printer.id : null };
  }

  async create(
    locationId: string,
    tenantId: string,
    data: Prisma.PrinterCreateWithoutLocationInput,
  ) {
    await this.assertLocationAccess(locationId, tenantId);
    // Phase AS-1 — tenantId is now NOT NULL on printers (matches Prisma
    // schema). Wire it from the authenticated caller rather than
    // hoping the data blob carried it.
    const printer = await this.prisma.printer.create({
      data: { ...data, locationId, tenantId } as any,
    });

    // Auto-bind empty location slots. A first-time setup typically has
    // ONE printer per location; without this the operator has to dig
    // into Location settings to nominate it as the receipt / dispatch
    // printer, and the reprint flow silently does nothing because the
    // routing engine has no target. Only fills slots that are still
    // null — never steals a binding the operator already set.
    const type = (data as any).type as string | undefined;
    const loc = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { receiptPrinterId: true, dispatchPrinterId: true },
    });
    const patch: { receiptPrinterId?: string; dispatchPrinterId?: string } = {};
    if (type === "RECEIPT" && !loc?.receiptPrinterId) {
      patch.receiptPrinterId = printer.id;
    }
    if (type === "DISPATCH" && !loc?.dispatchPrinterId) {
      patch.dispatchPrinterId = printer.id;
    }
    if (Object.keys(patch).length) {
      await this.prisma.location.update({
        where: { id: locationId },
        data: patch,
      });
    }

    return printer;
  }

  async update(
    printerId: string,
    tenantId: string,
    data: Prisma.PrinterUpdateInput,
  ) {
    const printer = await this.assertPrinterAccess(printerId, tenantId);
    return this.prisma.printer.update({
      where: { id: printerId },
      data,
    });
  }

  async delete(printerId: string, tenantId: string) {
    await this.assertPrinterAccess(printerId, tenantId);
    await this.prisma.printer.delete({ where: { id: printerId } });
  }

  // Called by the print processor heartbeat / hardware agent
  async setOnlineStatus(printerId: string, isOnline: boolean) {
    const printer = await this.prisma.printer.update({
      where: { id: printerId },
      data: { isOnline },
    });
    this.socket.emitToLocation(printer.locationId, "printer:status", {
      printerId,
      locationId: printer.locationId,
      isOnline,
    });
    return printer;
  }

  async getJobs(printerId: string, tenantId: string, limit = 50) {
    await this.assertPrinterAccess(printerId, tenantId);
    return this.prisma.printJob.findMany({
      where: { printerId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  private async assertLocationAccess(locationId: string, tenantId: string) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
    });
    if (!location) throw new NotFoundException("Location not found");
    return location;
  }

  private async assertPrinterAccess(printerId: string, tenantId: string) {
    const printer = await this.prisma.printer.findFirst({
      where: { id: printerId, location: { brand: { tenantId } } },
    });
    if (!printer) throw new NotFoundException("Printer not found");
    return printer;
  }
}
