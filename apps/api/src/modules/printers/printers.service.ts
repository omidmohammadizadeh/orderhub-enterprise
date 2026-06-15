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
    await this.assertLocationAccess(locationId, tenantId);
    return this.prisma.printer.findMany({
      where: { locationId },
      orderBy: { name: "asc" },
    });
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
