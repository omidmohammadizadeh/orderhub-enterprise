import { Test, TestingModule } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { AuthService } from "../auth.service";
import { TokenService } from "../services/token.service";
import { PasswordService } from "../services/password.service";
import { AuditLogService } from "../services/audit-log.service";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import type { AuthenticatedUser } from "../interfaces/jwt-payload.interface";

// ── Mocks ─────────────────────────────────────────────────

const mockUser = {
  id: "user_01",
  email: "admin@test.com",
  password: "hashed_password",
  firstName: "Test",
  lastName: "User",
  role: "MANAGER" as const,
  permissions: [],
  tenantId: "tenant_01",
  isActive: true,
  isVerified: true,
  avatarUrl: null,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockTenant = { id: "tenant_01", name: "Test Restaurant" };

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    update: jest.fn(),
  },
};

const mockTokenService = {
  generateTokenPair: jest.fn(),
  revokeRefreshToken: jest.fn(),
  revokeAllUserRefreshTokens: jest.fn(),
  rotateTokenPair: jest.fn(),
};

const mockPasswordService = {
  compare: jest.fn(),
};

const mockAuditLogService = {
  logAuthEvent: jest.fn(),
};

describe("AuthService", () => {
  let service: AuthService;

  const requestMeta = { ipAddress: "127.0.0.1", userAgent: "Jest" };
  const authenticatedUser: AuthenticatedUser = {
    userId: mockUser.id,
    tenantId: mockUser.tenantId,
    role: mockUser.role,
    permissions: [],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TokenService, useValue: mockTokenService },
        { provide: PasswordService, useValue: mockPasswordService },
        { provide: AuditLogService, useValue: mockAuditLogService },
      ],
    }).compile();

    service = module.get(AuthService);
    jest.clearAllMocks();
  });

  // ── validateCredentials ─────────────────────────────────

  describe("validateCredentials", () => {
    it("returns AuthenticatedUser on valid credentials", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPasswordService.compare.mockResolvedValue(true);

      const result = await service.validateCredentials("admin@test.com", "password");

      expect(result).toEqual({
        userId: mockUser.id,
        tenantId: mockUser.tenantId,
        role: mockUser.role,
        permissions: mockUser.permissions,
      });
    });

    it("returns null when user does not exist", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await service.validateCredentials("nobody@test.com", "password");

      expect(result).toBeNull();
      // Never call compare if user not found (prevents timing side-channel)
      expect(mockPasswordService.compare).not.toHaveBeenCalled();
    });

    it("returns null on wrong password", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPasswordService.compare.mockResolvedValue(false);

      const result = await service.validateCredentials("admin@test.com", "wrong");

      expect(result).toBeNull();
    });

    it("returns null when user has no password (OAuth-only account)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, password: null });

      const result = await service.validateCredentials("admin@test.com", "password");

      expect(result).toBeNull();
    });
  });

  // ── login ───────────────────────────────────────────────

  describe("login", () => {
    const mockTokens = {
      accessToken: "access.token.here",
      refreshToken: "raw_refresh_token",
      expiresIn: 900,
    };

    beforeEach(() => {
      mockPrisma.user.findUniqueOrThrow.mockResolvedValue({
        ...mockUser,
        tenant: mockTenant,
      });
      mockTokenService.generateTokenPair.mockResolvedValue(mockTokens);
      mockPrisma.user.update.mockResolvedValue(mockUser);
      mockAuditLogService.logAuthEvent.mockResolvedValue(undefined);
    });

    it("returns tokens and user profile on success", async () => {
      const result = await service.login(authenticatedUser, requestMeta);

      expect(result.tokens).toEqual(mockTokens);
      expect(result.user.email).toBe(mockUser.email);
      expect(result.user.tenantName).toBe(mockTenant.name);
    });

    it("throws UnauthorizedException for deactivated accounts", async () => {
      mockPrisma.user.findUniqueOrThrow.mockResolvedValue({
        ...mockUser,
        isActive: false,
        tenant: mockTenant,
      });

      await expect(
        service.login(authenticatedUser, requestMeta),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("calls TokenService.generateTokenPair with correct payload", async () => {
      await service.login(authenticatedUser, requestMeta);

      expect(mockTokenService.generateTokenPair).toHaveBeenCalledWith(
        {
          userId: mockUser.id,
          tenantId: mockUser.tenantId,
          role: mockUser.role,
          permissions: mockUser.permissions,
        },
        requestMeta,
      );
    });

    it("audits successful login", async () => {
      await service.login(authenticatedUser, requestMeta);

      expect(mockAuditLogService.logAuthEvent).toHaveBeenCalledWith(
        "auth.login.success",
        expect.objectContaining({ userId: mockUser.id }),
      );
    });
  });

  // ── logout ──────────────────────────────────────────────

  describe("logout", () => {
    it("revokes the refresh token and audits", async () => {
      mockTokenService.revokeRefreshToken.mockResolvedValue(undefined);
      mockAuditLogService.logAuthEvent.mockResolvedValue(undefined);

      await service.logout(authenticatedUser, "raw_token", requestMeta);

      expect(mockTokenService.revokeRefreshToken).toHaveBeenCalledWith("raw_token");
      expect(mockAuditLogService.logAuthEvent).toHaveBeenCalledWith(
        "auth.logout",
        expect.objectContaining({ userId: mockUser.id }),
      );
    });
  });
});
