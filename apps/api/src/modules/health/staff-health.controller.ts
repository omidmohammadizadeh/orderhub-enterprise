import { Controller, Get, Query, NotFoundException } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Threshold after which a missing heartbeat is reported as stale (2× the 30s probe interval)
const HEARTBEAT_STALE_MS = 90_000;

// Threshold for failed prints that escalates to "contact_support"
const FAILED_PRINTS_ESCALATION_THRESHOLD = 3;

export interface StaffHealthStatus {
  systemStatus: "online" | "degraded" | "offline";
  printerStatus: "online" | "offline" | "unknown";
  lastHeartbeatAt: string | null;
  lastPrintAt: string | null;
  failedPrintJobsLastHour: number;
  providerStatuses: Record<string, "connected" | "disconnected">;
  lastOrderAt: string | null;
  actionRequired: "none" | "check_printer" | "contact_support";
}

@ApiTags("Health")
@ApiBearerAuth()
@Controller({ path: "health", version: "1" })
export class StaffHealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("staff-status")
  @ApiOperation({
    summary: "Staff-safe operational status for a location — no credentials or technical internals exposed",
  })
  async staffStatus(
    @Query("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StaffHealthStatus> {
    // Tenant isolation: always use tenantId from the JWT, never from query params
    const tenantId = user.tenantId;

    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId }, deletedAt: null },
      select: { id: true },
    });
    if (!location) throw new NotFoundException("Location not found");

    // ── Printer status ────────────────────────────────────────────────────────
    const printer = await this.prisma.printer.findFirst({
      where: { locationId, tenantId, isActive: true, deletedAt: null },
      select: { isOnline: true, metadata: true },
      orderBy: { createdAt: "asc" },
    });

    let printerStatus: StaffHealthStatus["printerStatus"] = "unknown";
    let lastHeartbeatAt: string | null = null;

    if (printer) {
      printerStatus = printer.isOnline ? "online" : "offline";
      const meta = (printer.metadata as Record<string, unknown>) ?? {};
      lastHeartbeatAt = typeof meta.lastHeartbeatAt === "string" ? meta.lastHeartbeatAt : null;

      // Detect stale heartbeat — treat as offline if last seen > threshold
      if (lastHeartbeatAt && printerStatus === "online") {
        const ageMs = Date.now() - new Date(lastHeartbeatAt).getTime();
        if (ageMs > HEARTBEAT_STALE_MS) {
          printerStatus = "offline";
        }
      }
    }

    // ── Last successful print ─────────────────────────────────────────────────
    const lastPrintJob = await (this.prisma as any).printJob.findFirst({
      where: { locationId, tenantId, status: "PRINTED" },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    });
    const lastPrintAt: string | null = lastPrintJob?.updatedAt?.toISOString() ?? null;

    // ── Failed print jobs in last hour ────────────────────────────────────────
    const failedPrintJobsLastHour = await (this.prisma as any).printJob.count({
      where: {
        locationId,
        tenantId,
        status: "FAILED",
        createdAt: { gte: new Date(Date.now() - 60 * 60_000) },
      },
    });

    // ── Provider connection status (connected/disconnected only — no credentials) ──
    const integrations = await this.prisma.integration.findMany({
      where: { locationId, tenantId, deletedAt: null },
      select: { platform: true, status: true },
    });
    const providerStatuses: Record<string, "connected" | "disconnected"> = {};
    for (const integration of integrations) {
      providerStatuses[integration.platform] =
        integration.status === "ACTIVE" ? "connected" : "disconnected";
    }

    // ── Last order time ───────────────────────────────────────────────────────
    const lastOrder = await this.prisma.order.findFirst({
      where: { locationId, tenantId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const lastOrderAt: string | null = lastOrder?.createdAt?.toISOString() ?? null;

    // ── System status: determined from DB reachability (we got this far) ─────
    const systemStatus: StaffHealthStatus["systemStatus"] = "online";

    // ── Action required ───────────────────────────────────────────────────────
    let actionRequired: StaffHealthStatus["actionRequired"] = "none";
    if (failedPrintJobsLastHour >= FAILED_PRINTS_ESCALATION_THRESHOLD) {
      actionRequired = "contact_support";
    } else if (printerStatus === "offline") {
      actionRequired = "check_printer";
    }

    return {
      systemStatus,
      printerStatus,
      lastHeartbeatAt,
      lastPrintAt,
      failedPrintJobsLastHour,
      providerStatuses,
      lastOrderAt,
      actionRequired,
    };
  }
}
