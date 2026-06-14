// Phase AS-4 — alert configuration service.
//
// One row per (location, station?, trigger). The dashboard's sound
// player loads them on connect and replays the rule when the matching
// WebSocket event arrives.

import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

export type AlertTrigger =
  | "NEW_ORDER"
  | "ORDER_CANCELLED"
  | "RIDER_ARRIVED"
  | "SCHEDULED_ORDER_READY"
  | "PRINTER_OFFLINE"
  | "FAILED_PRINT";

export interface UpsertAlertDto {
  locationId: string;
  stationId?: string | null;
  trigger: AlertTrigger;
  enabled?: boolean;
  soundUrl?: string | null;
  volume?: number;
  repeatCount?: number;
  repeatIntervalMs?: number;
  autoStopSeconds?: number | null;
  requireAcknowledgement?: boolean;
}

export interface AckDto {
  locationId: string;
  trigger: AlertTrigger;
  referenceKey: string;
}

@Injectable()
export class AlertsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, locationId?: string) {
    return (this.prisma as any).alertConfig.findMany({
      where: { tenantId, ...(locationId && { locationId }) },
      orderBy: { trigger: "asc" },
    });
  }

  async upsert(tenantId: string, dto: UpsertAlertDto) {
    // No upsert helper with composite-with-COALESCE on Prisma. Find,
    // then create or update.
    const where: any = {
      tenantId,
      locationId: dto.locationId,
      trigger: dto.trigger,
      stationId: dto.stationId ?? null,
    };
    const existing = await (this.prisma as any).alertConfig.findFirst({
      where,
    });
    const data = {
      ...(dto.enabled !== undefined && { enabled: dto.enabled }),
      ...(dto.soundUrl !== undefined && { soundUrl: dto.soundUrl }),
      ...(dto.volume !== undefined && { volume: dto.volume }),
      ...(dto.repeatCount !== undefined && { repeatCount: dto.repeatCount }),
      ...(dto.repeatIntervalMs !== undefined && {
        repeatIntervalMs: dto.repeatIntervalMs,
      }),
      ...(dto.autoStopSeconds !== undefined && {
        autoStopSeconds: dto.autoStopSeconds,
      }),
      ...(dto.requireAcknowledgement !== undefined && {
        requireAcknowledgement: dto.requireAcknowledgement,
      }),
    };
    if (existing) {
      return (this.prisma as any).alertConfig.update({
        where: { id: existing.id },
        data,
      });
    }
    return (this.prisma as any).alertConfig.create({
      data: {
        tenantId,
        locationId: dto.locationId,
        stationId: dto.stationId ?? null,
        trigger: dto.trigger,
        ...data,
      },
    });
  }

  async remove(tenantId: string, id: string) {
    const row = await (this.prisma as any).alertConfig.findUnique({
      where: { id },
    });
    if (!row || row.tenantId !== tenantId) {
      throw new NotFoundException("Alert config not found");
    }
    await (this.prisma as any).alertConfig.delete({ where: { id } });
    return { ok: true };
  }

  async acknowledge(tenantId: string, userId: string, dto: AckDto) {
    // Idempotent — repeated acks are a no-op via the unique index on
    // referenceKey.
    try {
      await (this.prisma as any).alertAck.create({
        data: {
          tenantId,
          locationId: dto.locationId,
          trigger: dto.trigger,
          referenceKey: dto.referenceKey,
          acknowledgedById: userId,
        },
      });
    } catch (err: any) {
      if (err?.code !== "P2002") throw err;
    }
    return { ok: true };
  }
}
