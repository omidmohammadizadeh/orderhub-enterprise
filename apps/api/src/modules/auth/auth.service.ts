import {
  Injectable,
  UnauthorizedException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { TokenService } from "./services/token.service";
import { PasswordService } from "./services/password.service";
import { AuditLogService } from "./services/audit-log.service";
import { ROLE_PERMISSIONS } from "@orderhub/shared";
import { AUDIT_EVENTS } from "@orderhub/shared";
import type { AuthenticatedUser } from "./interfaces/jwt-payload.interface";
import type { RequestMeta } from "./interfaces/request-meta.interface";
import type {
  AuthTokensDto,
  LoginResponseDto,
  UserProfileDto,
} from "./dto/auth-response.dto";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly passwordService: PasswordService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ── Called by LocalStrategy ───────────────────────────
  // Returns null on bad credentials rather than throwing, so the
  // LocalStrategy controls the error message (prevents timing-based
  // user enumeration — same response time for "no user" vs "wrong password").
  async validateCredentials(
    email: string,
    password: string,
  ): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (!user || !user.password) return null;

    const valid = await this.passwordService.compare(password, user.password);
    if (!valid) return null;

    return {
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
      permissions: user.permissions,
    };
  }

  // ── POST /auth/login ──────────────────────────────────
  async login(
    authenticatedUser: AuthenticatedUser,
    meta: RequestMeta,
  ): Promise<LoginResponseDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: authenticatedUser.userId },
      include: { tenant: { select: { name: true } } },
    });

    if (!user.isActive) {
      await this.auditLogService.logAuthEvent(AUDIT_EVENTS.AUTH.ACCOUNT_LOCKED, {
        tenantId: user.tenantId,
        userId: user.id,
        requestMeta: meta,
      });
      throw new UnauthorizedException("Account is deactivated");
    }

    const tokens = await this.tokenService.generateTokenPair(
      {
        userId: user.id,
        tenantId: user.tenantId,
        role: user.role,
        permissions: user.permissions,
      },
      meta,
    );

    // Update last login timestamp (non-blocking — don't await)
    this.prisma.user
      .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      .catch((err) => this.logger.warn(`Failed to update lastLoginAt: ${err}`));

    await this.auditLogService.logAuthEvent(AUDIT_EVENTS.AUTH.LOGIN_SUCCESS, {
      tenantId: user.tenantId,
      userId: user.id,
      requestMeta: meta,
    });

    return {
      tokens,
      user: this.mapUserProfile(user, user.tenant),
    };
  }

  // Called by LocalStrategy on validate() failure — we audit it here
  // so the controller doesn't need to know about it.
  async recordFailedLogin(email: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: { id: true, tenantId: true },
    });

    await this.auditLogService.logAuthEvent(AUDIT_EVENTS.AUTH.LOGIN_FAILURE, {
      tenantId: user?.tenantId ?? "__unknown__",
      userId: user?.id,
      meta: { email },
      requestMeta: meta,
    });
  }

  // ── POST /auth/refresh ────────────────────────────────
  async refresh(
    rawRefreshToken: string,
    meta: RequestMeta,
  ): Promise<AuthTokensDto> {
    const { tokens, userId, tenantId } = await this.tokenService.rotateTokenPair(
      rawRefreshToken,
      meta,
    );

    await this.auditLogService.logAuthEvent(AUDIT_EVENTS.AUTH.TOKEN_REFRESH, {
      tenantId,
      userId,
      requestMeta: meta,
    });

    return tokens;
  }

  // ── POST /auth/logout ─────────────────────────────────
  async logout(
    currentUser: AuthenticatedUser,
    rawRefreshToken: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.tokenService.revokeRefreshToken(rawRefreshToken);

    await this.auditLogService.logAuthEvent(AUDIT_EVENTS.AUTH.LOGOUT, {
      tenantId: currentUser.tenantId,
      userId: currentUser.userId,
      requestMeta: meta,
    });
  }

  // Invalidates every active session — used for "logout all devices"
  async logoutAll(currentUser: AuthenticatedUser, meta: RequestMeta): Promise<void> {
    const count = await this.tokenService.revokeAllUserRefreshTokens(
      currentUser.userId,
    );
    this.logger.log(
      `User ${currentUser.userId} logged out ${count} sessions`,
    );
    await this.auditLogService.logAuthEvent(AUDIT_EVENTS.AUTH.LOGOUT, {
      tenantId: currentUser.tenantId,
      userId: currentUser.userId,
      meta: { sessions: count, logoutAll: true },
      requestMeta: meta,
    });
  }

  // ── GET /auth/me ──────────────────────────────────────
  async getMe(currentUser: AuthenticatedUser): Promise<UserProfileDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: currentUser.userId },
      include: { tenant: { select: { name: true } } },
    });

    // Include first brand and first location for UI shortcuts
    const firstBrand = await this.prisma.brand.findFirst({
      where: { tenantId: currentUser.tenantId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const firstLocation = firstBrand
      ? await this.prisma.location.findFirst({
          where: { brandId: firstBrand.id, deletedAt: null, isActive: true },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        })
      : null;

    return {
      ...this.mapUserProfile(user, user.tenant),
      brandId: firstBrand?.id ?? null,
      defaultLocationId: firstLocation?.id ?? null,
    };
  }

  // Public wrapper used by native-OAuth controller endpoints that already
  // hold a tokens+user pair and just need the standard LoginResponseDto
  // shape (so mobile + web speak the same wire format).
  async buildLoginResponse(
    user: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      avatarUrl: string | null;
      role: string;
      permissions: string[];
      tenantId: string;
      isVerified: boolean;
    },
    tokens: AuthTokensDto,
    tenantId: string,
  ): Promise<LoginResponseDto> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });
    return {
      tokens,
      user: this.mapUserProfile(user, tenant),
    };
  }

  // ── Private helpers ───────────────────────────────────

  private mapUserProfile(
    user: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      avatarUrl: string | null;
      role: string;
      permissions: string[];
      tenantId: string;
      isVerified: boolean;
    },
    tenant: { name: string },
  ): UserProfileDto {
    // Merge role-level permissions with user-level overrides
    const rolePerms = (ROLE_PERMISSIONS[user.role] ?? []) as string[];
    const allPermissions = Array.from(new Set([...rolePerms, ...user.permissions]));

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl,
      role: user.role as any,
      permissions: allPermissions,
      tenantId: user.tenantId,
      tenantName: tenant.name,
      isVerified: user.isVerified,
      brandId: null,
      defaultLocationId: null,
    };
  }
}
