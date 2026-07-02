import { Injectable, UnauthorizedException, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { randomBytes, createHash } from "crypto";
import { addMilliseconds, isBefore } from "date-fns";
import type { UserRole } from "@orderhub/database";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import type { JwtPayload, AuthenticatedUser } from "../interfaces/jwt-payload.interface";
import type { RequestMeta } from "../interfaces/request-meta.interface";
import type { AuthTokensDto } from "../dto/auth-response.dto";

interface TokenPayload {
  userId: string;
  tenantId: string;
  role: UserRole;
  permissions: string[];
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly accessTtlMs: number;
  private readonly refreshTtlMs: number;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.accessTtlMs = this.parseTtl(config.get("JWT_ACCESS_TTL", "15m"));
    // Long default so sessions persist until manual logout (sliding
    // rotation re-extends on every refresh). Overridable via env.
    this.refreshTtlMs = this.parseTtl(config.get("JWT_REFRESH_TTL", "365d"));
  }

  // ── Public API ────────────────────────────────────────

  async generateTokenPair(
    payload: TokenPayload,
    meta: RequestMeta,
  ): Promise<AuthTokensDto> {
    const [accessToken, { rawToken, tokenHash }] = await Promise.all([
      this.signAccessToken(payload),
      this.generateRefreshToken(),
    ]);

    const expiresAt = addMilliseconds(new Date(), this.refreshTtlMs);

    await this.prisma.refreshToken.create({
      data: {
        userId: payload.userId,
        tokenHash,
        expiresAt,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });

    return {
      accessToken,
      refreshToken: rawToken,
      expiresIn: Math.floor(this.accessTtlMs / 1000),
    };
  }

  // Refresh token rotation:
  // 1. Hash the received token and look it up
  // 2. Detect theft if token is already revoked
  // 3. Revoke old token, issue new pair atomically
  async rotateTokenPair(
    rawRefreshToken: string,
    meta: RequestMeta,
  ): Promise<{ tokens: AuthTokensDto; userId: string; tenantId: string; role: UserRole; permissions: string[] }> {
    const tokenHash = this.hashToken(rawRefreshToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { include: { tenant: true } } },
    });

    if (!stored) {
      throw new UnauthorizedException("Refresh token not found");
    }

    // Token theft detection: a token that was already rotated is being
    // replayed. BUT the common benign cause is a multi-tab / multi-window
    // race: two tabs wake from idle, both get a 401, and the loser presents
    // the token the winner just rotated. Nuking every session for that made
    // the product "randomly log me out everywhere". So: replays within a
    // short grace window of the rotation are treated as the same client and
    // get a fresh pair; replays after the window are treated as theft and
    // revoke everything (the real-theft signal is a REPLAY LONG AFTER the
    // legitimate client rotated).
    if (stored.revokedAt !== null) {
      const GRACE_MS = 60_000;
      const sinceRevoke = Date.now() - stored.revokedAt.getTime();
      if (sinceRevoke > GRACE_MS) {
        this.logger.warn(
          `Refresh token reuse detected for user ${stored.userId} (${Math.round(sinceRevoke / 1000)}s after rotation) — revoking all sessions`,
        );
        await this.revokeAllUserRefreshTokens(stored.userId);
        throw new UnauthorizedException(
          "Refresh token has already been used. All sessions have been invalidated.",
        );
      }
      this.logger.log(
        `Refresh token replay within grace window for user ${stored.userId} (${sinceRevoke}ms) — issuing fresh pair (multi-tab race)`,
      );
    }

    if (isBefore(stored.expiresAt, new Date())) {
      throw new UnauthorizedException("Refresh token expired");
    }

    if (!stored.user.isActive) {
      throw new UnauthorizedException("Account is deactivated");
    }

    const payload: TokenPayload = {
      userId: stored.userId,
      tenantId: stored.user.tenantId,
      role: stored.user.role,
      permissions: stored.user.permissions,
    };

    const { rawToken: newRawToken, tokenHash: newTokenHash } =
      await this.generateRefreshToken();
    const newExpiresAt = addMilliseconds(new Date(), this.refreshTtlMs);

    // Atomic: revoke old token and create new one in a transaction.
    // Keep the ORIGINAL revokedAt on grace-window replays — re-stamping it
    // would reset the theft-detection clock and make the grace window
    // infinitely renewable.
    const [, newToken] = await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: stored.revokedAt ?? new Date() },
      }),
      this.prisma.refreshToken.create({
        data: {
          userId: payload.userId,
          tokenHash: newTokenHash,
          expiresAt: newExpiresAt,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      }),
    ]);

    // Back-link so we can trace the rotation chain for auditing
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { replacedByTokenId: newToken.id },
    });

    const accessToken = await this.signAccessToken(payload);

    return {
      tokens: {
        accessToken,
        refreshToken: newRawToken,
        expiresIn: Math.floor(this.accessTtlMs / 1000),
      },
      ...payload,
    };
  }

  async revokeRefreshToken(rawToken: string): Promise<void> {
    const tokenHash = this.hashToken(rawToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllUserRefreshTokens(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  verifyAccessToken(token: string): JwtPayload {
    try {
      return this.jwt.verify<JwtPayload>(token, {
        secret: this.config.get("JWT_SECRET"),
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired access token");
    }
  }

  // ── Private helpers ───────────────────────────────────

  private signAccessToken(payload: TokenPayload): Promise<string> {
    const jwtPayload: JwtPayload = {
      sub: payload.userId,
      tenantId: payload.tenantId,
      role: payload.role,
      permissions: payload.permissions,
      type: "access",
    };
    return this.jwt.signAsync(jwtPayload, {
      secret: this.config.get("JWT_SECRET"),
      expiresIn: this.config.get("JWT_ACCESS_TTL", "15m"),
    });
  }

  private async generateRefreshToken(): Promise<{
    rawToken: string;
    tokenHash: string;
  }> {
    const rawToken = randomBytes(64).toString("hex");
    const tokenHash = this.hashToken(rawToken);
    return { rawToken, tokenHash };
  }

  // SHA-256 is appropriate here — refresh tokens are high-entropy random bytes,
  // so a fast hash (unlike bcrypt for passwords) is safe and correct.
  hashToken(rawToken: string): string {
    return createHash("sha256").update(rawToken).digest("hex");
  }

  private parseTtl(ttl: string): number {
    const match = /^(\d+)(s|m|h|d)$/.exec(ttl);
    if (!match) throw new Error(`Invalid TTL format: ${ttl}`);
    const value = parseInt(match[1]!, 10);
    const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return value * multipliers[match[2] as keyof typeof multipliers];
  }
}
