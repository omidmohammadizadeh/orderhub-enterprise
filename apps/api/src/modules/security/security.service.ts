import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { createHmac, randomUUID, randomBytes } from "crypto";

// ── DTOs ──────────────────────────────────────────────────────────────────────

export interface AddIpRuleDto {
  cidr: string;
  label?: string;
}

export interface CreateSessionDto {
  deviceName?: string;
  deviceType?: string;
  ipAddress?: string;
  userAgent?: string;
  appVersion?: string;
  expiresInDays?: number;
}

export interface AuditEventDto {
  event: string;
  resource?: string;
  resourceId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

// ── TOTP helpers (no external package required) ────────────────────────────────

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | (buffer[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const str = input.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of str) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateTotpSecret(): string {
  const raw = randomBytes(20);
  return base32Encode(raw);
}

function computeTotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const counterBuf = Buffer.alloc(8);
  // Write 64-bit big-endian counter (JS safe integer range is fine for epoch/30)
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  counterBuf.writeUInt32BE(high, 0);
  counterBuf.writeUInt32BE(low, 4);

  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = (hmac[19] ?? 0) & 0x0f;
  const code =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

function verifyTotp(secret: string, token: string, windowSize = 1): boolean {
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let i = -windowSize; i <= windowSize; i++) {
    if (computeTotp(secret, counter + i) === token) return true;
  }
  return false;
}

function generateBackupCodes(count = 8): string[] {
  return Array.from({ length: count }, () =>
    randomBytes(5).toString("hex").toUpperCase(),
  );
}

// ── CIDR check ────────────────────────────────────────────────────────────────

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return -1;
  return (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
}

function isIpInCidr(ip: string, cidr: string): boolean {
  try {
    const parts = cidr.split("/");
    const network = parts[0] ?? "";
    const prefixStr = parts[1];
    const prefix = parseInt(prefixStr ?? "32", 10);
    const ipInt = ipToInt(ip);
    const netInt = ipToInt(network);
    if (ipInt === -1 || netInt === -1) return false;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipInt & mask) === (netInt & mask);
  } catch {
    return false;
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class SecurityService {
  private readonly logger = new Logger(SecurityService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── MFA / TOTP ─────────────────────────────────────────────────────────────

  async setupMfa(userId: string) {
    const secret = generateTotpSecret();
    const backupCodes = generateBackupCodes(8);

    // Fetch user to build issuer label
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true, lastName: true },
    });

    const issuer = "OrderHub";
    const accountName = user?.email ?? userId;
    const qrCodeUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

    await this.prisma.mfaConfig.upsert({
      where: { userId },
      create: {
        userId,
        secret,
        isEnabled: false,
        backupCodes: backupCodes as any,
      },
      update: {
        secret,
        isEnabled: false,
        backupCodes: backupCodes as any,
      },
    });

    return { secret, qrCodeUrl, backupCodes };
  }

  async verifyAndEnableMfa(userId: string, token: string) {
    const config = await this.prisma.mfaConfig.findUnique({ where: { userId } });
    if (!config) throw new NotFoundException("MFA not set up. Call POST /mfa/setup first.");

    if (!verifyTotp(config.secret, token)) {
      throw new BadRequestException("Invalid TOTP token");
    }

    await this.prisma.mfaConfig.update({
      where: { userId },
      data: { isEnabled: true },
    });

    return { success: true, message: "MFA enabled successfully" };
  }

  async verifyMfaToken(userId: string, token: string): Promise<boolean> {
    const config = await this.prisma.mfaConfig.findUnique({ where: { userId } });
    if (!config || !config.isEnabled) return false;

    // First try TOTP
    if (verifyTotp(config.secret, token)) return true;

    // Fallback: check backup codes
    const backupCodes = (config.backupCodes as string[]) ?? [];
    const normalizedToken = token.toUpperCase();
    const matchIdx = backupCodes.findIndex((code) => code === normalizedToken);

    if (matchIdx === -1) return false;

    // Consume the backup code (one-time use)
    const remaining = backupCodes.filter((_, i) => i !== matchIdx);
    await this.prisma.mfaConfig.update({
      where: { userId },
      data: { backupCodes: remaining as any },
    });

    return true;
  }

  async disableMfa(userId: string, tenantId: string) {
    const config = await this.prisma.mfaConfig.findUnique({ where: { userId } });
    if (!config) throw new NotFoundException("MFA config not found");

    await this.prisma.mfaConfig.update({
      where: { userId },
      data: { isEnabled: false, secret: "", backupCodes: [] as any },
    });

    return { success: true, message: "MFA disabled" };
  }

  async getMfaStatus(userId: string) {
    const config = await this.prisma.mfaConfig.findUnique({
      where: { userId },
      select: { isEnabled: true, backupCodes: true },
    });

    const backupCodes = (config?.backupCodes as string[] | null) ?? [];
    return {
      isEnabled: config?.isEnabled ?? false,
      hasBackupCodes: backupCodes.length > 0,
      backupCodesRemaining: backupCodes.length,
    };
  }

