import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { UberEatsClientService } from "./ubereats-client.service";
import { UberEatsOauthService } from "./ubereats-oauth.service";
import { ActivityLogService } from "../../logs/activity-log.service";

// Phase UE-2 — store discovery, provisioning and store control.
//
// Connect is OAuth-driven (no external id): the merchant approves via
// authorization_code, and their MERCHANT token then lists their stores:
//   GET  /v1/delivery/stores                      → merchant's stores
// Linking = recording which store id maps to the connection (linkStore).
// Store control uses client-credentials (attached Store API spec, servers
// https://api.uber.com):
//   GET  /v1/delivery/store/{store_id}/status
//   POST /v1/delivery/store/{store_id}/update-store-status   {status, reason}
//   POST /v1/delivery/store/{store_id}/update-store-prep-time {default_prep_time}
// Uber confirms provisioning asynchronously with a store.provisioned webhook,
// which flips our row to "connected".

// LIVE-VERIFIED scopes (the OpenAPI spec's security blocks lie here):
//   update-store-status → Uber 401s "requires ... eats.store.status.write"
// so status read/write use eats.store.status.write, NOT eats.store. The rest
// (details, update info, prep time) use eats.store. Uber silently drops any
// requested scope the APP isn't approved for (no mint error) → the endpoint
// then 401s naming the missing scope. So eats.store.status.write must be
// enabled on the app in the Uber developer dashboard for pause/resume to work.
const STORE_SCOPES = ["eats.store"];
const STATUS_SCOPES = ["eats.store.status.write"];

