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
    return this.prisma.printer.create({
      data: { ...data, locationId, tenantId } as any,
    });
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
