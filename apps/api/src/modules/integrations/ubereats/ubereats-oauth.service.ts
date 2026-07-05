import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@orderhub/database";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { UberEatsClientService } from "./ubereats-client.service";

// Phase UE-1/2 — merchant OAuth (authorization_code, scope
// eats.pos_provisioning). The operator clicks "Connect Uber Eats" on a
// brand+location, we send them to Uber's consent page with a signed state,
// Uber redirects back to our callback, we exchange the code and store the
// merchant token (encrypted) on the pending BrandPlatformConnection. The
// token is only needed for store discovery + pos_data provisioning; Uber
// user tokens live 30 days and the connect flow re-runs OAuth if expired.

interface StatePayload {
  t: string; // tenantId
  u: string; // userId
  b: string; // brandId
  l: string; // locationId
  purpose: "ubereats_oauth";
}

@Injectable()
export class UberEatsOauthService {
  private readonly logger = new Logger(UberEatsOauthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialEncryptionService,
    private readonly client: UberEatsClientService,
  ) {}

  get redirectUri(): string {
    return (
      this.config.get<string>("app.platforms.uberEats.redirectUri") ?? ""
    );
  }

  buildAuthorizeUrl(args: {
    tenantId: string;
    userId: string;
    brandId: string;
    locationId: string;
  }): string {
    if (!this.client.configured) {
      throw new BadRequestException(
        "Uber Eats isn't configured on the server yet (missing client credentials).",
      );
    }
    if (!this.redirectUri) {
      throw new BadRequestException(
        "UBER_EATS_REDIRECT_URI isn't set on the server.",
      );
    }
    const state = this.jwt.sign(
      {
        t: args.tenantId,
        u: args.userId,
        b: args.brandId,
        l: args.locationId,
        purpose: "ubereats_oauth",
      } satisfies StatePayload,
      { expiresIn: "15m" },
    );
    const u = new URL(`${this.client.authBase}/authorize`);
    u.searchParams.set("client_id", this.client.clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", this.redirectUri);
    // authorization_code only accepts eats.pos_provisioning (eats.store is a
    // client-credentials scope — including it here → invalid_scope). The
    // pos_provisioning merchant token can still list stores: GET
    // /v1/delivery/stores accepts either scope.
    u.searchParams.set("scope", "eats.pos_provisioning");
    u.searchParams.set("state", state);
    return u.toString();
  }

  /**
   * OAuth callback: verify state, exchange the code, persist the merchant
   * token (encrypted) on a pending UBER_EATS connection row. Store selection
   * + pos_data provisioning happen next from the dashboard (UE-2).
   */
  async handleCallback(args: { code: string; state: string }) {
    let decoded: StatePayload;
    try {
      decoded = this.jwt.verify<StatePayload>(args.state);
      if (decoded.purpose !== "ubereats_oauth") throw new Error("bad purpose");
    } catch {
      throw new BadRequestException(
        "OAuth state has expired or is invalid. Start the connect flow again.",
      );
    }

    const token = await this.client.exchangeAuthorizationCode(
      args.code,
      this.redirectUri,
    );
    if (!token?.access_token) {
      throw new BadRequestException(
        "Uber Eats token exchange did not return an access_token.",
      );
    }

    // Prisma's InputJsonValue rejects Record<string, unknown> — the envelope
    // is plain JSON (string fields only) so the assertion is safe.
    const envelope = this.credentials.encrypt({
      merchantAccessToken: token.access_token,
      merchantRefreshToken: token.refresh_token ?? "",
      merchantTokenExpiresAt: new Date(
        Date.now() + (token.expires_in ?? 2_592_000) * 1000,
      ).toISOString(),
      scope: token.scope ?? "eats.pos_provisioning",
    });

    await this.prisma.brandPlatformConnection.upsert({
      where: {
        brandId_locationId_platform: {
          brandId: decoded.b,
          locationId: decoded.l,
          platform: "UBER_EATS",
        },
      },
      create: {
        tenantId: decoded.t,
        brandId: decoded.b,
        locationId: decoded.l,
        platform: "UBER_EATS",
        status: "pending", // connected once a store is provisioned
        metadata: { credentials: envelope } as Prisma.InputJsonValue,
      },
      update: {
        status: "pending",
        lastError: null,
        metadata: { credentials: envelope } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `Uber Eats merchant token stored for brand=${decoded.b} location=${decoded.l} (expires_in=${token.expires_in ?? "?"}s)`,
    );
    return { tenantId: decoded.t, brandId: decoded.b, locationId: decoded.l };
  }

  /** Decrypted merchant access token for a connection (throws if absent). */
  async merchantToken(connection: {
    metadata: unknown;
  }): Promise<string> {
    const meta = (connection.metadata ?? {}) as Record<string, any>;
    if (!meta.credentials) {
      throw new BadRequestException(
        "Uber Eats isn't authorised yet — run Connect Uber Eats first.",
      );
    }
    const decrypted = this.credentials.decrypt(
      meta.credentials as Record<string, unknown>,
    ) as Record<string, string>;
    const token = decrypted.merchantAccessToken;
    if (!token) {
      throw new BadRequestException(
        "Stored Uber Eats credentials are incomplete — reconnect Uber Eats.",
      );
    }
    const exp = Date.parse(decrypted.merchantTokenExpiresAt ?? "");
    if (Number.isFinite(exp) && exp < Date.now()) {
      throw new BadRequestException(
        "The Uber Eats authorisation has expired (30-day token) — reconnect Uber Eats.",
      );
    }
    return token;
  }
}