@Injectable()
export class UberEatsConnectionService {
  private readonly logger = new Logger(UberEatsConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: UberEatsClientService,
    private readonly oauth: UberEatsOauthService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  /** Stores visible to the authorised merchant (for the store picker). */
  async listMerchantStores(tenantId: string, brandId: string, locationId: string) {
    const row = await this.pendingOrConnected(tenantId, brandId, locationId);
    return this.fetchMerchantStores(row);
  }

  /**
   * Stores the merchant authorised us against. The authorization_code token
   * returns exactly the stores linked to the user who approved the connect —
   * no pos_data, no external id (Store API: GET /v1/delivery/stores).
   */
  private async fetchMerchantStores(row: {
    metadata: unknown;
  }): Promise<Array<{ storeId: string; name: string; address: string | null; raw: any }>> {
    const token = await this.oauth.merchantToken(row);
    const json = await this.client.request<any>("GET", "/v1/delivery/stores", {
      userToken: token,
    });
    const stores = (json?.stores ?? []) as any[];
    return stores.map((s) => ({
      storeId: s.id ?? s.store_id ?? s.uuid,
      name: s.name ?? "",
      address: s.location
        ? [
            s.location.street_address_line_one,
            s.location.city,
            s.location.postal_code,
          ]
            .filter(Boolean)
            .join(", ")
        : null,
      raw: s,
    }));
  }

  /**
   * Link the merchant's chosen store to this brand+location. The merchant's
   * OAuth approval already granted us access to their stores, so connecting
   * is just recording which store id maps to this connection — there's no
   * pos_data / integrator-id step. We verify the id is one the token can see.
   */
  async linkStore(
    tenantId: string,
    dto: { brandId: string; locationId: string; storeId: string },
  ) {
    const row = await this.pendingOrConnected(
      tenantId,
      dto.brandId,
      dto.locationId,
    );
    const storeId = dto.storeId.trim();
    if (!storeId) throw new BadRequestException("Choose a store to connect.");

    // Guard: the store must be one the merchant authorised us for.
    const stores = await this.fetchMerchantStores(row);
    const match = stores.find((s) => s.storeId === storeId);
    if (!match) {
      throw new BadRequestException(
        "That store isn't in the authorised Uber Eats account. Reconnect and pick a listed store.",
      );
    }

    const updated = await this.prisma.brandPlatformConnection.update({
      where: { id: row.id },
      data: {
        externalStoreId: storeId,
        status: "connected",
        lastError: null,
        lastSyncAt: new Date(),
      },
    });
    // Activate the POS integration so our CLIENT-CREDENTIALS token can operate
    // the store (status/prep/menu/orders). Without this, those calls 401 with
    // "User not allowed to access the store" — the store is the merchant's,
    // not our client's, until the integration is enabled. integrator_store_id
    // is OUR own id (the connection id), NOT anything the operator types.
    await this.activateIntegration(row.id, storeId, dto.brandId).catch(() => {});
    this.logger.log(
      `Uber Eats store ${storeId} (${match.name}) linked to conn ${row.id}`,
    );
    this.activity?.record({
      tenantId,
      brandId: dto.brandId,
      locationId: dto.locationId,
      category: "CONNECTION",
      channel: "UBER_EATS",
      action: "store.connected",
      status: "SUCCESS",
      message: `Uber Eats store "${match.name}" connected`,
      details: { storeId },
    });
    return this.view(updated);
  }

  /**
   * POST the POS integration data with the merchant token so Uber links the
   * store to our client_id (enables client-credentials operations). Uses our
   * own ids — no operator input. Best-effort: logs on failure.
   */
  private async activateIntegration(
    connectionId: string,
    storeId: string,
    brandId: string,
  ): Promise<void> {
    const row = await this.prisma.brandPlatformConnection.findUnique({
      where: { id: connectionId },
    });
    if (!row) return;
    try {
      const token = await this.oauth.merchantToken(row);
      await this.client.request(
        "POST",
        `/v1/eats/stores/${encodeURIComponent(storeId)}/pos_data`,
        {
          userToken: token,
          body: {
            integrator_store_id: connectionId,
            integrator_brand_id: brandId,
            integration_enabled: true,
          },
        },
      );
      this.logger.log(
        `Uber Eats integration activated for store ${storeId} (conn ${connectionId})`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Uber Eats pos_data activation failed for store ${storeId}: ${err?.message}. Store ops may 401 until activation succeeds.`,
      );
    }
  }

  /**
   * Called straight after the OAuth callback: list the merchant's stores and,
   * if there's exactly one, connect it automatically so the operator is done
   * in a single click. More than one → return them for a picker.
   */
  async autoLinkAfterOauth(
    tenantId: string,
    brandId: string,
    locationId: string,
  ): Promise<{ connected: boolean; stores: Array<{ storeId: string; name: string; address: string | null }> }> {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: { tenantId, brandId, locationId, platform: "UBER_EATS" },
    });
    if (!row) return { connected: false, stores: [] };
    let stores: Array<{ storeId: string; name: string; address: string | null; raw: any }> = [];
    try {
      stores = await this.fetchMerchantStores(row);
    } catch (err: any) {
      this.logger.warn(`Uber Eats store list after OAuth failed: ${err?.message}`);
      return { connected: false, stores: [] };
    }
    if (stores.length === 1) {
      await this.prisma.brandPlatformConnection.update({
        where: { id: row.id },
        data: {
          externalStoreId: stores[0]!.storeId,
          status: "connected",
          lastError: null,
          lastSyncAt: new Date(),
        },
      });
      await this.activateIntegration(row.id, stores[0]!.storeId, brandId).catch(
        () => {},
      );
      this.logger.log(
        `Uber Eats auto-linked sole store ${stores[0]!.storeId} to conn ${row.id}`,
      );
      return {
        connected: true,
        stores: stores.map(({ storeId, name, address }) => ({ storeId, name, address })),
      };
    }
    return {
      connected: false,
      stores: stores.map(({ storeId, name, address }) => ({ storeId, name, address })),
    };
  }

  /** store.provisioned / store.deprovisioned webhook → flip connection. */
  async applyProvisioningEvent(
    uberStoreId: string,
    provisioned: boolean,
  ): Promise<string | null> {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: { platform: "UBER_EATS", externalStoreId: uberStoreId },
    });
    if (!row) {
      this.logger.warn(
        `Uber Eats ${provisioned ? "provisioned" : "deprovisioned"} webhook for unknown store ${uberStoreId}`,
      );
      return null;
    }
    await this.prisma.brandPlatformConnection.update({
      where: { id: row.id },
      data: {
        status: provisioned ? "connected" : "not_connected",
        lastWebhookAt: new Date(),
        ...(provisioned ? { lastError: null } : {}),
      },
    });
    this.logger.log(
      `Uber Eats connection ${row.id} → ${provisioned ? "connected" : "not_connected"} (store ${uberStoreId})`,
    );
    return row.id;
  }

  async disconnect(tenantId: string, connectionId: string) {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "UBER_EATS" },
    });
    if (!row) throw new NotFoundException("Uber Eats connection not found");
    // Just unlink our side — there's no pos_data to tear down. The merchant
    // can revoke the app's access from their Uber Eats account if they want
    // to fully sever it.
    await this.prisma.brandPlatformConnection.update({
      where: { id: connectionId },
      data: {
        status: "not_connected",
        externalStoreId: null,
        lastError: null,
        metadata: {},
      },
    });
    this.activity?.record({
      tenantId,
      brandId: row.brandId,
      locationId: row.locationId,
      category: "CONNECTION",
      channel: "UBER_EATS",
      action: "store.disconnected",
      status: "INFO",
      message: "Uber Eats store disconnected",
      details: { storeId: row.externalStoreId },
    });
    return { ok: true };
  }

  /** ONLINE/OFFLINE from Uber (client-credentials). */
  async storeStatus(tenantId: string, connectionId: string) {
    const c = await this.connected(tenantId, connectionId);
    const json = await this.client.request<{
      status?: string;
      is_offline_until?: string;
      offline_reason?: string;
    }>("GET", `/v1/delivery/store/${c.externalStoreId}/status`, {
      scopes: STATUS_SCOPES,
    });
    return {
      status: String(json?.status ?? "UNKNOWN").toUpperCase(),
      offlineUntil: json?.is_offline_until ?? null,
      offlineReason: json?.offline_reason ?? null,
    };
  }

  /**
   * Pause (OFFLINE) / resume (ONLINE) the store on Uber Eats.
   *
   * Live-verified: OFFLINE requires `is_offline_until` (RFC3339) — omitting
   * it 400s with field_violations. Use the pause's real end time when the
   * operator set one; an open-ended pause sends +24h and the resume call
   * simply flips the store back ONLINE earlier.
   */
  async setStoreOnline(
    tenantId: string,
    connectionId: string,
    online: boolean,
    reason?: string,
    offlineUntil?: Date | null,
  ) {
    const c = await this.connected(tenantId, connectionId);
    const until =
      offlineUntil && offlineUntil.getTime() > Date.now()
        ? offlineUntil
        : new Date(Date.now() + 24 * 60 * 60 * 1000);
    // Out-param filled by the client with Uber's HTTP status — the Logs page
    // shows the acknowledgment ("Uber responded 200 OK") per certification.
    const meta: { status?: number } = {};
    await this.withStoreAccess(c, () =>
      this.client.request(
        "POST",
        `/v1/delivery/store/${c.externalStoreId}/update-store-status`,
        {
          scopes: STATUS_SCOPES,
          meta,
          body: {
            status: online ? "ONLINE" : "OFFLINE",
            ...(online
              ? {}
              : {
                  is_offline_until: until.toISOString(),
                  reason: reason ?? "PAUSED_BY_RESTAURANT",
                }),
          },
        },
      ),
    );
    await this.prisma.brandPlatformConnection.update({
      where: { id: connectionId },
      data: { status: online ? "connected" : "suspended" },
    });
    this.activity?.record({
      tenantId,
      brandId: c.brandId,
      locationId: c.locationId,
      category: "STATUS",
      channel: "UBER_EATS",
      action: online ? "store.resume" : "store.pause",
      status: "SUCCESS",
      message: `Uber Eats store set ${online ? "ONLINE" : `OFFLINE until ${until.toISOString()}`} — Uber responded ${meta.status ?? 200} OK`,
      details: { storeId: c.externalStoreId, uberHttpStatus: meta.status ?? 200 },
    });
    return { status: online ? "ONLINE" : "OFFLINE" };
  }

  /**
   * Run a store operation; if Uber rejects it with "User not allowed to
   * access the store" (the integration wasn't activated — e.g. a store
   * connected before pos_data was wired), activate it once and retry.
   */
  private async withStoreAccess<T>(
    conn: { id: string; brandId: string; externalStoreId: string | null },
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      // A missing-scope 401 is NOT an access/provisioning problem — re-running
      // pos_data won't fix it. Surface it plainly so the operator knows to
      // enable the scope in the Uber developer dashboard.
      if (msg.includes("following scopes")) {
        const scope = msg.match(/scopes:\s*([a-z0-9_.]+)/i)?.[1];
        throw new BadRequestException(
          `Uber Eats rejected this action: the app is missing the "${scope ?? "required"}" scope. ` +
            `Enable it on the app in the Uber developer dashboard (Scopes), then retry.`,
        );
      }
      // "User not allowed to access the store" DOES mean the POS integration
      // isn't activated for our client — activate once and retry.
      if (
        conn.externalStoreId &&
        msg.includes("not allowed to access the store")
      ) {
        this.logger.warn(
          `Uber Eats store ${conn.externalStoreId} not accessible — activating integration and retrying`,
        );
        await this.activateIntegration(
          conn.id,
          conn.externalStoreId,
          conn.brandId,
        );
        return await fn();
      }
      throw err;
    }
  }

  /** Push the location's default prep time (seconds, max 10800). */
  async publishPrepTime(tenantId: string, connectionId: string) {
    const c = await this.connected(tenantId, connectionId);
    const loc = await this.prisma.location.findUnique({
      where: { id: c.locationId },
      select: { prepTime: true, brand: { select: { prepTime: true } } },
    });
    const minutes =
      (loc?.prepTime ?? null) ?? (loc?.brand?.prepTime ?? null) ?? 15;
    const seconds = Math.min(minutes * 60, 10_800);
    await this.client.request(
      "POST",
      `/v1/delivery/store/${c.externalStoreId}/update-store-prep-time`,
      { scopes: STORE_SCOPES, body: { default_prep_time: seconds } },
    );
    return { ok: true, defaultPrepTimeSeconds: seconds };
  }

  // ── Store API suite (certification checklist) ───────────────────────────

  /** Get Stores — every store this app's token is authorised against. */
  async listAppStores(pageToken?: string) {
    const qs = pageToken
      ? `?next_page_token=${encodeURIComponent(pageToken)}`
      : "";
    const json = await this.client.request<any>(
      "GET",
      `/v1/delivery/stores${qs}`,
      { scopes: STORE_SCOPES },
    );
    return json ?? { stores: [] };
  }

  /** Get Store Details — full store record incl. orderability + config. */
  async storeDetails(tenantId: string, connectionId: string) {
    const c = await this.connected(tenantId, connectionId);
    return (
      (await this.client.request<any>(
        "GET",
        `/v1/delivery/store/${c.externalStoreId}`,
        { scopes: STORE_SCOPES },
      )) ?? null
    );
  }

  /** Update Store Information — contact / location / pickup instructions. */
  async updateStoreInfo(
    tenantId: string,
    connectionId: string,
    dto: {
      contact?: { email?: string; name?: string; phone_number?: string };
      location?: Record<string, string>;
      pickupInstructions?: string;
    },
  ) {
    const c = await this.connected(tenantId, connectionId);
    const body: Record<string, unknown> = {
      ...(dto.contact ? { contact: dto.contact } : {}),
      ...(dto.location ? { location: dto.location } : {}),
      ...(dto.pickupInstructions !== undefined
        ? { pickup_instructions: dto.pickupInstructions }
        : {}),
    };
    if (Object.keys(body).length === 0) {
      throw new BadRequestException("Nothing to update.");
    }
    await this.client.request(
      "POST",
      `/v1/delivery/store/${c.externalStoreId}`,
      { scopes: STORE_SCOPES, body },
    );
    return { ok: true };
  }

  /** Update Fulfillment Configuration (BYOC min-ETD override). */
  async updateFulfillmentConfig(
    tenantId: string,
    connectionId: string,
    dto: { customMinEtdMinutes: number },
  ) {
    if (!Number.isFinite(Number(dto.customMinEtdMinutes))) {
      throw new BadRequestException("customMinEtdMinutes is required");
    }
    const c = await this.connected(tenantId, connectionId);
    await this.client.request(
      "POST",
      `/v1/delivery/store/${c.externalStoreId}/update-fulfillment-configuration`,
      {
        scopes: ["eats.byoc.fulfillment.config"],
        body: {
          override_config: {
            custom_min_etd_minutes: Number(dto.customMinEtdMinutes),
          },
        },
      },
    );
    return { ok: true };
  }

  /** Active orders on Uber's side (recovery/reconciliation + verification). */
  async listStoreOrders(tenantId: string, connectionId: string) {
    const c = await this.connected(tenantId, connectionId);
    const json = await this.client.request<any>(
      "GET",
      `/v1/delivery/store/${c.externalStoreId}/orders`,
      { scopes: ["eats.order"] },
    );
    return json ?? { orders: [] };
  }

  /** Connection row for the dashboard card. */
  async get(tenantId: string, brandId: string, locationId: string) {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        tenantId,
        brandId,
        locationId,
        platform: "UBER_EATS",
      },
    });
    return row ? this.view(row) : { status: "not_connected" };
  }

  private async pendingOrConnected(
    tenantId: string,
    brandId: string,
    locationId: string,
  ) {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: { tenantId, brandId, locationId, platform: "UBER_EATS" },
    });
    if (!row) {
      throw new BadRequestException(
        "Uber Eats isn't authorised for this brand yet — run Connect Uber Eats first.",
      );
    }
    return row;
  }

  private async connected(tenantId: string, connectionId: string) {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "UBER_EATS" },
    });
    if (!row?.externalStoreId) {
      throw new BadRequestException(
        "Uber Eats isn't connected for this brand.",
      );
    }
    return row;
  }

  private view(row: any) {
    return {
      id: row.id,
      status: row.status,
      storeId: row.externalStoreId ?? null,
    };
  }
}
