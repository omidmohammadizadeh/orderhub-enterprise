// Phase AS-1 — PrintAgent registration + heartbeat.
//
// An agent is any client runtime that physically drives printers:
// the Web Print Bridge binary, the Flutter mobile/desktop app, or
// the API itself (SERVER_DIRECT, for LAN printers the API can hit).
//
// On register() we mint a bearer token and store its bcrypt hash.
// Subsequent calls present the token via the X-Agent-Token header
// and pass through verifyToken() before reaching the claim/start/
// complete endpoints in PrintJobsService.

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SocketService } from "../../infrastructure/socket/socket.service";

export interface RegisterAgentDto {
  locationId: string;
  name: string;
  kind?: "WEB_BRIDGE" | "FLUTTER_MOBILE" | "FLUTTER_DESKTOP" | "SERVER_DIRECT";
  capabilities?: Record<string, any>;
  versionString?: string;
}

export interface PairAgentDto {
  code: string;
  deviceId: string;
  deviceName: string;
  hostname?: string;
  osType?: string;
  versionString?: string;
  kind?: "WEB_BRIDGE" | "FLUTTER_MOBILE" | "FLUTTER_DESKTOP";
  capabilities?: Record<string, any>;
}

const PAIR_CODE_TTL_MS = 10 * 60_000;

export interface HeartbeatDto {
  versionString?: string;
  osType?: string;
  hostname?: string;
  printerCount?: number;
  printerStatuses?: { printerId: string; isOnline: boolean }[];
}

const OFFLINE_THRESHOLD_MS = 90_000;

@Injectable()
export class PrintAgentsService {
  private readonly logger = new Logger(PrintAgentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly socket: SocketService,
  ) {}

