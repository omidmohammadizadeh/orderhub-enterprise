// Phase AU — HubRise OAuth2 + webhook auto-registration.
//
// The operator clicks "Connect HubRise" in Location settings; we 302
// to HubRise's authorize URL with the locationId encoded in a signed
// state param. After the operator approves, HubRise redirects back to
// our callback, we exchange the code for an access token, immediately
// call HubRise's POST /webhooks to register our per-location URL for
// the events we care about, then store everything on the Location.
//
// All HubRise IDs (account, location, catalog) come back inside the
// token-exchange response, so the operator only ever sees one button
// — no copy-paste, no curl.

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../credential-encryption.service";

interface StatePayload {
  tenantId: string;
  locationId: string;
  userId: string;
  // nonce so the same locationId can't be replayed if the operator
  // restarts the flow — every fresh authorize URL has a unique state.
  nonce: string;
}

interface HubRiseTokenResponse {
  access_token: string;
  token_type?: string;
  account_id?: string;
  location_id?: string;
  catalog_id?: string;
  customer_list_id?: string;
  scope?: string;
}

@Injectable()
export class HubRiseOauthService {
  private readonly logger = new Logger(HubRiseOauthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly credentialEncryption: CredentialEncryptionService,
  ) {}

  /** Build the URL we 302 the operator to. */
  buildAuthorizeUrl(args: {
    tenantId: string;
    userId: string;
    locationId: string;
  }): string {
    const clientId = this.config.get<string>("app.thirdParty.hubrise.appId");
    const authorizeBase = this.config.get<string>(
      "app.thirdParty.hubrise.oauthAuthorizeUrl",
    );
    const redirectUri = this.config.get<string>(
      "app.thirdParty.hubrise.redirectUri",
    );
    if (!clientId || !authorizeBase || !redirectUri) {
      throw new BadRequestException(
        "HubRise OAuth is not configured on this deployment. Set HUBRISE_CLIENT_ID, HUBRISE_CLIENT_SECRET and HUBRISE_REDIRECT_URI.",
      );
    }
    const state = this.signState({
      tenantId: args.tenantId,
      locationId: args.locationId,
      userId: args.userId,
      nonce: crypto.randomUUID(),
    });
    const scope =
      "location[orders.read,orders.write,catalog.read,catalog.write,customer_list.read]";
    const u = new URL(authorizeBase);
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", scope);
    u.searchParams.set("state", state);
    return u.toString();
  }

  /**
   * Complete the OAuth flow: exchange code → token, register webhook,
   * persist everything on the Location. Returns the locationId so the
   * callback controller can redirect the operator back into the UI.
   */
  async handleCallback(args: {
    code: string;
    state: string;
  }): Promise<{ locationId: string; tenantId: string }> {
    const decoded = this.verifyState(args.state);
    const tokenResponse = await this.exchangeCodeForToken(args.code);
    const accessToken = tokenResponse.access_token;
    if (!accessToken) {
      throw new BadRequestException(
        "HubRise token exchange did not return an access_token.",
      );
    }

    // Some HubRise tenants ship the catalog id with the token. When
    // they don't (multi-catalog accounts), we leave the field for the
    // operator to set later from Location settings.
    const catalogId = tokenResponse.catalog_id ?? null;

    // Register the per-location webhook FIRST so we don't end up with
    // a saved token + missing webhook if registration fails. If the
    // webhook call returns 4xx we roll back and surface the error to
    // the operator — better to retry the whole connect than save a
    // half-connected state.
    const webhookUrl = this.buildWebhookUrl(decoded.locationId);
    try {
      await this.registerWebhook(accessToken, webhookUrl);
    } catch (err: any) {
      this.logger.error(
        `HubRise webhook registration failed for location ${decoded.locationId}: ${err?.message}`,
      );
      throw new BadRequestException(
        `Connected to HubRise but could not register the webhook callback (${err?.message}). Try again.`,
      );
    }

    // Persist. Encrypt the access token via the existing credential
    // service so the bytes at rest mirror what the manual-paste flow
    // already produces — readers don't have to care which path saved
    // them.
    await this.prisma.location.update({
      where: { id: decoded.locationId },
      data: {
        hubriseCredentials: this.credentialEncryption.encrypt({
          accessToken,
          accountId: tokenResponse.account_id ?? null,
          hubriseLocationId: tokenResponse.location_id ?? null,
          customerListId: tokenResponse.customer_list_id ?? null,
        }) as any,
        hubriseCatalogId: catalogId,
        hubriseConnectedAt: new Date(),
      },
    });

    return { locationId: decoded.locationId, tenantId: decoded.tenantId };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private signState(payload: StatePayload): string {
    // Re-use our JWT_SECRET for HMAC. 10-minute TTL matches the
    // expected human time to log in + approve consent; longer than
    // that and a stale tab in another window could spoof the flow.
    return this.jwt.sign(payload, { expiresIn: "10m" });
  }

  private verifyState(state: string): StatePayload {
    try {
      return this.jwt.verify<StatePayload>(state);
    } catch {
      throw new BadRequestException(
        "OAuth state has expired or is invalid. Start the connect flow again.",
      );
    }
  }

  private async exchangeCodeForToken(
    code: string,
  ): Promise<HubRiseTokenResponse> {
    const clientId = this.config.get<string>("app.thirdParty.hubrise.appId");
    const clientSecret = this.config.get<string>(
      "app.thirdParty.hubrise.appSecret",
    );
    const tokenUrl = this.config.get<string>(
      "app.thirdParty.hubrise.oauthTokenUrl",
    );
    const redirectUri = this.config.get<string>(
      "app.thirdParty.hubrise.redirectUri",
    );

    // HubRise wants Basic auth + form-encoded body, per the docs.
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const body = new URLSearchParams({
      code,
      redirect_uri: redirectUri!,
      grant_type: "authorization_code",
    });

    const res = await fetch(tokenUrl!, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new BadRequestException(
        `HubRise token exchange failed (${res.status}): ${text}`,
      );
    }
    return (await res.json()) as HubRiseTokenResponse;
  }

  /**
   * Register a webhook against HubRise for this location. We subscribe
   * to the events that drive day-to-day operations — orders + catalog
   * lifecycle. customer events get added when we wire the CRM module.
   */
  private async registerWebhook(
    accessToken: string,
    webhookUrl: string,
  ): Promise<void> {
    const baseUrl = this.config.get<string>("app.thirdParty.hubrise.baseUrl");
    const res = await fetch(`${baseUrl}/webhooks`, {
      method: "POST",
      headers: {
        "X-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: webhookUrl,
        events: [
          "order.created",
          "order.updated",
          "catalog.updated",
        ],
      }),
    });
    // HubRise returns 201 on success, but some accounts already have a
    // webhook for the same URL — that returns 409 which we treat as
    // success because the end state ("a webhook is registered") is
    // exactly what we want.
    if (res.status === 409) return;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HubRise webhook POST ${res.status}: ${text}`);
    }
  }

  private buildWebhookUrl(locationId: string): string {
    // We host one URL per location so HubRise events route directly
    // to the right shop. This MUST match the path our
    // WebhooksController exposes (POST /v1/webhooks/:platform/:locationId).
    // Falls back to the prod Render URL so dev deploys without API_URL
    // set don't accidentally register `localhost:4000` with HubRise.
    const apiBase =
      this.config.get<string>("app.apiUrl") ??
      "https://orderhub-api-0re6.onrender.com";
    return `${apiBase.replace(/\/$/, "")}/api/v1/webhooks/hubrise/${locationId}`;
  }
}
