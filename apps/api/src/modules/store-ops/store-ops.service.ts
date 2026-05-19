import { Injectable, NotFoundException, BadRequestException, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";

export interface UpdateStoreStatusDto {
  isOpen?: boolean;
  isPaused?: boolean;
  pauseMinutes?: number;   // pause for N minutes (sets pauseUntil)
  busyMode?: boolean;
  currentPrepTime?: number;
  throttleLimit?: number | null;
  storeStatusNote?: string | null;
}

export interface HolidayScheduleDto {
  date: string;     // YYYY-MM-DD
  isOpen: boolean;
  openTime?: string;  // HH:MM
  closeTime?: string; // HH:MM
  note?: string;
}

@Injectable()
export class StoreOpsService {
  private readonly logger = new Logger(StoreOpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
  ) {}

  async getStatus(locationId: string, tenantId: string) {
    const location = await this.assertAccess(locationId, tenantId);
    return this.buildStatusView(location);
  }

  async getStatusByBrand(brandId: string, tenantId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
    });
    if (!brand) throw new NotFoundException("Brand not found");

    const locations = await this.prisma.location.findMany({
      where: { brandId, deletedAt: null },
      select: {
        id: true, name: true, slug: true, timezone: true,
        isOpen: true, isPaused: true, pauseUntil: true,
        busyMode: true, currentPrepTime: true, throttleLimit: true,
        storeStatusNote: true, isActive: true,
      },
      orderBy: { name: "asc" },
    });

    return locations.map(this.buildStatusView);
  }

  async updateStatus(locationId: string, tenantId: string, dto: UpdateStoreStatusDto) {
    const location = await this.assertAccess(locationId, tenantId);

    const data: Record<string, unknown> = {};

    if (dto.isOpen !== undefined) data.isOpen = dto.isOpen;
    if (dto.isPaused !== undefined) data.isPaused = dto.isPaused;
    if (dto.busyMode !== undefined) data.busyMode = dto.busyMode;
    if (dto.storeStatusNote !== undefined) data.storeStatusNote = dto.storeStatusNote;
    if (dto.throttleLimit !== undefined) data.throttleLimit = dto.throttleLimit;

    if (dto.currentPrepTime !== undefined) {
      if (dto.currentPrepTime < 1 || dto.currentPrepTime > 120) {
        throw new BadRequestException("prepTime must be between 1 and 120 minutes");
      }
      data.currentPrepTime = dto.currentPrepTime;
    }

    if (dto.pauseMinutes !== undefined) {
      if (dto.pauseMinutes <= 0) {
        // pauseMinutes=0 clears the pause
        data.isPaused = false;
        data.pauseUntil = null;
      } else {
        data.isPaused = true;
        data.pauseUntil = new Date(Date.now() + dto.pauseMinutes * 60_000);
      }
    }

    const updated = await this.prisma.location.update({
      where: { id: locationId },
      data,
      select: {
        id: true, name: true, slug: true, timezone: true,
        isOpen: true, isPaused: true, pauseUntil: true,
        busyMode: true, currentPrepTime: true, throttleLimit: true,
        storeStatusNote: true, isActive: true,
      },
    });

    // Broadcast store status change to all connected clients for this location
    // The full store status view is richer than the minimal StoreStatusPayload — cast for socket emission
    this.socket.emitToLocation(locationId, "store:status-changed", this.buildStatusView(updated) as any);

    this.logger.log(
      `Store status updated for location ${locationId}: ${JSON.stringify(data)}`,
    );

    return this.buildStatusView(updated);
  }

  async emergencyClose(locationId: string, tenantId: string, reason?: string) {
    await this.assertAccess(locationId, tenantId);

    const updated = await this.prisma.location.update({
      where: { id: locationId },
      data: {
        isOpen: false,
        isPaused: false,
        pauseUntil: null,
        storeStatusNote: reason ?? "Store temporarily closed",
      },
      select: {
        id: true, name: true, isOpen: true, isPaused: true,
        storeStatusNote: true,
      },
    });

    this.socket.emitToLocation(locationId, "store:emergency-closed", {
      locationId,
      reason: reason ?? "Store temporarily closed",
      closedAt: new Date().toISOString(),
    } as any);

    this.logger.warn(`Emergency close triggered for location ${locationId}: ${reason}`);
    return updated;
  }

  async resume(locationId: string, tenantId: string) {
    await this.assertAccess(locationId, tenantId);

    const updated = await this.prisma.location.update({
      where: { id: locationId },
      data: {
        isOpen: true,
        isPaused: false,
        pauseUntil: null,
        storeStatusNote: null,
      },
      select: {
        id: true, name: true, isOpen: true, isPaused: true,
      },
    });

    this.socket.emitToLocation(locationId, "store:status-changed", {
      locationId,
      isOpen: true,
      isPaused: false,
      resumedAt: new Date().toISOString(),
    } as any);

    return updated;
  }

  async updateOpeningHours(locationId: string, tenantId: string, hours: Array<{ day: number; open: string; close: string }>) {
    await this.assertAccess(locationId, tenantId);
    return this.prisma.location.update({
      where: { id: locationId },
      data: { openingHours: hours as any },
      select: { id: true, openingHours: true },
    });
  }

  async updateDeliveryConfig(
    locationId: string,
    tenantId: string,
    config: {
      deliveryFeeFixed?: number;
      deliveryRadius?: number;
      minimumOrder?: number;
      estimatedDeliveryMinutes?: number;
      deliveryEnabled?: boolean;
      collectionEnabled?: boolean;
    },
  ) {
    await this.assertAccess(locationId, tenantId);
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { deliveryConfig: true },
    });
    const merged = { ...(location?.deliveryConfig as Record<string, unknown> ?? {}), ...config };
    return this.prisma.location.update({
      where: { id: locationId },
      data: { deliveryConfig: merged as any },
      select: { id: true, deliveryConfig: true },
    });
  }

  // ── Auto-resume scheduler ──────────────────────────────────────────────────
  // Called periodically (e.g., from a cron job) to resume paused stores
  async processAutoResumeExpiries() {
    const now = new Date();
    const expired = await this.prisma.location.findMany({
      where: { isPaused: true, pauseUntil: { lte: now } },
      select: { id: true, pauseUntil: true },
    });

    for (const loc of expired) {
      await this.prisma.location.update({
        where: { id: loc.id },
        data: { isPaused: false, pauseUntil: null },
      });
      this.socket.emitToLocation(loc.id, "store:status-changed", {
        locationId: loc.id,
        isPaused: false,
        autoResumedAt: now.toISOString(),
      } as any);
      this.logger.log(`Auto-resumed location ${loc.id} (pauseUntil was ${loc.pauseUntil?.toISOString()})`);
    }

    return expired.length;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async assertAccess(locationId: string, tenantId: string) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: {
        id: true, name: true, slug: true, timezone: true,
        isOpen: true, isPaused: true, pauseUntil: true,
        busyMode: true, currentPrepTime: true, throttleLimit: true,
        storeStatusNote: true, isActive: true,
      },
    });
    if (!location) throw new NotFoundException("Location not found");
    return location;
  }

  private buildStatusView(location: any) {
    const now = new Date();
    const effectivelyOpen =
      location.isOpen &&
      !location.isPaused &&
      location.isActive;

    return {
      locationId: location.id,
      name: location.name,
      slug: location.slug,
      timezone: location.timezone,
      isOpen: location.isOpen,
      isPaused: location.isPaused,
      pauseUntil: location.pauseUntil,
      busyMode: location.busyMode,
      currentPrepTime: location.currentPrepTime,
      throttleLimit: location.throttleLimit,
      storeStatusNote: location.storeStatusNote,
      isActive: location.isActive,
      effectivelyOpen,
      minutesUntilResume: location.pauseUntil
        ? Math.max(0, Math.ceil((location.pauseUntil.getTime() - now.getTime()) / 60_000))
        : null,
    };
  }
}