  // Phase AS-2 — cron-callable. For every active agent whose
  // lastSeenAt is older than the 90s threshold, emit
  // printer.agent.offline and mark the agent's printers offline.
  // Returns the count for logging.
  async detectOfflineAgents(): Promise<{ flipped: number }> {
    const cutoff = new Date(Date.now() - OFFLINE_THRESHOLD_MS);
    const stale = await (this.prisma as any).printAgent.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        lastSeenAt: { lt: cutoff },
      },
      select: { id: true, locationId: true, name: true },
    });
    if (!stale.length) return { flipped: 0 };

    // Idempotent: only emit if their printers weren't already offline.
    for (const agent of stale) {
      const { count } = await (this.prisma as any).printer.updateMany({
        where: { agentId: agent.id, isOnline: true },
        data: { isOnline: false },
      });
      if (count > 0) {
        this.socket.emitToLocation(
          agent.locationId,
          "printer:agent:offline" as any,
          { agentId: agent.id, name: agent.name } as any,
        );
      }
    }
    return { flipped: stale.length };
  }

  // Helper for the controller heartbeat path — emits online event
  // when an agent that had been offline phones home.
  async noteOnline(agentId: string, locationId: string, name: string) {
    this.socket.emitToLocation(
      locationId,
      "printer:agent:online" as any,
      { agentId, name } as any,
    );
  }

  // ── Register ────────────────────────────────────────────────────────
  //
  // Caller is an authenticated platform/owner user wiring up a new
  // agent. Returns the plaintext token ONCE — the operator copies it
  // into the bridge config file or scans a QR code on the Flutter app.
  async register(
    tenantId: string,
    dto: RegisterAgentDto,
  ): Promise<{ id: string; apiToken: string }> {
    const loc = await this.prisma.location.findFirst({
      where: { id: dto.locationId, brand: { tenantId } },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found");

    const apiToken = `oha_${crypto.randomBytes(32).toString("hex")}`;
    const apiTokenHash = await bcrypt.hash(apiToken, 10);

    const agent = await (this.prisma as any).printAgent.create({
      data: {
        tenantId,
        locationId: dto.locationId,
        name: dto.name,
        kind: dto.kind ?? "WEB_BRIDGE",
        apiTokenHash,
        capabilities: (dto.capabilities ?? {}) as any,
        versionString: dto.versionString ?? null,
      },
    });

    this.logger.log(`PrintAgent registered: ${agent.id} (${dto.name})`);
    return { id: agent.id, apiToken };
  }

  // ── Token verification ─────────────────────────────────────────────
  //
  // Plain bcrypt compare — same shape as the user password path.
  // Linear scan across this tenant's active agents is fine: typical
  // restaurants run 1-5 agents per location. Cache hit-rate is high
  // because every claim hits the same agentId.
  async verifyToken(agentId: string, presentedToken: string) {
    const agent = await (this.prisma as any).printAgent.findUnique({
      where: { id: agentId },
    });
    if (!agent || !agent.isActive || agent.deletedAt) {
      throw new UnauthorizedException("Unknown agent");
    }
    const ok = await bcrypt.compare(presentedToken, agent.apiTokenHash);
    if (!ok) throw new UnauthorizedException("Bad agent token");
    return agent;
  }

  // ── Heartbeat ──────────────────────────────────────────────────────
  //
  // Agents POST every 15s. We update lastSeenAt + propagate any
  // per-printer online/offline status the agent reports (the agent
  // knows because it has a TCP/Bluetooth handle to the device).
  async heartbeat(agentId: string, dto: HeartbeatDto) {
    const agent = await (this.prisma as any).printAgent.findUnique({
      where: { id: agentId },
      select: { id: true, locationId: true },
    });
    if (!agent) throw new NotFoundException("Agent not found");

    await (this.prisma as any).printAgent.update({
      where: { id: agentId },
      data: {
        lastSeenAt: new Date(),
        versionString: dto.versionString ?? undefined,
        osType: dto.osType ?? undefined,
        hostname: dto.hostname ?? undefined,
        ...(dto.printerCount !== undefined && {
          printerCount: dto.printerCount,
        }),
      },
    });

    if (dto.printerStatuses?.length) {
      // Each row updated independently — small N, fine to fan out.
      await Promise.all(
        dto.printerStatuses.map((s) =>
          (this.prisma as any).printer.updateMany({
            where: { id: s.printerId, locationId: agent.locationId },
            data: { isOnline: s.isOnline },
          }),
        ),
      );
    }
    return { ok: true };
  }

  // ── Self-service printer binding (used by the Print Bridge CLI) ────

  async listLocationPrinters(locationId: string) {
    return this.prisma.printer.findMany({
      where: { locationId, deletedAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        type: true,
        connectionType: true,
        ipAddress: true,
        port: true,
        agentId: true,
        paperWidth: true,
        model: true,
      },
    });
  }

  async bindPrinter(agentId: string, agentLocationId: string, printerId: string) {
    if (!printerId) throw new BadRequestException("printerId required");
    const printer = await this.prisma.printer.findUnique({
      where: { id: printerId },
      select: { id: true, locationId: true },
    });
    if (!printer) throw new NotFoundException("Printer not found");
    if (printer.locationId !== agentLocationId) {
      throw new BadRequestException(
        "Printer belongs to a different location than this agent",
      );
    }
    await this.prisma.printer.update({
      where: { id: printerId },
      data: { agentId },
    });
    return { ok: true, printerId, agentId };
  }

  // ── Listing / management ───────────────────────────────────────────

  async list(tenantId: string, locationId?: string) {
    return (this.prisma as any).printAgent.findMany({
      where: {
        tenantId,
        ...(locationId && { locationId }),
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        kind: true,
        locationId: true,
        isActive: true,
        capabilities: true,
        versionString: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });
  }

  async rotateToken(
    tenantId: string,
    agentId: string,
  ): Promise<{ apiToken: string }> {
    const agent = await (this.prisma as any).printAgent.findUnique({
      where: { id: agentId },
    });
    if (!agent || agent.tenantId !== tenantId) {
      throw new NotFoundException("Agent not found");
    }
    const apiToken = `oha_${crypto.randomBytes(32).toString("hex")}`;
    const apiTokenHash = await bcrypt.hash(apiToken, 10);
    await (this.prisma as any).printAgent.update({
      where: { id: agentId },
      data: { apiTokenHash },
    });
    return { apiToken };
  }

  // ── Pairing ────────────────────────────────────────────────────────
  //
  // createPairCode (operator, JWT) → returns the 6-character code +
  // QR string. The agent binary then calls redeemPairCode (public,
  // no JWT — the code IS the auth) with its device identity and gets
  // back a permanent agent id + token.

  async createPairCode(
    tenantId: string,
    userId: string,
    locationId: string,
  ): Promise<{ code: string; expiresAt: Date; qr: string }> {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found");

    // Human-typable 6 chars, unambiguous alphabet (no 0/O/1/I).
    const code = this.generateCode(6);
    const expiresAt = new Date(Date.now() + PAIR_CODE_TTL_MS);
    await (this.prisma as any).agentPairCode.create({
      data: {
        tenantId,
        locationId,
        code,
        createdById: userId,
        expiresAt,
      },
    });
    // Embedded JSON so the agent app can scan one QR and learn API
    // URL + code in a single read.
    const qr = JSON.stringify({
      api: "https://orderhub-api-0re6.onrender.com/api/v1",
      code,
    });
    return { code, expiresAt, qr };
  }

  async redeemPairCode(
    dto: PairAgentDto,
  ): Promise<{ id: string; apiToken: string; locationId: string }> {
    const code = (dto.code ?? "").trim().toUpperCase();
    if (!code) throw new BadRequestException("Missing pair code");

    const pair = await (this.prisma as any).agentPairCode.findUnique({
      where: { code },
    });
    if (!pair) throw new NotFoundException("Invalid pair code");
    if (pair.usedAt) throw new BadRequestException("Pair code already used");
    if (pair.expiresAt < new Date()) {
      throw new BadRequestException("Pair code expired");
    }
    if (!dto.deviceId) {
      throw new BadRequestException("Missing deviceId");
    }

    // Idempotent install: if this device already has an agent row
    // (re-pair after token rotation / re-install), reuse the row and
    // mint a fresh token.
    const existing = await (this.prisma as any).printAgent.findUnique({
      where: { deviceId: dto.deviceId },
    });

    const apiToken = `oha_${crypto.randomBytes(32).toString("hex")}`;
    const apiTokenHash = await bcrypt.hash(apiToken, 10);

    let agentId: string;
    if (existing) {
      await (this.prisma as any).printAgent.update({
        where: { id: existing.id },
        data: {
          tenantId: pair.tenantId,
          locationId: pair.locationId,
          name: dto.deviceName,
          deviceName: dto.deviceName,
          kind: dto.kind ?? "WEB_BRIDGE",
          apiTokenHash,
          capabilities: (dto.capabilities ?? {}) as any,
          versionString: dto.versionString ?? null,
          osType: dto.osType ?? null,
          hostname: dto.hostname ?? null,
          isActive: true,
          deletedAt: null,
        },
      });
      agentId = existing.id;
    } else {
      const created = await (this.prisma as any).printAgent.create({
        data: {
          tenantId: pair.tenantId,
          locationId: pair.locationId,
          name: dto.deviceName,
          deviceName: dto.deviceName,
          deviceId: dto.deviceId,
          kind: dto.kind ?? "WEB_BRIDGE",
          apiTokenHash,
          capabilities: (dto.capabilities ?? {}) as any,
          versionString: dto.versionString ?? null,
          osType: dto.osType ?? null,
          hostname: dto.hostname ?? null,
        },
      });
      agentId = created.id;
    }

    await (this.prisma as any).agentPairCode.update({
      where: { id: pair.id },
      data: { usedAt: new Date(), agentId },
    });

    this.logger.log(`PrintAgent paired: ${agentId} (${dto.deviceName})`);
    return { id: agentId, apiToken, locationId: pair.locationId };
  }

  private generateCode(len: number): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
    let out = "";
    const bytes = crypto.randomBytes(len);
    for (let i = 0; i < len; i++) {
      out += alphabet[bytes[i]! % alphabet.length];
    }
    return out;
  }

  async revoke(tenantId: string, agentId: string) {
    const agent = await (this.prisma as any).printAgent.findUnique({
      where: { id: agentId },
    });
    if (!agent || agent.tenantId !== tenantId) {
      throw new NotFoundException("Agent not found");
    }
    await (this.prisma as any).printAgent.update({
      where: { id: agentId },
      data: { isActive: false, deletedAt: new Date() },
    });
    // Unbind any printers tied to this agent.
    await (this.prisma as any).printer.updateMany({
      where: { agentId },
      data: { agentId: null, isOnline: false },
    });
    return { ok: true };
  }
}
