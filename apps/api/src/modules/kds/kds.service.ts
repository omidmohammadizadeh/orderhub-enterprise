import { Injectable, NotFoundException, Logger } from "@nestjs/common";
import type { Prisma } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";

export interface CreateKdsScreenDto {
  name: string;
  station: string;
  settings?: Record<string, unknown>;
}

export interface UpdateKdsScreenDto {
  name?: string;
  station?: string;
  isActive?: boolean;
  settings?: Record<string, unknown>;
}

const TICKET_INCLUDE = {
  order: {
    include: {
      items: true,
      location: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.KdsTicketInclude;

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
      include: { _count: { select: { tickets: true } } },
      orderBy: { name: "asc" },
    });
  }

  async createScreen(locationId: string, tenantId: string, dto: CreateKdsScreenDto) {
    await this.assertLocationAccess(locationId, tenantId);
    return this.prisma.kdsScreen.create({
      data: { tenantId, locationId, name: dto.name, station: dto.station, settings: (dto.settings ?? {}) as any },
    });
  }

  async updateScreen(screenId: string, tenantId: string, dto: UpdateKdsScreenDto) {
    await this.assertScreenAccess(screenId, tenantId);
    return this.prisma.kdsScreen.update({
      where: { id: screenId },
      data: dto as any,
    });
  }

  async removeScreen(screenId: string, tenantId: string) {
    await this.assertScreenAccess(screenId, tenantId);
    await this.prisma.kdsScreen.delete({ where: { id: screenId } });
  }

  // ── Ticket management ─────────────────────────────────────────────────────

  async getActiveTickets(screenId: string, tenantId: string) {
    await this.assertScreenAccess(screenId, tenantId);
    return this.prisma.kdsTicket.findMany({
      where: { kdsScreenId: screenId, bumpedAt: null },
      include: TICKET_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
  }

  async createTicket(screenId: string, orderId: string, tenantId: string) {
    await this.assertScreenAccess(screenId, tenantId);
    const ticket = await this.prisma.kdsTicket.upsert({
      where: { kdsScreenId_orderId: { kdsScreenId: screenId, orderId } },
      create: { kdsScreenId: screenId, orderId },
      update: { bumpedAt: null, recalledAt: new Date() },
      include: TICKET_INCLUDE,
    });

    const screen = await this.prisma.kdsScreen.findUnique({ where: { id: screenId } });
    if (screen) {
      this.socket.emitToLocation(screen.locationId, "kds:ticket:new", ticket as any);
    }

    return ticket;
  }

  async bumpTicket(screenId: string, orderId: string, tenantId: string) {
    await this.assertScreenAccess(screenId, tenantId);
    const ticket = await this.prisma.kdsTicket.update({
      where: { kdsScreenId_orderId: { kdsScreenId: screenId, orderId } },
      data: { bumpedAt: new Date() },
      include: TICKET_INCLUDE,
    });

    const screen = await this.prisma.kdsScreen.findUnique({ where: { id: screenId } });
    if (screen) {
      this.socket.emitToLocation(screen.locationId, "kds:ticket:bumped", {
        screenId,
        orderId,
        bumpedAt: ticket.bumpedAt?.toISOString() ?? null,
      });
    }

    return ticket;
  }

  async recallTicket(screenId: string, orderId: string, tenantId: string) {
    await this.assertScreenAccess(screenId, tenantId);
    const ticket = await this.prisma.kdsTicket.update({
      where: { kdsScreenId_orderId: { kdsScreenId: screenId, orderId } },
      data: { bumpedAt: null, recalledAt: new Date() },
      include: TICKET_INCLUDE,
    });

    const screen = await this.prisma.kdsScreen.findUnique({ where: { id: screenId } });
    if (screen) {
      this.socket.emitToLocation(screen.locationId, "kds:ticket:recalled", {
        screenId,
        orderId,
      });
    }

    return ticket;
  }

  // Dispatch tickets to all active screens at a location when order is received
  async dispatchOrderToScreens(orderId: string, locationId: string) {
    const screens = await this.prisma.kdsScreen.findMany({
      where: { locationId, isActive: true },
    });

    for (const screen of screens) {
      try {
        await this.prisma.kdsTicket.upsert({
          where: { kdsScreenId_orderId: { kdsScreenId: screen.id, orderId } },
          create: { kdsScreenId: screen.id, orderId },
          update: {},
        });
      } catch (err) {
        this.logger.warn(`Failed to create KDS ticket for screen ${screen.id}: ${err}`);
      }
    }

    if (screens.length > 0) {
      const ticket = await this.prisma.kdsTicket.findFirst({
        where: { orderId, kdsScreenId: screens[0]!.id },
        include: TICKET_INCLUDE,
      });
      this.socket.emitToLocation(locationId, "kds:order:new", { orderId, ticket: ticket as any });
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
