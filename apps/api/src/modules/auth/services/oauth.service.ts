import {
  Injectable,
  ConflictException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import type { OAuthProvider } from "@orderhub/database";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import type { OAuthProfile } from "../interfaces/oauth-provider.interface";

// OAuthService handles the "find or create user from OAuth profile" flow
// and account linking/unlinking. It is provider-agnostic — the strategy
// translates the raw provider response into OAuthProfile before calling here.
@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Called at the end of every OAuth callback.
  // Returns the existing user (linked or email-matched) or creates a new one.
  async findOrCreateUser(
    profile: OAuthProfile,
    defaultTenantId: string,
  ): Promise<{ userId: string; tenantId: string; isNewUser: boolean }> {
    // 1. Check if this provider account is already linked
    const existing = await this.prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: profile.provider,
          providerAccountId: profile.providerAccountId,
        },
      },
      include: { user: true },
    });

    if (existing) {
      // Update tokens (they may have rotated since last login)
      await this.prisma.oAuthAccount.update({
        where: { id: existing.id },
        data: {
          accessToken: profile.accessToken,
          refreshToken: profile.refreshToken,
          expiresAt: profile.expiresAt,
          idToken: profile.idToken,
          rawProfile: profile as any,
        },
      });
      return { userId: existing.userId, tenantId: existing.user.tenantId, isNewUser: false };
    }

    // 2. Check if a user with this email already exists (account linking)
    const userByEmail = await this.prisma.user.findUnique({
      where: { email: profile.email },
    });

    if (userByEmail) {
      // Link the OAuth account to the existing user
      await this.prisma.oAuthAccount.create({
        data: {
          userId: userByEmail.id,
          provider: profile.provider,
          providerAccountId: profile.providerAccountId,
          accessToken: profile.accessToken,
          refreshToken: profile.refreshToken,
          expiresAt: profile.expiresAt,
          idToken: profile.idToken,
          rawProfile: profile as any,
        },
      });
      this.logger.log(
        `Linked ${profile.provider} to existing user ${userByEmail.id}`,
      );
      return { userId: userByEmail.id, tenantId: userByEmail.tenantId, isNewUser: false };
    }

    // 3. Create a brand new user + OAuth account in a single transaction
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId: defaultTenantId,
          email: profile.email,
          firstName: profile.firstName,
          lastName: profile.lastName,
          avatarUrl: profile.avatarUrl,
          role: "VIEWER",
          isVerified: profile.emailVerified,
        },
      });

      await tx.oAuthAccount.create({
        data: {
          userId: user.id,
          provider: profile.provider,
          providerAccountId: profile.providerAccountId,
          accessToken: profile.accessToken,
          refreshToken: profile.refreshToken,
          expiresAt: profile.expiresAt,
          idToken: profile.idToken,
          rawProfile: profile as any,
        },
      });

      return user;
    });

    this.logger.log(`Created new user ${result.id} via ${profile.provider}`);
    return { userId: result.id, tenantId: result.tenantId, isNewUser: true };
  }

  async linkAccount(
    userId: string,
    profile: OAuthProfile,
  ): Promise<void> {
    const existing = await this.prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: profile.provider,
          providerAccountId: profile.providerAccountId,
        },
      },
    });

    if (existing && existing.userId !== userId) {
      throw new ConflictException(
        `This ${profile.provider} account is already linked to a different user`,
      );
    }

    await this.prisma.oAuthAccount.upsert({
      where: {
        provider_providerAccountId: {
          provider: profile.provider,
          providerAccountId: profile.providerAccountId,
        },
      },
      create: {
        userId,
        provider: profile.provider,
        providerAccountId: profile.providerAccountId,
        accessToken: profile.accessToken,
        refreshToken: profile.refreshToken,
        expiresAt: profile.expiresAt,
        idToken: profile.idToken,
      },
      update: {
        accessToken: profile.accessToken,
        refreshToken: profile.refreshToken,
        expiresAt: profile.expiresAt,
      },
    });
  }

  async unlinkAccount(userId: string, provider: OAuthProvider): Promise<void> {
    const account = await this.prisma.oAuthAccount.findFirst({
      where: { userId, provider },
    });

    if (!account) {
      throw new NotFoundException(`No ${provider} account linked to this user`);
    }

    // Prevent unlinking the last login method if user has no password
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const oauthCount = await this.prisma.oAuthAccount.count({ where: { userId } });

    if (!user.password && oauthCount <= 1) {
      throw new ConflictException(
        "Cannot unlink the only login method. Set a password first.",
      );
    }

    await this.prisma.oAuthAccount.delete({ where: { id: account.id } });
  }

  async getLinkedProviders(userId: string): Promise<OAuthProvider[]> {
    const accounts = await this.prisma.oAuthAccount.findMany({
      where: { userId },
      select: { provider: true },
    });
    return accounts.map((a) => a.provider);
  }
}
