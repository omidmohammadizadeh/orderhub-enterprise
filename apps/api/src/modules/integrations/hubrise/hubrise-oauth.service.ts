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
    const clientId = this.config.get<string>("app.platforms.hubrise.appId");
    const authorizeBase = this.config.get<string>(
      "app.platforms.hubrise.oauthAuthorizeUrl",
    );
    const redirectUri = this.config.get<string>(
      "app.platforms.hubrise.redirectUri",
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
    // HubRise scope rules: a resource type may appear ONCE, and `.write`
    // includes `.read` (their own docs example is
    // `location[orders.write,customer_list.write,catalog.read]`). Listing
    // orders.read + orders.write (and catalog.read + catalog.write) fails
    // authorize with "Resource type 'orders' specified more than once", so
    // collapse each resource to the highest access we need:
    //   orders.write   — read (fetch order on webhook) + write (status)
    //   catalog.write  — read (import) + write (publish)
    //   customer_list.read — future CRM
    const scope = "location[orders.write,catalog.write,customer_list.read]";
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
  }): Promise<{
    locationId: string;
    tenantId: string;
    webhookRegistered: boolean;
  }> {
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

    // Register the per-location callback. Best-effort + NON-FATAL: the
    // token is what removes the manual terminal step, so a callback
    // hiccup must never lose it (the previous version threw here, which
    // rolled the whole connect back and forced operators back to
    // curl). Menu publish / inventory 86 / pause all work with just the
    // token; only inbound order webhooks need the callback, and the
    // operator can re-run Connect to retry it.
    const webhookUrl = this.buildWebhookUrl(decoded.locationId);
    let webhookRegistered = false;
    try {
      await this.registerWebhook(accessToken, webhookUrl);
      webhookRegistered = true;
    } catch (err: any) {
      this.logger.error(
        `HubRise callback registration failed for location ${decoded.locationId} (token still saved): ${err?.message}`,
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
        // HubRise's own location id, lifted out of the encrypted blob
        // and into its own column so menu/publish/inventory/pause
        // services can `WHERE hubriseLocationId = …` without decrypting.
        hubriseLocationId: tokenResponse.location_id ?? null,
        hubriseConnectedAt: new Date(),
      },
    });

    return {
      locationId: decoded.locationId,
      tenantId: decoded.tenantId,
      webhookRegistered,
    };
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
    const clientId = this.config.get<string>("app.platforms.hubrise.appId");
    const clientSecret = this.config.get<string>(
      "app.platforms.hubrise.appSecret",
    );
    const tokenUrl = this.config.get<string>(
      "app.platforms.hubrise.oauthTokenUrl",
    );
    const redirectUri = this.config.get<string>(
      "app.platforms.hubrise.redirectUri",
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
   * Register the callback against HubRise for this connection. HubRise's
   * API is `POST /callback` (singular) and a connection can hold exactly
   * ONE callback; the events are a nested resource→[event] map — NOT the
   * `POST /webhooks` + dotted `["order.created"]` array the first cut of
   * this code sent (that endpoint doesn't exist, so every connect 404'd
   * at this step and rolled back). Event/resource names per the docs:
   * resource ∈ {order,catalog,delivery,inventory,customer,…},
   * event ∈ {create,update,patch,delete} — matching what our receiver
   * (receiveWebhook) branches on.
   */
  private async registerWebhook(
    accessToken: string,
    webhookUrl: string,
  ): Promise<void> {
    const baseUrl = this.config.get<string>("app.platforms.hubrise.baseUrl");
    const body = JSON.stringify({
      url: webhookUrl,
      events: {
        order: ["create", "update"],
        catalog: ["update"],
        delivery: ["create", "update"],
      },
    });
    const headers = {
      "X-Access-Token": accessToken,
      "Content-Type": "application/json",
    };

    const res = await fetch(`${baseUrl}/callback`, {
      method: "POST",
      headers,
      body,
    });
    if (res.ok || res.status === 201) return;

    // A connection can only have one callback: on reconnect the POST
    // conflicts (already exists). Update it in place instead so the
    // callback URL/events stay current.
    if (res.status === 409 || res.status === 422) {
      const put = await fetch(`${baseUrl}/callback`, {
        method: "PUT",
        headers,
        body,
      });
      if (put.ok) return;
      const putText = await put.text().catch(() => "");
      throw new Error(
        `HubRise callback PUT ${put.status}: ${putText.slice(0, 300)}`,
      );
    }

    const text = await res.text().catch(() => "");
    throw new Error(`HubRise callback POST ${res.status}: ${text.slice(0, 300)}`);
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
