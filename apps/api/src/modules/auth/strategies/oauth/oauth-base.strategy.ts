import { Injectable } from "@nestjs/common";
import type { OAuthProfile, IOAuthStrategy } from "../../interfaces/oauth-provider.interface";
import { OAuthService } from "../../services/oauth.service";
import { TokenService } from "../../services/token.service";
import { PrismaService } from "../../../../infrastructure/database/prisma.service";

// Base class for all OAuth strategies.
// Concrete strategies (Google, Apple, etc.) extend this and call
// handleOAuthCallback() after translating the provider profile.
//
// The flow is always:
//   Provider callback → translate to OAuthProfile → handleOAuthCallback
//   → findOrCreateUser → generateTokenPair → return tokens
//
// This means adding a new provider requires only:
//   1. A new strategy class that extends this
//   2. A translate() method for the provider's profile format
//   No changes to AuthService, TokenService, or OAuthService.
@Injectable()
export abstract class OAuthBaseStrategy implements IOAuthStrategy {
  abstract readonly provider: OAuthProfile["provider"];

  constructor(
    protected readonly oauthService: OAuthService,
    protected readonly tokenService: TokenService,
    protected readonly prisma: PrismaService,
  ) {}

  // Each concrete strategy implements this to translate the provider's
  // raw profile into our canonical OAuthProfile shape.
  abstract translate(
    accessToken: string,
    refreshToken: string | undefined,
    rawProfile: unknown,
  ): Promise<OAuthProfile>;

  // Implement IOAuthStrategy.validate — called by Passport after the
  // provider redirects back.
  async validate(
    accessToken: string,
    refreshToken: string,
    rawProfile: unknown,
  ): Promise<OAuthProfile> {
    return this.translate(accessToken, refreshToken, rawProfile);
  }

  // Called by the OAuth controller after Passport has run validate().
  // Returns a tenantId-scoped token pair ready for the browser.
  async handleOAuthCallback(
    profile: OAuthProfile,
    defaultTenantId: string,
    requestMeta: { ipAddress: string; userAgent: string },
  ) {
    const { userId, tenantId, isNewUser } =
      await this.oauthService.findOrCreateUser(profile, defaultTenantId);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const tokens = await this.tokenService.generateTokenPair(
      {
        userId,
        tenantId,
        role: user.role,
        permissions: user.permissions,
      },
      requestMeta,
    );

    return { tokens, userId, tenantId, isNewUser };
  }
}
