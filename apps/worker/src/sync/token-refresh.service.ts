import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import { PrismaService } from "../infrastructure/prisma.service";
import { CredentialEncryptionService } from "../infrastructure/credential-encryption.service";

export interface PlatformCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string; // ISO8601
  [key: string]: string | undefined;
}

interface TokenRefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

@Injectable()
export class TokenRefreshService {
  private readonly logger = new Logger(TokenRefreshService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: CredentialEncryptionService,
  ) {}

  /**
   * Returns credentials for an integration, refreshing the access token first
   * if it expires within 5 minutes.
   */
  async getCredentials(integrationId: string): Promise<PlatformCredentials> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      select: { id: true, platform: true, credentials: true },
    });
    if (!integration) {
      throw new Error(`Integration ${integrationId} not found`);
    }

    const stored = (integration.credentials ?? {}) as Record<string, unknown>;
    const credentials = this.encryption.decrypt(stored) as PlatformCredentials;
    await this.refreshIfExpired(integrationId, integration.platform, credentials);

    // Re-read after potential token update
    const updated = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      select: { credentials: true },
    });
    const updatedStored = (updated?.credentials ?? stored) as Record<string, unknown>;
    return this.encryption.decrypt(updatedStored) as PlatformCredentials;
  }

  /**
   * Checks if the access token expires within 5 minutes and refreshes it if so.
   * Silently skips if required env vars are absent.
   */
  async refreshIfExpired(
    integrationId: string,
    platform: string,
    credentials: PlatformCredentials,
  ): Promise<void> {
    if (!credentials.accessToken) return;

    const expiresAt = credentials.expiresAt ? new Date(credentials.expiresAt) : null;
    const needsRefresh = !expiresAt || expiresAt.getTime() - Date.now() < FIVE_MINUTES_MS;

    if (!needsRefresh) return;

    this.logger.log(
      `[${integrationId}] Token for ${platform} expires soon — refreshing`,
    );

    try {
      const result = await this.doRefresh(platform, credentials);
      if (!result) return;

      const newCredentials: PlatformCredentials = {
        ...credentials,
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
        ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      };

      // Encrypt before persisting
      const encrypted = this.encryption.encrypt(
        newCredentials as unknown as Record<string, unknown>,
      );
      await this.prisma.integration.update({
        where: { id: integrationId },
        data: { credentials: encrypted as any },
      });

      this.logger.log(
        `[${integrationId}] Token refreshed for ${platform} — expires ${result.expiresAt}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[${integrationId}] Token refresh failed for ${platform}: ${err.message}`,
      );
      // Mark integration as ERROR so health dashboard surfaces it
      await this.prisma.integration
        .update({
          where: { id: integrationId },
          data: {
            status: "ERROR",
            lastError: `Token refresh failed: ${err.message}`,
            lastErrorAt: new Date(),
          },
        })
        .catch(() => {});
    }
  }

  // ── Platform-specific refresh logic ───────────────────────────────────────

  private async doRefresh(
    platform: string,
    credentials: PlatformCredentials,
  ): Promise<TokenRefreshResult | null> {
    switch (platform) {
      case "UBER_EATS":
        return this.refreshUberEats(credentials);
      case "HUBRISE":
        return this.refreshHubRise(credentials);
      case "DELIVEROO":
        return this.refreshDeliveroo(credentials);
      case "JUST_EAT":
        return this.refreshJustEat(credentials);
      default:
        this.logger.debug(`No token refresh strategy for platform: ${platform}`);
        return null;
    }
  }

  private async refreshUberEats(
    credentials: PlatformCredentials,
  ): Promise<TokenRefreshResult | null> {
    const clientId = process.env.UBER_EATS_CLIENT_ID;
    const clientSecret = process.env.UBER_EATS_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      this.logger.warn("UBER_EATS_CLIENT_ID / UBER_EATS_CLIENT_SECRET not set — skipping refresh");
      return null;
    }

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "eats.order",
    });

    const { data } = await axios.post(
      "https://login.uber.com/oauth/v2/token",
      params.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10_000,
      },
    );

    return {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
    };
  }

  private async refreshHubRise(
    credentials: PlatformCredentials,
  ): Promise<TokenRefreshResult | null> {
    const clientId = process.env.HUBRISE_CLIENT_ID;
    const clientSecret = process.env.HUBRISE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      this.logger.warn("HUBRISE_CLIENT_ID / HUBRISE_CLIENT_SECRET not set — skipping refresh");
      return null;
    }

    if (!credentials.refreshToken) {
      this.logger.warn("No HubRise refresh_token present — cannot refresh");
      return null;
    }

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    });

    const { data } = await axios.post(
      "https://manager.hubrise.com/oauth2/v1/token",
      params.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10_000,
      },
    );

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? credentials.refreshToken,
      expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
    };
  }

  private async refreshDeliveroo(
    credentials: PlatformCredentials,
  ): Promise<TokenRefreshResult | null> {
    const clientId = process.env.DELIVEROO_CLIENT_ID;
    const clientSecret = process.env.DELIVEROO_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      this.logger.warn("DELIVEROO_CLIENT_ID / DELIVEROO_CLIENT_SECRET not set — skipping refresh");
      return null;
    }

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    });

    const { data } = await axios.post(
      "https://consumer-api.deliveroo.com/oauth2/token",
      params.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10_000,
      },
    );

    return {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
    };
  }

  private async refreshJustEat(
    credentials: PlatformCredentials,
  ): Promise<TokenRefreshResult | null> {
    const clientId = process.env.JUST_EAT_CLIENT_ID;
    const clientSecret = process.env.JUST_EAT_CLIENT_SECRET;
    const applicationId = process.env.JUST_EAT_APPLICATION_ID;

    if (!clientId || !clientSecret) {
      this.logger.warn("JUST_EAT_CLIENT_ID / JUST_EAT_CLIENT_SECRET not set — skipping refresh");
      return null;
    }

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    });

    const { data } = await axios.post(
      "https://uk-api.just-eat.io/token",
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(applicationId ? { "x-je-application-id": applicationId } : {}),
        },
        timeout: 10_000,
      },
    );

    return {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
    };
  }
}