  // ── IP Allowlist ───────────────────────────────────────────────────────────

  async getIpAllowlist(tenantId: string) {
    return this.prisma.ipAllowlist.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
    });
  }

  async addIpRule(tenantId: string, dto: AddIpRuleDto) {
    // Basic CIDR validation
    const cidrPattern = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
    if (!cidrPattern.test(dto.cidr)) {
      throw new BadRequestException(
        `Invalid CIDR notation: "${dto.cidr}". Expected format: "x.x.x.x/prefix" or "x.x.x.x"`,
      );
    }

    // Normalize: if no prefix, append /32
    const cidr = dto.cidr.includes("/") ? dto.cidr : `${dto.cidr}/32`;

    return this.prisma.ipAllowlist.create({
      data: {
        tenantId,
        cidr,
        label: dto.label ?? null,
        isActive: true,
      },
    });
  }

  async removeIpRule(ruleId: string, tenantId: string) {
    const rule = await this.prisma.ipAllowlist.findFirst({
      where: { id: ruleId, tenantId },
    });
    if (!rule) throw new NotFoundException("IP allowlist rule not found");

    await this.prisma.ipAllowlist.delete({ where: { id: ruleId } });
    return { success: true };
  }

  async toggleIpRule(ruleId: string, tenantId: string) {
    const rule = await this.prisma.ipAllowlist.findFirst({
      where: { id: ruleId, tenantId },
    });
    if (!rule) throw new NotFoundException("IP allowlist rule not found");

    return this.prisma.ipAllowlist.update({
      where: { id: ruleId },
      data: { isActive: !rule.isActive },
    });
  }

  async checkIpAllowed(tenantId: string, ip: string): Promise<boolean> {
    const rules = await this.prisma.ipAllowlist.findMany({
      where: { tenantId, isActive: true },
    });

    // No rules configured — open access
    if (rules.length === 0) return true;

    return (rules as Array<{ cidr: string }>).some((rule) => isIpInCidr(ip, rule.cidr));
  }

  // ── Device Sessions ────────────────────────────────────────────────────────

  async listSessions(userId: string, tenantId: string) {
    const now = new Date();
    return this.prisma.deviceSession.findMany({
      where: {
        userId,
        tenantId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { lastSeenAt: "desc" },
    });
  }

  async revokeSession(sessionId: string, userId: string) {
    const session = await this.prisma.deviceSession.findFirst({
      where: { id: sessionId, userId, revokedAt: null },
    });
    if (!session) throw new NotFoundException("Session not found or already revoked");

    return this.prisma.deviceSession.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllSessions(
    userId: string,
    tenantId: string,
    exceptTokenHash?: string,
  ) {
    const where: Record<string, unknown> = {
      userId,
      tenantId,
      revokedAt: null,
    };

    if (exceptTokenHash) {
      where.sessionToken = { not: exceptTokenHash };
    }

    const result = await this.prisma.deviceSession.updateMany({
      where,
      data: { revokedAt: new Date() },
    });

    return { revokedCount: result.count };
  }

  async createSession(userId: string, tenantId: string, dto: CreateSessionDto) {
    const expiresInDays = dto.expiresInDays ?? 30;
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const sessionToken = randomUUID();

    return this.prisma.deviceSession.create({
      data: {
        userId,
        tenantId,
        sessionToken,
        deviceName: dto.deviceName ?? null,
        deviceType: dto.deviceType ?? null,
        appVersion: dto.appVersion ?? null,
        ipAddress: dto.ipAddress ?? null,
        userAgent: dto.userAgent ?? null,
        lastSeenAt: new Date(),
        expiresAt,
      },
    });
  }

  async cleanExpiredSessions(): Promise<number> {
    const now = new Date();
    const result = await this.prisma.deviceSession.deleteMany({
      where: {
        expiresAt: { lt: now },
        revokedAt: null,
      },
    });
    this.logger.log(`Cleaned ${result.count} expired device sessions`);
    return result.count;
  }

  // ── Audit Log ──────────────────────────────────────────────────────────────

  async logAuditEvent(
    tenantId: string,
    userId: string | null | undefined,
    dto: AuditEventDto,
  ) {
    return this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: userId ?? null,
        event: dto.event,
        resource: dto.resource ?? null,
        resourceId: dto.resourceId ?? null,
        before: (dto.before ?? null) as any,
        after: (dto.after ?? null) as any,
        ipAddress: dto.ipAddress ?? null,
        userAgent: dto.userAgent ?? null,
      },
    });
  }

  async getAuditLog(
    tenantId: string,
    opts: {
      resource?: string;
      userId?: string;
      startDate?: string;
      endDate?: string;
      limit?: number;
      offset?: number;
    },
  ) {
    const { resource, userId, startDate, endDate, limit = 50, offset = 0 } = opts;

    const where: Record<string, unknown> = { tenantId };
    if (resource) where.resource = resource;
    if (userId) where.userId = userId;
    if (startDate || endDate) {
      where.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {}),
      };
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, total, limit, offset };
  }
}
